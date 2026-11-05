require('dotenv').config();
const { loginToDashboard, DashboardAuthError, DashboardRateLimitError } = require('./utils/dashboardClient');

async function test() {
  const url = process.env.DASHBOARD_URL;
  const pw = process.env.DASHBOARD_PASSWORD;
  console.log(`Testing dashboard login at ${url}\n`);

  try {
    const cookie = await loginToDashboard(url, pw, (m) => console.log(m));
    console.log(`✅ Login OK — cookie length ${cookie.length}`);
  } catch (err) {
    if (err instanceof DashboardAuthError) {
      console.log(`🔐 AUTH ERROR (clear, not a mystery 429):`);
      console.log(`   ${err.message}`);
      console.log(`   remainingBeforeLock: ${err.remainingBeforeLock}`);
    } else if (err instanceof DashboardRateLimitError) {
      console.log(`⏳ RATE LIMIT (after exhausting retries):`);
      console.log(`   ${err.message} (retryAfter ${err.retryAfterSeconds}s)`);
    } else {
      console.log(`❌ Other: ${err.message}`);
    }
  }
}

test();
