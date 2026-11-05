/**
 * Verifies _findCodeField() against the real AWS OTP markup the user supplied,
 * plus look-alike pages that must NOT be picked, and confirms the code actually
 * lands in the field through typeIntoField().
 *
 * Real markup supplied by the user:
 *   <input aria-labelledby="formField41-1793875741628-5235-label"
 *          placeholder="6-digit" id="formField41-1793875741628-5235"
 *          class="awsui_input_2rhyz_1f9gh_9" autocomplete="on" type="text" value="">
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { SignupFlow } = require('./core/signupFlow');
const { HumanInput } = require('./utils/humanInput');

function makeFlow(page) {
  const flow = Object.create(SignupFlow.prototype);
  flow.agent = { page };
  return flow;
}

// Verbatim markup from the failing run.
const REAL_OTP_PAGE = `<!DOCTYPE html><html><body>
<h1>Check your email</h1>
<p>We sent a code to your address.</p>
<form>
  <div>
    <label id="formField41-1793875741628-5235-label">Enter your code</label>
    <input aria-labelledby="formField41-1793875741628-5235-label"
           placeholder="6-digit" id="formField41-1793875741628-5235"
           class="awsui_input_2rhyz_1f9gh_9" autocomplete="on" type="text" value="">
  </div>
  <button type="button">Continue</button>
</form>
</body></html>`;

// Older numbering seen in the original selector list (formField38) - must also work.
const OLD_NUMBERING_PAGE = `<!DOCTYPE html><html><body>
<form>
  <input id="formField38-1700000000000-9999" placeholder="6-digit" type="text">
  <button type="button">Continue</button>
</form>
</body></html>`;

// A page with a phone/number field that must NOT win over nothing sensible,
// and where the OTP box is the digit one.
const MIXED_FIELDS_PAGE = `<!DOCTYPE html><html><body>
<form>
  <input id="formField12-1-1" placeholder="Email address" type="email">
  <input id="formField17-2-2" placeholder="Full name" type="text">
  <input id="formField41-3-3" placeholder="6-digit" type="text" maxlength="6" inputmode="numeric">
  <button type="button">Continue</button>
</form>
</body></html>`;

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  let pass = 0, fail = 0;
  const check = (name, cond) => { console.log(`   ${cond ? '✅' : '❌'} ${name}`); cond ? pass++ : fail++; };

  const flow = makeFlow(page);
  const input = new HumanInput(page, {});

  // ── 1. The exact failing markup ─────────────────────────────────
  console.log('— real AWS markup (formField41, placeholder="6-digit") —');
  await page.setContent(REAL_OTP_PAGE, { waitUntil: 'domcontentloaded' });
  const sel1 = await flow._findCodeField(2000);
  check('resolves the OTP field', sel1 === '#formField41-1793875741628-5235');

  const ok1 = await input.typeIntoField(sel1, '187254', { label: 'code', log: () => {} });
  check('typeIntoField returns true', ok1 === true);
  check('field holds "187254"', (await input.readFieldValue(sel1)) === '187254');
  await input.requireFieldValue(sel1, '187254', 'code').then(
    () => check('requireFieldValue passes', true),
    () => check('requireFieldValue passes', false)
  );

  // ── 2. Old numbering still works ────────────────────────────────
  console.log('— older numbering (formField38) —');
  await page.setContent(OLD_NUMBERING_PAGE, { waitUntil: 'domcontentloaded' });
  const sel2 = await flow._findCodeField(2000);
  check('resolves formField38 OTP box', sel2 === '#formField38-1700000000000-9999');

  // ── 3. Must not pick email / name boxes ─────────────────────────
  console.log('— mixed fields (email + name + OTP) —');
  await page.setContent(MIXED_FIELDS_PAGE, { waitUntil: 'domcontentloaded' });
  const sel3 = await flow._findCodeField(2000);
  check('picks the digit field, not email/name', sel3 === '#formField41-3-3');
  const ok3 = await input.typeIntoField(sel3, '999111', { label: 'code', log: () => {} });
  check('code lands in the mixed page too', ok3 && (await input.readFieldValue(sel3)) === '999111');
  check('email box left untouched', (await input.readFieldValue('#formField12-1-1')) === '');

  await browser.close();
  console.log(`\n   ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('Harness error:', e.message); process.exit(1); });
