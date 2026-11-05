/**
 * Signup flow for AWS/Kiro account registration.
 * Handles email entry, name entry, verification code, and password setup.
 */

const path = require('path');
const fs = require('fs');
const { DEFAULT_CREDENTIALS_PATH, upsertCredential } = require('../utils/credentials');
const tui = require('../utils/tui');
const timing = require('../utils/timing');

class SignupFlow {
  /**
   * @param {object} agent - KiroAgent instance (has .page, .humanInput, .mailstack, etc.)
   */
  constructor(agent) {
    this.agent = agent;
  }

  get page() { return this.agent.page; }
  get input() { return this.agent.humanInput; }
  get mailstack() { return this.agent.mailstack; }

  async run() {
    const agent = this.agent;
    const identity = agent.identity;
    const email = agent.email;

    console.log('');
    tui.section('Kiro Linker - New Registration');
    console.log('');
    console.log(`  Name:     ${identity.fullName}`);
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${identity.password}`);
    console.log('');

    try {
      // Get device code from dashboard first (same as login flow)
      console.log('[STEP 1/6] Getting device code from dashboard...');
      const { deviceCode, userCode, verificationUri, cookieHeader, deviceCodeData } = await agent.getDeviceCode();
      console.log(`   ✓ Device code: ${deviceCode}`);
      console.log(`   ✓ User code: ${userCode}`);

      // Start background polling for OAuth token (same as login flow)
      console.log('[STEP 2/6] Starting background polling for OAuth token...');
      const tokenPromise = agent.pollForOAuthToken(deviceCodeData, cookieHeader);

      // Open the verification URL from device code (same as login flow)
      console.log('[STEP 3/6] Opening verification URL...');
      console.log(`   URL: ${verificationUri}`);
      await this.page.goto(verificationUri, { waitUntil: 'domcontentloaded', timeout: 60000 });

      console.log('   Waiting for redirect to signup form...');
      try {
        await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
        console.log('   ✓ Redirected to signup form');
      } catch (e) {
        console.log('   ⚠ No redirect detected, continuing with current page');
      }

      await new Promise(r => setTimeout(r, timing.scale(3000)));
      await this.page.waitForSelector('input', { timeout: 15000 }).catch(() => {});
      await this.input.randomPause(1000, 2000);

      // Step 4 — Enter email
      console.log('[STEP 4/6] Entering email...');
      const emailSelector = await this._findInputField([
        'input[id*="formField14"]',
        'input[type="email"]',
        'input[name*="email"]',
        'input[id*="email"]',
        'input[placeholder*="email" i]'
      ], 'email');

      await this.input.humanClick(emailSelector);
      await this.input.randomPause(600, 1200);
      const emailOk = await this.input.typeIntoField(emailSelector, email, {
        label: 'email',
        log: (m) => console.log(m)
      });
      if (!emailOk) console.log('   ⚠️  Email field verification failed');
      await this.input.randomPause(800, 1500);

      // Click Continue (email -> name)
      console.log('   Clicking Continue after email...');
      await this.clickContinueAndVerify('email → name');
      await this.input.randomPause(2500, 4000);
      await this.assertNoAwsError('email');

      // Enter name
      console.log('   Entering name...');
      const nameSelector = await this._findInputField([
        'input[id*="formField17"]',
        'input[id*="field17"]',
        'input[type="text"]',
        'input[name*="name"]',
        'input[id*="name"]',
        'input[placeholder*="name" i]',
        'input[placeholder*="full name" i]',
        'input[placeholder*="first name" i]'
      ], 'name');

      await this.input.humanClick(nameSelector);
      await this.input.randomPause(600, 1200);
      const nameOk = await this.input.typeIntoField(nameSelector, identity.fullName, {
        label: 'name',
        log: (m) => console.log(m)
      });
      if (!nameOk) console.log('   ⚠️  Name field verification failed');
      await this.input.randomPause(800, 1500);

      // Click Continue (name -> verification)
      console.log('   Clicking Continue after name...');
      await this.clickContinueAndVerify('name → verification');
      await this.input.randomPause(2500, 4000);

      // ERR-837 is raised exactly here ("Type: Signup") — catch it before we
      // start waiting on an email that will never be sent.
      await this.assertNoAwsError('name');

      // Verification code
      console.log('   📬 Polling inbox for the verification email...');
      const code = await this.mailstack.waitForVerificationCode(email, 'verif', 120000, 5000);
      console.log(`   ✓ Code received: ${code}`);

      await new Promise(r => setTimeout(r, timing.scale(1000)));

      const codeSelector = await this._findCodeField();

      await this.input.humanClick(codeSelector);
      await this.input.randomPause(600, 1200);

      // The verification code field is the one that silently failed before, so
      // try hard, then re-resolve the field and retry once more before giving up.
      let codeOk = await this.input.typeIntoField(codeSelector, code, {
        label: 'verification code',
        log: (m) => console.log(m)
      });

      if (!codeOk) {
        console.log('   🔁 Code field empty after first attempt — re-resolving field and retrying...');
        await this.input.randomPause(500, 900);
        const retrySelector = await this._findCodeField();
        codeOk = await this.input.typeIntoField(retrySelector, code, {
          label: 'verification code (retry)',
          log: (m) => console.log(m)
        });
      }

      if (!codeOk) {
        throw new Error(`Verification code field could not be filled with "${code}"`);
      }

      // Confirm the value is really in the DOM before advancing.
      await this.input.requireFieldValue(codeSelector, code, 'verification code');
      console.log(`   ✓ Verification code "${code}" confirmed in field`);

      await this.input.randomPause(800, 1500);

      // Click Continue (verification code -> password)
      console.log('   Clicking Continue after code...');
      await this.clickContinueAndVerify('code → password');
      await this.input.randomPause(2500, 4000);
      await this.assertNoAwsError('verification code');

      // Set password + confirm password
      console.log('[STEP 5/6] Setting password...');
      await this._fillPasswordFields();

      // Final submit
      console.log('   Submitting final form...');
      await this.clickContinueAndVerify('password → submit');
      await this.input.randomPause(3000, 5000);
      await this.assertNoAwsError('password submit');

      // Auto-handle device authorization page (same as login flow)
      console.log('[STEP 5.5/6] Handling device authorization...');
      await this._handleDeviceAuthorization();

      // Wait for OAuth token from background polling
      console.log('[STEP 6/6] Waiting for OAuth token...');
      const oauthToken = await tokenPromise;
      if (oauthToken) {
        console.log(`   ✓ OAuth token received: ${oauthToken.substring(0, 20)}...`);
      } else {
        console.log('   ✓ OAuth flow completed; dashboard registered the account');
      }

      // Save credentials
      const credentials = {
        email,
        password: identity.password,
        name: identity.fullName,
        firstName: identity.firstName,
        lastName: identity.lastName,
        oauthToken: oauthToken || null,
        createdAt: new Date().toISOString(),
        success: true
      };

      const credsPath = upsertCredential(credentials, DEFAULT_CREDENTIALS_PATH);

      // Save browser state
      console.log('💾 Capturing browser state...');
      const browserState = await this.agent.captureBrowserState();
      const cacheDir = path.join(__dirname, '..', '.cache');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const timestamp = Date.now();
      const statePath = path.join(cacheDir, `state_file_${timestamp}.json`);
      fs.writeFileSync(statePath, JSON.stringify(browserState, null, 2));

      console.log('');
      tui.section('Registration Complete');
      console.log('');
      console.log(`  📧 Email:    ${email}`);
      console.log(`  🔐 Password: ${identity.password}`);
      console.log(`  👤 Name:     ${identity.fullName}`);
      console.log(`  🔑 OAuth:    ${oauthToken ? oauthToken.substring(0, 20) + '...' : 'completed on dashboard'}`);
      console.log(`  💾 Saved to: ${credsPath}`);
      console.log(`  🗂️  State:   ${statePath}\n`);

      return { success: true, credentials };

    } catch (error) {
      console.error(`\n[ERROR] ${error.message}`);

      if (error.awsError) {
        console.error(`[AWS] ${error.awsError.code}${error.awsError.type ? ` (Type: ${error.awsError.type})` : ''}`);
        if (error.awsError.requestId) console.error(`[AWS] Request ID: ${error.awsError.requestId}`);
        if (error.retryable) console.error('[AWS] Retryable — a new address and a short pause often succeed.');
      }

      if (process.env.SCREENSHOT_ON_ERROR === 'true') {
        const screenshotPath = path.join(__dirname, '..', '..', 'error_screenshot.png');
        try {
          await this.page.setViewport(this.agent.viewport || { width: 870, height: 706 });
          await this.page.screenshot({ path: screenshotPath, fullPage: false });
          console.log(`[DEBUG] Screenshot saved: ${screenshotPath}`);
        } catch (screenshotError) {
          console.log(`[DEBUG] Screenshot skipped: ${screenshotError.message}`);
        }
      }

      return {
        success: false,
        error: error.message,
        retryable: Boolean(error.retryable),
        awsError: error.awsError || null
      };
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Locate the verification-code input without relying on AWS's field numbering.
   *
   * AWS renumbers its fields between deployments (observed: formField38 →
   * formField41) and the OTP box carries `placeholder="6-digit"` with no
   * "code"/"verification"/"pin" substring anywhere, so any hardcoded selector
   * list goes stale. Instead, score every visible text input on signals that
   * are semantic rather than positional:
   *
   *   - placeholder that mentions digits / a code   -> strong
   *   - maxlength of 4-8 (a code is short)          -> medium
   *   - inputmode / autocomplete hints for one-time codes -> strong
   *   - `type=number` or `type=tel`                 -> medium
   *   - id containing `formField` + a low field number -> weak tiebreak
   *
   * @returns {Promise<string>} a CSS selector usable with page.$ / focus
   */
  async _findCodeField(timeoutMs = 45000) {
    const startedAt = Date.now();
    let lastSummary = '';

    while (Date.now() - startedAt < timeoutMs) {
      const picked = await this.page.evaluate(() => {
        const visible = el => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 &&
            s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
        };

        const inputs = Array.from(document.querySelectorAll('input')).filter(visible);

        const scored = [];
        for (const el of inputs) {
          const type = (el.getAttribute('type') || 'text').toLowerCase();
          if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'password', 'file', 'email'].includes(type)) continue;

          const rawId = el.getAttribute('id') || '';
          const rawPlaceholder = el.getAttribute('placeholder') || '';
          const placeholder = rawPlaceholder.toLowerCase();
          const inputmode = (el.getAttribute('inputmode') || '').toLowerCase();
          const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
          const id = rawId.toLowerCase();
          const aria = (el.getAttribute('aria-labelledby') || '').toLowerCase();
          const maxlength = Number(el.getAttribute('maxlength') || 0);
          const haystack = `${placeholder} ${aria} ${id}`;

          let score = 0;
          const why = [];

          // Placeholder / label talks about digits or a code.
          if (/\d\s*-\s*digit|digit|one[-\s]?time|\botp\b|\bcode\b|verification|passcode|\bpin\b/.test(haystack)) {
            score += 60; why.push('placeholder-code');
          }
          // Explicitly a 4-8 char field — code-shaped.
          if (maxlength >= 4 && maxlength <= 8) { score += 25; why.push(`maxlength=${maxlength}`); }
          if (inputmode === 'numeric' || inputmode === 'tel') { score += 30; why.push(`inputmode=${inputmode}`); }
          if (autocomplete === 'one-time-code' || autocomplete === 'otp') { score += 40; why.push('autocomplete-otp'); }
          if (type === 'number' || type === 'tel') { score += 20; why.push(`type=${type}`); }
          // AWS form fields — tiebreak only, since the number changes.
          if (/formfield\d+/.test(id)) {
            score += 5; why.push('aws-formfield');
            const m = id.match(/formfield(\d+)/);
            if (m) score += Math.max(0, 10 - Number(m[1]) / 10);
          }
          // An already-typed code means it is the right box.
          if ((el.value || '').length >= 4) { score += 50; why.push('has-value'); }

          if (score > 0) scored.push({ score, why: why.join(','), id: rawId, placeholder: rawPlaceholder, type, maxlength });
        }

        scored.sort((a, b) => b.score - a.score);

        if (scored.length === 0) {
          return {
            selector: null,
            summary: inputs.slice(0, 8).map(i => ({
              id: i.id || '', placeholder: i.placeholder || '', type: i.type || ''
            })),
            candidates: []
          };
        }

        const best = scored[0];
        // Build a stable selector: prefer the exact id, else the placeholder.
        let selector;
        if (best.id) selector = `#${CSS.escape(best.id)}`;
        else if (best.placeholder) selector = `input[placeholder="${best.placeholder}"]`;
        else selector = 'input';

        return { selector, best, candidates: scored.slice(0, 3) };
      }).catch(() => ({ selector: null, summary: [], candidates: [] }));

      if (picked.selector) {
        console.log(`   ✓ Found verification code input: ${picked.selector}`);
        console.log(`     (score ${picked.best.score}: ${picked.best.why})`);
        if (picked.best.placeholder) console.log(`     placeholder="${picked.best.placeholder}"`);
        return picked.selector;
      }

      lastSummary = JSON.stringify(picked.summary || []);
      await new Promise(r => setTimeout(r, timing.scale(750)));
    }

    if (this.agent.debug) {
      console.log(`   ⚠️  Visible inputs while looking for the code field: ${lastSummary}`);
    }
    throw new Error('Could not find verification code input field');
  }

  async _findInputField(selectors, label, timeoutMs = 45000) {
    const startedAt = Date.now();
    let lastInputSummary = '';

    while (Date.now() - startedAt < timeoutMs) {
      for (const selector of selectors) {
        try {
          const el = await this.page.$(selector);
          if (!el) continue;

          const isUsable = await this.page.evaluate(node => {
            const rect = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            return rect.width > 0 && rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              !node.disabled &&
              node.getAttribute('aria-disabled') !== 'true';
          }, el);

          if (!isUsable) continue;

          console.log(`   ✓ Found ${label} input: ${selector}`);
          return await this.page.evaluate(node => {
            if (node.id) return `#${CSS.escape(node.id)}`;
            if (node.name) return `input[name="${CSS.escape(node.name)}"]`;
            return node.tagName.toLowerCase() + `[type="${node.type || 'text'}"]`;
          }, el);
        } catch (e) {}
      }

      lastInputSummary = await this.page.evaluate(() => {
        return Array.from(document.querySelectorAll('input')).map(input => ({
          id: input.id || '',
          name: input.name || '',
          type: input.type || '',
          placeholder: input.placeholder || '',
          visible: input.getBoundingClientRect().width > 0 && input.getBoundingClientRect().height > 0
        })).slice(0, 8);
      }).then(inputs => JSON.stringify(inputs)).catch(() => 'unavailable');

      await new Promise(r => setTimeout(r, timing.scale(750)));
    }

    if (this.agent.debug) {
      console.log(`   ⚠️  Last visible inputs while looking for ${label}: ${lastInputSummary}`);
    }
    throw new Error(`Could not find ${label} input field`);
  }

  async _forcePasswordFields(passwordInputs, password) {
    // Read every password field back; anything empty gets a React-aware write.
    const values = await this.page.evaluate(() => {
      return Array.from(document.querySelectorAll('input[type="password"]')).map((el, i) => ({
        index: i,
        length: (el.value || '').length
      }));
    }).catch(() => []);

    const empties = values.filter(v => v.length === 0);
    if (empties.length === 0) return;

    console.log(`   🔧 ${empties.length} password field(s) still empty — forcing value...`);

    await this.page.evaluate((pw) => {
      const proto = HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      for (const el of document.querySelectorAll('input[type="password"]')) {
        if ((el.value || '').length > 0) continue;
        if (setter) setter.call(el, pw); else el.value = pw;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, password);

    await new Promise(r => setTimeout(r, timing.scale(200)));
  }

  async _fillPasswordFields() {
    const agent = this.agent;
    const input = this.input;
    const page = this.page;

    console.log('   Waiting for password fields...');
    try {
      await page.waitForSelector('input[type="password"]', { timeout: 15000 });
      console.log('   ✓ Password page loaded');
    } catch (e) {
      console.log('   ⚠️  Password page wait timed out');
    }

    const passwordInputs = await page.$$('input[type="password"]');
    console.log(`   Found ${passwordInputs.length} password input(s)`);

    if (passwordInputs.length >= 2) {
      const pw1Input = passwordInputs[0];
      const pw2Input = passwordInputs[1];

      let pw2Box = null;
      try { pw2Box = await pw2Input.boundingBox(); } catch (e) {}

      // Fill password field
      const pw1Success = await agent.fillPasswordBulletproof(pw1Input, agent.password, 'Password field', 5);
      if (!pw1Success) {
        console.log('   🚨 Password field failed, attempting humanTypeElement...');
        await input.humanTypeElement(pw1Input, agent.password);
        await input.randomPause(500, 1000);
      }

      // Fill confirm password field
      const pw2Success = await agent.fillPasswordBulletproof(pw2Input, agent.password, 'Confirm password field', 5);
      if (!pw2Success) {
        console.log('   🚨 Confirm password field failed, attempting humanTypeElement...');
        await input.humanTypeElement(pw2Input, agent.password);
        await input.randomPause(500, 1000);
      }

      // Force-fill any field that is still empty (React can drop the keystrokes)
      await this._forcePasswordFields(passwordInputs, agent.password);

      // Dismiss password strength popup
      if (pw2Box) {
        console.log('   🖱️  Dismissing password strength popup...');
        for (let dismissAttempt = 0; dismissAttempt < 3; dismissAttempt++) {
          const clickAwayY = pw2Box.y - (20 + dismissAttempt * 10);
          const clickAwayX = pw2Box.x + (pw2Box.width / 2);

          try {
            await input.humanClickPoint(clickAwayX, clickAwayY, { prePause: false, postPause: true, jitter: 8 });
            await input.randomPause(500, 1000);

            const hasPopup = await page.evaluate(() => {
              const popups = document.querySelectorAll('[class*="strength"], [data-testid*="strength"], .strength-meter');
              return popups.length > 0;
            });

            if (!hasPopup) {
              console.log('   ✅ Popup dismissed successfully');
              break;
            } else {
              console.log(`   ⚠️  Popup still visible, trying alternative dismiss (${dismissAttempt + 1}/3)...`);
              await new Promise(r => setTimeout(r, timing.scale(300)));
            }
          } catch (e) {
            console.log(`   ⚠️  Click away failed: ${e.message}`);
          }
        }
      }

    } else if (passwordInputs.length === 1) {
      const pwInput = passwordInputs[0];
      console.log('   → Single password field detected, filling it...');
      const success = await agent.fillPasswordBulletproof(pwInput, agent.password, 'Single password field', 5);
      if (!success) {
        console.log('   🚨 Single field failed, attempting humanTypeElement...');
        await input.humanTypeElement(pwInput, agent.password);
      }
      await this._forcePasswordFields(passwordInputs, agent.password);
    } else {
      console.log('   ⚠️  No password fields found');
    }

    // Final verification before submit
    console.log('   🔍 Final password verification before submit...');
    try {
      const pwValues = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
        return inputs.map(el => ({ value: el.value, id: el.id || 'no-id', name: el.name || 'no-name' }));
      });

      console.log('   Password field values:');
      pwValues.forEach((pw, i) => {
        const matched = pw.value === agent.password ? '✅ MATCH' : `❌ MISMATCH (got ${pw.value ? pw.value.length + ' chars' : 'empty'})`;
        console.log(`     Field ${i + 1} (${pw.id || pw.name}): ${matched}`);
      });
    } catch (e) {
      console.log(`   ⚠️  Verification failed: ${e.message}`);
    }
  }

  /**
   * Read the page and detect an AWS-side error screen.
   *
   * AWS surfaces failures as an interstitial with a code such as `ERR-837` and a
   * `Type:` field. Without this check the flow happily waits for a verification
   * email that will never arrive and then fails with a misleading timeout.
   *
   * @returns {Promise<null|{code: string, message: string, type: string, requestId: string, retryable: boolean}>}
   */
  async detectAwsErrorPage() {
    let text;
    try {
      text = await this.page.evaluate(() => document.body?.innerText || '');
    } catch (e) {
      return null;
    }
    if (!text) return null;

    const codeMatch = text.match(/ERR-\d{3,4}/);

    // Phrases that only appear on AWS's error interstitial. Deliberately strict:
    // a generic "please try again" also shows up on healthy form pages, so it
    // must NEVER be enough on its own to flag a page as failed.
    const strongPhrases = [
      /there was an error processing your request/i,
      /an unexpected error (?:has )?occurred/i,
      /we(?:'| a)re (?:sorry|unable),?\s*(?:but )?something went wrong/i,
      /there is an issue with your .{0,30}account/i,
      /your account (?:has been|is) (?:suspended|locked|blocked)/i
    ];
    const hasStrongCopy = strongPhrases.some(re => re.test(text));

    // Require a code, or error copy that is unambiguous on its own.
    if (!codeMatch && !hasStrongCopy) return null;

    const code = codeMatch ? codeMatch[0] : 'ERR-UNKNOWN';
    const typeMatch = text.match(/Type:\s*([A-Za-z ]+)/);
    const requestIdMatch = text.match(/Request ID:\s*([0-9a-f-]{8,})/i);
    const type = typeMatch ? typeMatch[1].trim() : '';

    // Transient signup failures — worth retrying (often with a different address).
    const retryableCodes = ['ERR-837', 'ERR-838', 'ERR-839', 'ERR-UNKNOWN'];

    return {
      code,
      type,
      requestId: requestIdMatch ? requestIdMatch[1] : '',
      message: text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4).join(' | '),
      retryable: retryableCodes.includes(code)
    };
  }

  /**
   * Throw when the page is an AWS error screen. Call after every step that can
   * trigger a server-side rejection.
   *
   * @param {string} step label used in the thrown message
   */
  async assertNoAwsError(step) {
    const err = await this.detectAwsErrorPage();
    if (!err) return null;

    const detail = [
      `${err.code} at step "${step}"`,
      err.type ? `Type: ${err.type}` : null,
      err.requestId ? `Request ID: ${err.requestId}` : null
    ].filter(Boolean).join(' — ');

    const error = new Error(`AWS rejected the request (${detail})`);
    error.awsError = err;
    error.retryable = err.retryable;
    throw error;
  }

  async _waitForSuccess() {
    const successIndicators = [
      'Registration complete',
      'Account created',
      'Welcome',
      'Success',
      'verified'
    ];

    let registrationSuccess = false;
    const maxSuccessWait = 20000;
    const successStart = Date.now();

    console.log('   Waiting for registration to complete...');
    while (Date.now() - successStart < maxSuccessWait) {
      const pageText = await this.page.evaluate(() => document.body.innerText);
      for (const indicator of successIndicators) {
        if (pageText.toLowerCase().includes(indicator.toLowerCase())) {
          console.log(`   ✓ "${indicator}" detected!`);
          registrationSuccess = true;
          break;
        }
      }
      if (registrationSuccess) break;
      await new Promise(r => setTimeout(r, timing.scale(500)));
    }

    if (!registrationSuccess) {
      console.log('   ⚠️  No success indicators found, but proceeding anyway');
    }

    return registrationSuccess;
  }

  // ─── Navigation Helpers ─────────────────────────────────────────

  async dismissCookieBanner() {
    try {
      const clicked = await this.page.evaluate(() => {
        const phrases = [
          'accept all', 'accept', 'agree', 'allow all', 'ok',
          'zaakceptuj', 'akceptuj', 'zgadzam', 'aceptar'
        ];
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], a'));
        for (const btn of buttons) {
          const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
          const rect = btn.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0 &&
            window.getComputedStyle(btn).display !== 'none' &&
            window.getComputedStyle(btn).visibility !== 'hidden';
          if (isVisible && phrases.some(p => text === p || text.startsWith(p))) {
            btn.click();
            return text;
          }
        }
        const selectors = [
          '#onetrust-accept-btn-handler', '#L2AGLb', '.fc-cta-consent',
          '[data-cookiefirst-action="accept"]',
          'button[id*="accept"]', 'button[class*="accept"]'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              el.click();
              return sel;
            }
          }
        }
        return null;
      });
      if (clicked) {
        console.log(`   🍪 Dismissed cookie banner: "${clicked}"`);
        await new Promise(r => setTimeout(r, timing.scale(1500)));
        return true;
      }
    } catch (e) {}
    return false;
  }

  async _handleDeviceAuthorization() {
    try {
      await this.dismissCookieBanner();

      console.log('   🔍 Waiting for device authorization page...');
      const authReady = await this._waitForDeviceAuthorization(60000);

      if (!authReady) {
        console.log('   ℹ️  Device authorization page not detected, skipping...');
        return false;
      }

      const pageTitle = await this.page.evaluate(() => document.title).catch(() => '');
      const pageUrl = this.page.url();
      console.log(`   🚦 Detected authorization page: ${pageTitle || pageUrl.substring(0, 80)}`);

      const hasConfirmButton = await this.page.$('#cli_verification_btn').catch(() => null);
      if (hasConfirmButton) {
        await this.dismissCookieBanner();
        await new Promise(r => setTimeout(r, timing.scale(500)));

        console.log('   ⏳ Waiting for "Confirm and Continue"...');
        await this.input.humanClick('#cli_verification_btn');
        await this.input.randomPause(2500, 4000);
      }

      await this.dismissCookieBanner();
      await new Promise(r => setTimeout(r, timing.scale(1000)));

      console.log('   ⏳ Waiting for "Allow Access" button...');
      const allowClicked = await this._clickButtonByText('allow access', 'Allow Access', 30000);

      if (!allowClicked) {
        console.log('   ⚠️  "Allow Access" not found by text, trying AWS primary button...');
        try {
          await this.page.waitForSelector('[class*="awsui_variant-primary"]', { visible: true, timeout: 10000 });
          await this.input.humanClick('[class*="awsui_variant-primary"]');
          await this.input.randomPause(3000, 5000);
          console.log('   ✅ Clicked AWS primary button');
        } catch (e) {
          throw new Error('Could not find Allow Access button after device authorization');
        }
      } else {
        await this.input.randomPause(2000, 3000);
      }

      console.log('   ✅ AWS OAuth authorization clicked!');
      return true;

    } catch (error) {
      console.log('   ⚠️  Error handling device authorization:', error.message);
      throw error;
    }
  }

  async _waitForDeviceAuthorization(timeoutMs = 60000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await this.dismissCookieBanner();

      const hasConfirmButton = await this.page.$('#cli_verification_btn').catch(() => null);
      if (hasConfirmButton) return true;

      const hasAllowButton = await this._findButtonByText('allow access').catch(() => null);
      if (hasAllowButton) return true;

      const pageText = await this.page.evaluate(() => document.body.innerText).catch(() => '');
      const lower = pageText.toLowerCase();
      if (lower.includes('confirm and continue') || lower.includes('allow access')) {
        return true;
      }

      await new Promise(r => setTimeout(r, timing.scale(1000)));
    }
    return false;
  }

  async _findButtonByText(searchText) {
    return this.page.evaluate((searchText) => {
      const clickables = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], a[href]'));
      for (const el of clickables) {
        const text = (el.innerText || el.textContent || el.value || '').trim().toLowerCase();
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const isVisible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        if (isVisible && text.includes(searchText)) {
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text };
        }
      }
      return null;
    }, searchText.toLowerCase());
  }

  async _clickButtonByText(searchText, displayName, timeoutMs = 30000) {
    console.log(`   Looking for "${displayName}" button...`);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const buttonInfo = await this._findButtonByText(searchText);
      if (buttonInfo) {
        console.log(`   🖱️  Found "${buttonInfo.text}", clicking...`);
        await this.input.humanClickPoint(buttonInfo.x, buttonInfo.y);
        return true;
      }
      await new Promise(r => setTimeout(r, timing.scale(750)));
    }

    console.log(`   ⚠️  Could not find "${displayName}" by text`);
    return false;
  }

  async clickContinueButton() {
    await this.dismissCookieBanner();
    await new Promise(r => setTimeout(r, timing.scale(500)));

    const buttonInfo = await this.page.evaluate(() => {
      const candidates = [];

      const allClickable = Array.from(document.querySelectorAll(
        'button, [role="button"], input[type="submit"], a[href]'
      ));
      for (const el of allClickable) {
        const text = (el.innerText || el.textContent || el.value || '').trim();
        if (/continue/i.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            candidates.push({
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              text,
              tag: el.tagName,
              score: text.toLowerCase() === 'continue' ? 10 : 5
            });
          }
        }
      }

      const awsBtns = document.querySelectorAll('[class*="awsui_variant-primary"]');
      for (const el of awsBtns) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          candidates.push({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            text: (el.innerText || '').trim(),
            tag: 'AWS_PRIMARY',
            score: 8
          });
        }
      }

      const submits = document.querySelectorAll('button[type="submit"], input[type="submit"]');
      for (const el of submits) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          candidates.push({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            text: (el.innerText || el.value || '').trim(),
            tag: 'SUBMIT',
            score: 3
          });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      return candidates[0] || null;
    });

    if (buttonInfo) {
      console.log(`   🖱️  Clicking: "${buttonInfo.text}" (${buttonInfo.tag})`);
      await this.input.humanClickPoint(buttonInfo.x, buttonInfo.y);
      return true;
    }

    console.log('   ⚠️  No Continue button found');
    return false;
  }

  async waitForPageChange(previousUrl, timeoutMs = 20000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const currentUrl = this.page.url();
      if (currentUrl !== previousUrl) {
        console.log(`   ✓ Page changed: ${currentUrl.slice(0, 80)}...`);
        return true;
      }
      await new Promise(r => setTimeout(r, timing.scale(500)));
    }
    return false;
  }

  async clickContinueAndVerify(label) {
    const urlBefore = this.page.url();
    const htmlBefore = await this.page.evaluate(() => document.body.innerHTML.length);

    console.log(`   Clicking Continue (${label})...`);
    const clicked = await this.clickContinueButton();

    if (!clicked) {
      throw new Error(`Could not find Continue button at step: ${label}`);
    }

    await this.input.randomPause(1500, 2500);

    const urlChanged = await this.waitForPageChange(urlBefore, 10000);
    if (urlChanged) return true;

    const htmlAfter = await this.page.evaluate(() => document.body.innerHTML.length);
    if (Math.abs(htmlAfter - htmlBefore) > 500) {
      console.log(`   ✓ Form advanced (DOM changed by ${htmlAfter - htmlBefore} chars)`);
      return true;
    }

    console.log('   ⚠️  Page didn\'t change, retrying...');
    await this.dismissCookieBanner();
    await new Promise(r => setTimeout(r, timing.scale(500)));

    const urlBefore2 = this.page.url();
    await this.clickContinueButton();
    await this.input.randomPause(2000, 3000);

    const changed = await this.waitForPageChange(urlBefore2, 10000);
    if (changed) return true;

    console.log('   ⚠️  Still no page change after retry — proceeding anyway');
    return false;
  }
}

module.exports = { SignupFlow };
