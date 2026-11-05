/**
 * Verifies detectAwsErrorPage()/assertNoAwsError() against replicas of the
 * real AWS error interstitials, and confirms a normal form page is NOT flagged.
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Minimal stand-ins for the flow under test.
function makeFlow(page) {
  const { SignupFlow } = require('./core/signupFlow');
  const flow = Object.create(SignupFlow.prototype);
  flow.agent = { page };
  return flow;
}

// The exact text from the reported ERR-837 signup failure.
const ERR_837_HTML = `<!DOCTYPE html><html><body>
<h1>Error</h1>
<p>ERR-837 - Sorry, there was an error processing your request. Please try again.</p>
<p>Request ID: ddc2d923-4781-4926-9209-e1644abd4ae8</p>
<p>Type: Signup</p>
<p>Time: Thu, 05 Nov 2026 10:39:46 GMT</p>
</body></html>`;

const ERR_837_ACCOUNT_HTML = `<!DOCTYPE html><html><body>
<p>ERR-837 - Account issue</p>
<p>There is an issue with your Builder ID account. Please contact AWS Support for assistance.</p>
</body></html>`;

const NORMAL_FORM_HTML = `<!DOCTYPE html><html><body>
<h1>Create your AWS Builder ID</h1>
<form><input id="formField14" type="email" placeholder="Email"><button>Continue</button></form>
<p>Please try again later if you have trouble.</p>
</body></html>`;

const OTP_PAGE_HTML = `<!DOCTYPE html><html><body>
<h1>Verify your email address</h1>
<p>We emailed you a verification code.</p>
<input id="formField38" type="number" placeholder="Verification code">
</body></html>`;

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  let pass = 0, fail = 0;
  const check = (name, cond) => { console.log(`   ${cond ? '✅' : '❌'} ${name}`); cond ? pass++ : fail++; };

  const flow = makeFlow(page);

  // 1. The reported ERR-837 page is detected with all fields
  await page.setContent(ERR_837_HTML, { waitUntil: 'domcontentloaded' });
  const e1 = await flow.detectAwsErrorPage();
  check('ERR-837 detected', e1 !== null && e1.code === 'ERR-837');
  check('ERR-837 Type captured', e1?.type === 'Signup');
  check('ERR-837 Request ID captured', e1?.requestId === 'ddc2d923-4781-4926-9209-e1644abd4ae8');
  check('ERR-837 marked retryable', e1?.retryable === true);

  // 2. assertNoAwsError throws with the code in the message
  let thrown = null;
  try { await flow.assertNoAwsError('name'); } catch (e) { thrown = e; }
  check('assertNoAwsError throws on ERR-837', thrown !== null);
  check('thrown message names the step and code',
    thrown?.message.includes('ERR-837') && thrown?.message.includes('name'));
  check('thrown error carries retryable', thrown?.retryable === true);
  check('thrown error carries awsError', thrown?.awsError?.code === 'ERR-837');

  // 3. Account-issue variant is caught too
  await page.setContent(ERR_837_ACCOUNT_HTML, { waitUntil: 'domcontentloaded' });
  const e2 = await flow.detectAwsErrorPage();
  check('ERR-837 account-issue detected', e2?.code === 'ERR-837');

  // 4. A NORMAL form page must NOT be flagged (no false positives)
  await page.setContent(NORMAL_FORM_HTML, { waitUntil: 'domcontentloaded' });
  const e3 = await flow.detectAwsErrorPage();
  check('normal form not flagged', e3 === null);
  let noThrow = true;
  try { await flow.assertNoAwsError('email'); } catch (e) { noThrow = false; }
  check('assertNoAwsError passes on normal form', noThrow);

  // 5. The OTP page must NOT be flagged either
  await page.setContent(OTP_PAGE_HTML, { waitUntil: 'domcontentloaded' });
  const e4 = await flow.detectAwsErrorPage();
  check('OTP page not flagged', e4 === null);

  await browser.close();
  console.log(`\n   ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('Harness error:', e.message); process.exit(1); });
