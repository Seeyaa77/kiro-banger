const axios = require('axios');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const timing = require('../utils/timing');

const BASE_URL = 'https://tempik.neroism.web.id/api';
const WS_BASE_URL = 'wss://tempik.neroism.web.id/api/ws/inbox';
const RATE_LIMIT_RETRY_ATTEMPTS = 4;
const RATE_LIMIT_BASE_DELAY_MS = 5000;

/** Thrown when an inbox returns 410 — account is dead/expired. */
class InboxDeadError extends Error {
  constructor(email) {
    super(`Inbox ${email} is dead (HTTP 410) — account expired or removed`);
    this.name = 'InboxDeadError';
    this.email = email;
    this.status = 410;
  }
}

// ── Per-account WebSocket connection ──────────────────────────────

class InboxWebSocket extends EventEmitter {
  constructor(apiKey, account) {
    super();
    this.apiKey = apiKey;
    this.account = account;
    this.ws = null;
    this._connectPromise = null;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._heartbeatTimeout = null;
    this._shouldReconnect = true;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
  }

  /** Open (or reuse) a connection.  Resolves on 'connected' event. */
  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._shouldReconnect = true;
    this._connectPromise = this._open();
    return this._connectPromise;
  }

  async _open() {
    const url = `${WS_BASE_URL}?key=${encodeURIComponent(this.apiKey)}&account=${encodeURIComponent(this.account)}`;
    this.ws = new WebSocket(url);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws?.terminate();
        reject(new Error('WebSocket connection timeout (15s)'));
      }, 15000);

      this.ws.on('open', () => {
        this._startHeartbeatWatchdog();
      });

      this.ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          this._resetHeartbeatWatchdog();

          switch (data.type) {
            case 'connected':
              clearTimeout(timer);
              this._reconnectAttempts = 0;
              this.emit('connected', data);
              resolve(data);
              break;

            case 'new_email':
              this.emit('new_email', data);
              break;

            case 'email_updated':
              this.emit('email_updated', data);
              break;

            case 'heartbeat':
              // watchdog already reset above
              break;

            case 'session_expired':
              this.emit('session_expired', data);
              this._handleDisconnect(false);
              break;

            case 'rate_limited':
              this.emit('rate_limited', data);
              break;

            case 'disconnected':
              this.emit('disconnected', data);
              this._handleDisconnect(false);
              break;

            case 'error':
              this.emit('error', data);
              if (!this._reconnectAttempts) {
                clearTimeout(timer);
                reject(new Error(`WebSocket error: ${data.message || 'unknown'}`));
              }
              break;
          }
        } catch (err) {
          this.emit('error', { message: `Parse error: ${err.message}` });
        }
      });

      this.ws.on('error', (err) => {
        this.emit('ws_error', err);
        clearTimeout(timer);
        if (this._connectPromise) {
          reject(err);
          this._connectPromise = null;
        }
      });

      this.ws.on('close', (code, reason) => {
        this.emit('close', { code, reason: reason?.toString() });
        clearTimeout(timer);
        if (this._shouldReconnect && this.listenerCount('new_email') > 0) {
          this._scheduleReconnect();
        }
        this._connectPromise = null;
      });
    });
  }

  /** Reconnect with exponential backoff. */
  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.emit('error', { message: `Max reconnect attempts (${this._maxReconnectAttempts}) reached` });
      return;
    }
    this._reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 15000);
    console.log(`   🔄 WebSocket reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})...`);

    this._reconnectTimer = setTimeout(async () => {
      this._connectPromise = null;
      try {
        await this._open();
        this.emit('reconnected', {});
      } catch (err) {
        this.emit('error', { message: `Reconnect failed: ${err.message}` });
      }
    }, delay);
  }

  _startHeartbeatWatchdog() {
    this._resetHeartbeatWatchdog();
  }

  _resetHeartbeatWatchdog() {
    if (this._heartbeatTimeout) clearTimeout(this._heartbeatTimeout);
    this._heartbeatTimeout = setTimeout(() => {
      console.log('   ⚠️  WebSocket heartbeat timeout — reconnecting...');
      this.ws?.terminate();
    }, 60000); // 60s without any message → assume stale
  }

  _handleDisconnect(shouldReconnect = false) {
    this._shouldReconnect = shouldReconnect;
    if (this._heartbeatTimeout) clearTimeout(this._heartbeatTimeout);
    this.ws?.close();
    this._connectPromise = null;
  }

  disconnect() {
    this._shouldReconnect = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._heartbeatTimeout) clearTimeout(this._heartbeatTimeout);
    this._connectPromise = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.removeAllListeners();
  }
}

// ── Main client ───────────────────────────────────────────────────

class MailstackClient {
  constructor(apiKey) {
    this.apiKey = apiKey;

    this.client = axios.create({
      baseURL: BASE_URL,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    this.client.interceptors.response.use(
      response => response,
      async error => {
        const status = error.response?.status;
        const config = error.config || {};

        // 410 Gone — inbox/account is dead, no retry
        if (status === 410) {
          const url = config.url || '';
          const emailMatch = url.match(/\/inboxes\/([^/]+)/);
          const email = emailMatch ? decodeURIComponent(emailMatch[1]) : 'unknown';
          throw new InboxDeadError(email);
        }

        if (status !== 429) {
          throw error;
        }

        config.__rateLimitRetryCount = config.__rateLimitRetryCount || 0;
        if (config.__rateLimitRetryCount >= RATE_LIMIT_RETRY_ATTEMPTS) {
          throw error;
        }

        config.__rateLimitRetryCount++;
        const retryAfterMs = this.getRetryAfterMs(error.response?.headers?.['retry-after']);
        const backoffMs = RATE_LIMIT_BASE_DELAY_MS * config.__rateLimitRetryCount;
        const jitterMs = Math.floor(Math.random() * 1000);
        const delayMs = (retryAfterMs || backoffMs) + jitterMs;

        console.log(`   ⏳ Inbox API rate limited; waiting ${Math.ceil(delayMs / 1000)}s before retry...`);
        await this.sleep(delayMs);
        return this.client(config);
      }
    );

    /** @type {Map<string, InboxWebSocket>} */
    this._connections = new Map();
  }

  // ── REST helpers (unchanged) ────────────────────────────────────

  getRetryAfterMs(retryAfter) {
    if (!retryAfter) return null;

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }

    const retryDate = new Date(retryAfter).getTime();
    if (Number.isFinite(retryDate)) {
      return Math.max(0, retryDate - Date.now());
    }

    return null;
  }

  async getInboxes() {
    const { data } = await this.client.get('/inboxes');
    // Tempik API returns array directly with 'address' field
    const inboxes = Array.isArray(data) ? data : (data.inboxes || data.accounts || []);
    // Map 'address' to 'email' for compatibility
    return inboxes.map(inbox => ({
      ...inbox,
      email: inbox.address || inbox.email,
      status: 'active' // Tempik doesn't provide status, assume all active
    }));
  }

  async createInbox(domain = 'xyntaur.com') {
    const { data } = await this.client.post('/inboxes', { domain });
    console.log(`   ✨ Created new inbox: ${data.address}`);
    return {
      ...data,
      email: data.address,
      status: 'active',
      message_count: 0
    };
  }

  async getMessages(email, limit = 50) {
    const { data } = await this.client.get(`/inboxes/${encodeURIComponent(email)}/messages`, {
      params: { limit }
    });
    // Tempik API returns array directly, map fields for compatibility
    const messages = Array.isArray(data) ? data : (data.messages || []);
    return messages.map(msg => ({
      ...msg,
      from: msg.from_address || msg.from,
      date: msg.received_at || msg.date,
      unread: true // Tempik doesn't track read status, assume all unread
    }));
  }

  async refreshInbox(email) {
    // Tempik API might not have refresh endpoint, try it but don't fail
    try {
      await this.client.post(`/inboxes/${encodeURIComponent(email)}/refresh`);
    } catch (error) {
      // Silently ignore 404 - refresh not supported
      if (error.response?.status !== 404) {
        throw error;
      }
    }
  }

  async getMessage(email, messageId) {
    try {
      const { data } = await this.client.get(`/inboxes/${encodeURIComponent(email)}/messages/${messageId}`);
      // Map fields for compatibility
      const msg = data.message || data;
      return {
        ...msg,
        from: msg.from_address || msg.from,
        date: msg.received_at || msg.date,
        html: msg.body || msg.html, // Tempik stores HTML in 'body'
        content: msg.body || msg.content
      };
    } catch (error) {
      // If 404, fallback to fetching all messages and finding the one we need
      if (error.response?.status === 404) {
        const messages = await this.getMessages(email, 50);
        const msg = messages.find(m => m.id === messageId);
        if (msg) {
          return {
            ...msg,
            html: msg.body || msg.html,
            content: msg.body || msg.content
          };
        }
      }
      throw error;
    }
  }

  async markAsRead(email, messageId) {
    // Tempik API might not support mark as read, try but don't fail
    try {
      await this.client.put(`/inboxes/${encodeURIComponent(email)}/messages/${messageId}/read`);
    } catch (error) {
      // Silently ignore 404 - mark as read not supported
      if (error.response?.status !== 404) {
        console.log(`   ⚠️  Could not mark message as read: ${error.message}`);
      }
    }
  }

  async deleteMessage(email, messageId) {
    try {
      await this.client.delete(`/inboxes/${encodeURIComponent(email)}/messages/${messageId}`);
    } catch (error) {
      // Silently ignore 404 - delete not supported
      if (error.response?.status !== 404) {
        console.log(`   ⚠️  Could not delete message: ${error.message}`);
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Clean inbox selection (unchanged) ───────────────────────────

  async selectCleanInbox() {
    // Always create a new inbox with @xyntaur.com domain
    console.log(`   🎲 Generating new inbox with @xyntaur.com domain...`);
    const newInbox = await this.createInbox('xyntaur.com');
    console.log(`   ✅ ${newInbox.email} — fresh inbox ready`);
    return newInbox;
  }

  // ── WebSocket connection management ─────────────────────────────

  /**
   * Get (or create) a WebSocket connection for an account.
   * @param {string} email
   * @returns {Promise<InboxWebSocket>}
   */
  async _getWs(email) {
    let conn = this._connections.get(email);
    if (conn && conn.ws?.readyState === WebSocket.OPEN) {
      return conn;
    }

    // Tear down stale connection
    if (conn) {
      conn.disconnect();
      this._connections.delete(email);
    }

    conn = new InboxWebSocket(this.apiKey, email);
    this._connections.set(email, conn);
    await conn.connect();
    return conn;
  }

  /**
   * Tear down the WebSocket for an account.
   */
  disconnectWs(email) {
    const conn = this._connections.get(email);
    if (conn) {
      conn.disconnect();
      this._connections.delete(email);
    }
  }

  /**
   * Tear down every open WebSocket.
   */
  disconnectAll() {
    for (const [email, conn] of this._connections) {
      conn.disconnect();
    }
    this._connections.clear();
  }

  // ── WebSocket-based wait methods ────────────────────────────────

  /**
   * Wait for a verification code email via WebSocket.
   *
   * 1. Checks existing unread messages first (REST).
   * 2. Opens a WebSocket and resolves instantly on `new_email` events.
   *
   * @param {string} email
   * @param {string} subjectMatch - substring to match in the subject
   * @param {number} timeoutMs - max wait (default 120s)
   * @param {number} _wsConnectTimeoutMs - max time to wait for WS handshake (default 15s)
   */
  async waitForVerificationCode(email, subjectMatch, timeoutMs = 120000, _wsConnectTimeoutMs = 15000) {
    return this._pollForVerificationCode(email, subjectMatch, timeoutMs);
    /* Legacy WebSocket implementation retained below for reference. */
    // ── Fast path: already sitting in inbox ──
    try {
      const messages = await this.getMessages(email, 10);
      const existing = messages.find(msg =>
        msg.subject?.toLowerCase().includes(subjectMatch.toLowerCase()) && msg.unread
      );
      if (existing) {
        const full = await this.getMessage(email, existing.id);
        const code = this.extractCode(full);
        if (code) {
          await this.markAsRead(email, existing.id);
          return code;
        }
      }
    } catch (error) {
      if (error instanceof InboxDeadError) {
        throw error; // Re-throw 410 immediately — account is dead
      }
      /* fall through to WebSocket */ }

    // ── WebSocket path ──
    console.log(`   📬 Opening WebSocket for verification email (timeout: ${timeoutMs / 1000}s)...`);

    let conn;
    try {
      conn = await this._getWs(email);
    } catch (err) {
      console.log(`   ⚠️  WebSocket failed: ${err.message}`);
      console.log(`   🔄 Falling back to polling...`);
      return this._pollForVerificationCode(email, subjectMatch, timeoutMs);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, val) => { if (!settled) { settled = true; cleanup(); fn(val); } };

      const onNewEmail = async (data) => {
        if (settled) return;
        try {
          const em = data.email || {};
          if (!em.subject?.toLowerCase().includes(subjectMatch.toLowerCase())) return;

          console.log(`   📨 WebSocket: new verification email — "${em.subject}"`);
          const full = await this.getMessage(email, em.id);
          const code = this.extractCode(full);
          if (code) {
            await this.markAsRead(email, em.id);
            finish(resolve, code);
          }
        } catch (err) {
          console.log('   ⚠️  Error processing WS email event:', err.message);
        }
      };

      const onError = (data) => {
        if (settled) return;
        if (data?.message?.includes('Max reconnect')) {
          finish(reject, new Error('WebSocket disconnected — max reconnect attempts reached'));
        }
      };

      const onDisconnect = () => {
        if (settled) return;
        finish(reject, new Error('WebSocket disconnected while waiting for verification email'));
      };

      const timeout = setTimeout(() => {
        finish(reject, new Error(`Verification email not received within ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        conn.removeListener('new_email', onNewEmail);
        conn.removeListener('error', onError);
        conn.removeListener('disconnected', onDisconnect);
        conn.removeListener('session_expired', onDisconnect);
        if (conn.listenerCount('new_email') === 0) this.disconnectWs(email);
      };

      conn.on('new_email', onNewEmail);
      conn.on('error', onError);
      conn.on('disconnected', onDisconnect);
      conn.on('session_expired', onDisconnect);
    });
  }

  /**
   * Wait for an MFA/OTP code email via WebSocket.
   *
   * @param {string} email
   * @param {number} timeoutMs - max wait (default 120s)
   * @param {number} _unused - kept for backward compat (was pollIntervalMs)
   * @param {string|null} afterTimestamp - only consider emails after this ISO timestamp
   */
  async waitForMfaCode(email, timeoutMs = 120000, _unused = 3000, afterTimestamp = null) {
    return this._pollForMfaCode(email, timeoutMs, _unused, afterTimestamp);
    /* Legacy WebSocket implementation retained below for reference. */
    // ── Fast path ──
    try {
      const messages = await this.getMessages(email, 10);
      for (const msg of messages) {
        if (!msg.unread) continue;
        if (afterTimestamp && msg.date && new Date(msg.date) < new Date(afterTimestamp)) continue;

        if (this._isMfaEmail(msg)) {
          const full = await this.getMessage(email, msg.id);
          const code = this.extractMfaCode(full);
          if (code) {
            await this.markAsRead(email, msg.id);
            console.log(`   ✅ MFA code extracted (cached): ${code}`);
            return code;
          }
        }
      }
    } catch (error) {
      if (error instanceof InboxDeadError) {
        throw error; // Re-throw 410 immediately — account is dead
      }
      /* fall through */ }

    // ── WebSocket path ──
    console.log(`   📬 Opening WebSocket for MFA code (timeout: ${timeoutMs / 1000}s)...`);

    let conn;
    try {
      conn = await this._getWs(email);
    } catch (err) {
      throw new Error(`WebSocket connection failed: ${err.message}`);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, val) => { if (!settled) { settled = true; cleanup(); fn(val); } };

      const onNewEmail = async (data) => {
        if (settled) return;
        try {
          const em = data.email || {};
          if (afterTimestamp && em.date && new Date(em.date) < new Date(afterTimestamp)) return;
          if (!this._isMfaEmail(em)) return;

          console.log(`   📨 WebSocket: MFA email arrived — "${em.subject}"`);
          const full = await this.getMessage(email, em.id);
          const code = this.extractMfaCode(full);
          if (code) {
            await this.markAsRead(email, em.id);
            console.log(`   ✅ MFA code extracted: ${code}`);
            finish(resolve, code);
          }
        } catch (err) {
          console.log('   ⚠️  Error processing WS MFA event:', err.message);
        }
      };

      const onError = (data) => {
        if (settled) return;
        if (data?.message?.includes('Max reconnect')) {
          finish(reject, new Error('WebSocket disconnected — max reconnect attempts reached'));
        }
      };

      const onDisconnect = () => {
        if (settled) return;
        finish(reject, new Error('WebSocket disconnected while waiting for MFA code'));
      };

      const timeout = setTimeout(() => {
        finish(reject, new Error(`MFA code email not received within ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        conn.removeListener('new_email', onNewEmail);
        conn.removeListener('error', onError);
        conn.removeListener('disconnected', onDisconnect);
        conn.removeListener('session_expired', onDisconnect);
        if (conn.listenerCount('new_email') === 0) this.disconnectWs(email);
      };

      conn.on('new_email', onNewEmail);
      conn.on('error', onError);
      conn.on('disconnected', onDisconnect);
      conn.on('session_expired', onDisconnect);
    });
  }

  async _pollForVerificationCode(email, subjectMatch, timeoutMs, pollIntervalMs = null) {
    // Poll faster under the speed profile — this loop is dead time spent waiting
    // for the verification email, so tightening it shortens every registration.
    if (pollIntervalMs === null) pollIntervalMs = timing.scale(3000, 400);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.refreshInbox(email).catch(() => {});
      const messages = await this.getMessages(email, 10);
      const candidate = messages.find(msg => msg.unread && msg.subject?.toLowerCase().includes(subjectMatch.toLowerCase()));
      if (candidate) {
        const code = this.extractCode(await this.getMessage(email, candidate.id));
        if (code) { await this.markAsRead(email, candidate.id); return code; }
      }
      await this.sleep(Math.min(pollIntervalMs, Math.max(250, deadline - Date.now())));
    }
    throw new Error(`Verification email not received within ${timeoutMs}ms`);
  }

  async _pollForMfaCode(email, timeoutMs, pollIntervalMs = null, afterTimestamp = null) {
    if (pollIntervalMs === null) pollIntervalMs = timing.scale(3000, 400);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.refreshInbox(email).catch(() => {});
      const messages = await this.getMessages(email, 10);
      for (const msg of messages) {
        if (!msg.unread || (afterTimestamp && msg.date && new Date(msg.date) < new Date(afterTimestamp)) || !this._isMfaEmail(msg)) continue;
        const code = this.extractMfaCode(await this.getMessage(email, msg.id));
        if (code) { await this.markAsRead(email, msg.id); return code; }
      }
      await this.sleep(Math.min(pollIntervalMs, Math.max(250, deadline - Date.now())));
    }
    throw new Error(`MFA email not received within ${timeoutMs}ms`);
  }

  /** Check if a message looks like an MFA/OTP email. */
  _isMfaEmail(msg) {
    const subject = (msg.subject || '').toLowerCase();
    const from = (msg.from || '').toLowerCase();
    const fromName = (msg.from_name || '').toLowerCase();
    const allMeta = `${subject} ${from} ${fromName}`;

    return [
      'verification', 'verify', 'code', 'otp', 'mfa', 'one-time',
      'one time', 'security code', 'sign-in', 'sign in', 'login',
      'authentication', 'auth code', 'passcode'
    ].some(kw => allMeta.includes(kw));
  }

  // ── Code extractors (unchanged) ─────────────────────────────────

  extractCode(message) {
    const body = message.body || '';
    const html = message.html || '';
    const content = message.content || '';
    const textToSearch = `${body} ${html} ${content}`;

    const awsPatterns = [
      /class="code"[^>]*>(\d{4,8})</i,
      /Verification code:\s*(\d{4,8})/i,
      /verification.*?(\d{6})/is
    ];

    for (const pattern of awsPatterns) {
      const match = textToSearch.match(pattern);
      if (match && match[1]) {
        console.log(`   📧 Extracted code using AWS pattern: ${match[1]}`);
        return match[1];
      }
    }

    const genericPatterns = [
      /code[:\s]+(\d{4,8})/i,
      /pin[:\s]+(\d{4,8})/i,
      /otp[:\s]+(\d{4,8})/i
    ];

    for (const pattern of genericPatterns) {
      const match = textToSearch.match(pattern);
      if (match && match[1]) {
        console.log(`   📧 Extracted code using generic pattern: ${match[1]}`);
        return match[1];
      }
    }

    return null;
  }

  extractMfaCode(message) {
    const body = message.body || '';
    const html = message.html || '';
    const content = message.content || '';
    const textToSearch = `${body} ${html} ${content}`;

    const mfaPatterns = [
      /one[- ]time\s*(?:password|passcode|code)\s*(?:is\s*)?(\d{4,8})/i,
      /verification\s*code\s*(?:is\s*)?(\d{4,8})/i,
      /(?:your\s+)?code[:\s]+(\d{4,8})/i,
      /(?:otp|passcode|pin|mfa)[:\s]+(\d{4,8})/i,
      /security\s*code[:\s]+(\d{4,8})/i,
      /sign[- ]?in\s*code[:\s]+(\d{4,8})/i,
      /class="code"[^>]*>(\d{4,8})</i,
      />(\d{6})</,
      /\b(\d{6})\b/
    ];

    for (const pattern of mfaPatterns) {
      const match = textToSearch.match(pattern);
      if (match && match[1]) {
        console.log(`   🔢 MFA code extracted: ${match[1]}`);
        return match[1];
      }
    }

    console.log('   ⚠️  Could not extract MFA code from email');
    return null;
  }
}

module.exports = MailstackClient;
module.exports.InboxDeadError = InboxDeadError;
