/**
 * Verifies the React-safe field writing helpers against a mock that models
 * React's actual value-tracking behaviour:
 *
 *   - React installs a node-level `value` descriptor; its setter records what
 *     React last wrote into `tracked`.
 *   - On `input`, React compares the REAL DOM value with `tracked`. Equal means
 *     "no change" and the edit is ignored.
 *   - Therefore a plain `el.value = x` is IGNORED (tracked becomes x, no delta),
 *     while writing through the PROTOTYPE setter leaves `tracked` stale so React
 *     sees a real change.
 *
 * The helpers must therefore succeed through the prototype setter.
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { HumanInput } = require('./utils/humanInput');

const HTML = `<!DOCTYPE html>
<html><body>
<form>
  <input id="code" type="number" placeholder="Verification code">
  <input id="plain" type="text" placeholder="Name">
  <input id="pw1" type="password" placeholder="Password">
  <input id="pw2" type="password" placeholder="Confirm password">
</form>
<script>
function makeReactControlled(id) {
  const el = document.getElementById(id);
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  let tracked = desc.get.call(el);

  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return desc.get.call(el); },
    set(v) { desc.set.call(el, v); tracked = v; }
  });

  el.addEventListener('input', () => {
    const real = desc.get.call(el);
    if (real !== tracked) {
      tracked = real;
      el.dataset.reacted = 'yes';
    } else {
      el.dataset.reacted = 'no';
    }
  });
}
['code','plain','pw1','pw2'].forEach(makeReactControlled);
</script>
</body></html>`;

const readState = (page, id) => page.$eval('#' + id, el => ({
  value: el.value,
  reacted: el.dataset.reacted || 'no'
}));

async function main() {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(HTML, { waitUntil: 'domcontentloaded' });

  const input = new HumanInput(page, {});
  let pass = 0, fail = 0;
  const check = (name, cond) => { console.log(`   ${cond ? '✅' : '❌'} ${name}`); cond ? pass++ : fail++; };

  // Baseline: a plain assignment must be IGNORED by the mock (proves it is strict).
  await page.$eval('#code', el => { el.value = '999999'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const baseline = await readState(page, 'code');
  check('baseline: plain assignment ignored by mock (React-like)', baseline.reacted === 'no');

  // 1. typeIntoField must land AND be seen by React
  const ok1 = await input.typeIntoField('#code', '740329', { label: 'code', log: () => {} });
  const s1 = await readState(page, 'code');
  check('typeIntoField(#code) returns true', ok1 === true);
  check('#code holds "740329"', s1.value === '740329');
  check('#code change seen by React', s1.reacted === 'yes');

  // 2. plain text field
  const ok2 = await input.typeIntoField('#plain', 'Julia Miller', { label: 'name', log: () => {} });
  const s2 = await readState(page, 'plain');
  check('typeIntoField(#plain) returns true', ok2 === true);
  check('#plain holds "Julia Miller"', s2.value === 'Julia Miller');
  check('#plain change seen by React', s2.reacted === 'yes');

  // 3. requireFieldValue throws on mismatch
  let threw = false;
  try { await input.requireFieldValue('#plain', 'Wrong Value', 'name'); } catch (e) { threw = true; }
  check('requireFieldValue throws on mismatch', threw);

  // 4. password via native set (the path _forcePasswordFields uses)
  await input.setFieldValueNatively('#pw1', '%!80qyvED');
  const s4 = await readState(page, 'pw1');
  check('#pw1 holds the password', s4.value === '%!80qyvED');
  check('#pw1 change seen by React', s4.reacted === 'yes');

  await browser.close();
  console.log(`\n   ${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('Harness error:', e.message); process.exit(1); });
