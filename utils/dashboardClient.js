/**
 * Shared 9router dashboard HTTP helpers.
 *
 * The dashboard locks the API for 120s after 4 failed password attempts and
 * answers 429 with a `retryAfter` (seconds) hint. Burst registration loops hit
 * this constantly, so every call goes through these helpers to classify the
 * failure correctly and back off instead of burning the whole lockout window.
 */

const axios = require('axios');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 3000;
const MAX_BACKOFF_MS = 180000;

/** Thrown when the dashboard password in .env is wrong (not a transient 429). */
class DashboardAuthError extends Error {
  constructor(message, remainingBeforeLock) {
    super(message);
    this.name = 'DashboardAuthError';
    this.remainingBeforeLock = remainingBeforeLock;
  }
}

/** Thrown when the dashboard refuses because of a lockout / rate limit. */
class DashboardRateLimitError extends Error {
  constructor(message, retryAfterSeconds) {
    super(message);
    this.name = 'DashboardRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Pull the lockout duration out of a 429 body/header.
 * The dashboard returns `{ retryAfter: 82 }` and a `Retry-After: 120` header.
 */
function getRetryAfterMs(response) {
  const header = response?.headers?.['retry-after'];
  const parsedHeader = Number(header);
  if (Number.isFinite(parsedHeader) && parsedHeader > 0) {
    return parsedHeader * 1000;
  }

  const body = response?.data || {};
  const bodySeconds = Number(body.retryAfter ?? body.retry_after ?? body.retryAfterSeconds);
  if (Number.isFinite(bodySeconds) && bodySeconds > 0) {
    return bodySeconds * 1000;
  }

  return null;
}

/**
 * Describe a dashboard 401. Distinguishes a wrong password from a lockout so a
 * misconfigured .env is reported as such instead of as a generic failure.
 */
function describeAuthFailure(response) {
  const data = response?.data || {};
  if (typeof data.remainingBeforeLock === 'number') {
    return `Dashboard password rejected (${data.remainingBeforeLock} attempt(s) left before lockout). Check DASHBOARD_PASSWORD in .env.`;
  }
  return `Dashboard authentication failed (HTTP ${response?.status}): ${data.error || 'unauthorized'}`;
}

/**
 * POST/GET helper with explicit 401/429 classification and retry.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {'get'|'post'} [options.method]
 * @param {object} [options.data]
 * @param {object} [options.headers]
 * @param {number} [options.maxRetries]
 * @param {(msg: string) => void} [options.log]
 */
async function dashboardRequest({
  url,
  method = 'get',
  data,
  headers = {},
  maxRetries = MAX_RETRIES,
  log = () => {}
}) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios({
        url,
        method,
        data,
        headers,
        timeout: DEFAULT_TIMEOUT_MS,
        validateStatus: () => true
      });

      if (response.status === 401) {
        // Wrong password — retrying only burns attempts and triggers a lockout.
        throw new DashboardAuthError(describeAuthFailure(response), response.data?.remainingBeforeLock);
      }

      if (response.status === 429) {
        const retryAfterMs = getRetryAfterMs(response);
        lastError = new DashboardRateLimitError(
          `Dashboard rate limited: ${response.data?.error || 'too many requests'}`,
          Math.ceil((retryAfterMs || BASE_BACKOFF_MS) / 1000)
        );

        if (attempt === maxRetries) throw lastError;

        const waitMs = Math.min(retryAfterMs || BASE_BACKOFF_MS * (attempt + 1), MAX_BACKOFF_MS);
        log(`   ⏳ Dashboard lockout — waiting ${Math.ceil(waitMs / 1000)}s before retry (${attempt + 1}/${maxRetries})...`);
        await sleep(waitMs);
        continue;
      }

      if (response.status >= 500) {
        lastError = new Error(`Dashboard error (HTTP ${response.status})`);
        if (attempt === maxRetries) throw lastError;
        const waitMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
        log(`   ⚠️  Dashboard ${response.status} — retrying in ${Math.ceil(waitMs / 1000)}s (${attempt + 1}/${maxRetries})...`);
        await sleep(waitMs);
        continue;
      }

      return response;
    } catch (error) {
      // Never retry a misconfigured password or an exhausted lockout.
      if (error instanceof DashboardAuthError || error instanceof DashboardRateLimitError) throw error;

      lastError = error;
      if (attempt === maxRetries) throw error;
      const waitMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      log(`   ⚠️  Dashboard request failed (${error.message}) — retrying in ${Math.ceil(waitMs / 1000)}s (${attempt + 1}/${maxRetries})...`);
      await sleep(waitMs);
    }
  }

  throw lastError || new Error('Dashboard request failed');
}

/**
 * Log into the dashboard and return the session cookie header.
 */
async function loginToDashboard(dashboardUrl, password, log = () => {}) {
  const response = await dashboardRequest({
    url: `${dashboardUrl}/api/auth/login`,
    method: 'post',
    data: { password },
    headers: { 'Content-Type': 'application/json' },
    log
  });

  if (response.status !== 200) {
    throw new DashboardAuthError(
      `Dashboard login failed (HTTP ${response.status}): ${response.data?.error || 'unexpected response'}`,
      response.data?.remainingBeforeLock
    );
  }

  if (response.data && response.data.success === false) {
    throw new DashboardAuthError('Dashboard login failed — API returned success:false');
  }

  const setCookies = response.headers['set-cookie'];
  if (!setCookies || setCookies.length === 0) {
    throw new DashboardAuthError('Dashboard login failed — no session cookies received');
  }

  return setCookies.join('; ');
}

module.exports = {
  dashboardRequest,
  loginToDashboard,
  DashboardAuthError,
  DashboardRateLimitError,
  getRetryAfterMs,
  sleep,
  MAX_BACKOFF_MS
};
