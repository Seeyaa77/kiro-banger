/**
 * Measures the speed profile against a fixed, deterministic workload:
 * typing a realistic email + name + 6-digit code, with the surrounding pauses
 * the signup flow uses. Run with different SPEED values to compare.
 *
 *   SPEED=1    node test-speed.js
 *   SPEED=0.35 node test-speed.js
 *   SPEED=0.2  node test-speed.js
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { HumanInput } = require('./utils/humanInput');
const timing = require('./utils/timing');

const HTML = `<!DOCTYPE html><html><body>
<form>
  <input id="email" type="email" placeholder="Email">
  <input id="name" type="text" placeholder="Full name">
  <input id="code" type="text" placeholder="6-digit" maxlength="6" inputmode="numeric">
</form>
</body></html>`;

const EMAIL = 'gunungcoklat34@xyntaur.com';
const NAME = 'Julia Miller';
const CODE = '187254';

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(HTML, { waitUntil: 'domcontentloaded' });
  const input = new HumanInput(page, {});

  const t = {};
  const t0 = Date.now();

  // Mirrors the signup flow's per-step shape (field + surrounding pause).
  let s = Date.now();
  await input.typeIntoField('#email', EMAIL, { label: 'email', log: () => {} });
  await input.randomPause(2500, 4000);
  t.email = Date.now() - s;

  s = Date.now();
  await input.typeIntoField('#name', NAME, { label: 'name', log: () => {} });
  await input.randomPause(2500, 4000);
  t.name = Date.now() - s;

  s = Date.now();
  await input.typeIntoField('#code', CODE, { label: 'code', log: () => {} });
  await input.randomPause(3000, 5000);
  t.code = Date.now() - s;

  const total = Date.now() - t0;

  const emailOk = (await input.readFieldValue('#email')) === EMAIL;
  const nameOk = (await input.readFieldValue('#name')) === NAME;
  const codeOk = (await input.readFieldValue('#code')) === CODE;

  console.log(`SPEED=${timing.SPEED} (isFast=${timing.isFast})`);
  console.log(`  email step : ${t.email} ms`);
  console.log(`  name step  : ${t.name} ms`);
  console.log(`  code step  : ${t.code} ms`);
  console.log(`  TOTAL      : ${total} ms`);
  console.log(`  correctness: email=${emailOk} name=${nameOk} code=${codeOk}`);

  await browser.close();

  if (!(emailOk && nameOk && codeOk)) {
    console.log('\n❌ values did not land — speed profile broke correctness');
    process.exit(1);
  }
  console.log('\n✅ values landed');
  process.exit(0);
}

main().catch(e => { console.error('Harness error:', e.message); process.exit(1); });
