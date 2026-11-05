# Kiro Linker

Terminal tool for AWS/Kiro account registration and 9router dashboard linking.

It drives a real browser through the AWS Builder ID signup form, reads the
verification code from a temporary inbox, and authorizes the resulting account
against a 9router dashboard over the device-code OAuth flow.

> **Disclaimer** — Use this only with accounts and services you own or are
> authorized to manage, and follow the terms of service of every service it
> touches. No affiliation with or endorsement by AWS, Kiro, Tempik or 9router.

## Requirements

- Node.js 20 or newer
- A running [9router](https://github.com/decolua/9router/) dashboard with its API
  reachable (default `http://localhost:20128`)
- The dashboard password
- Chromium, downloaded automatically by Puppeteer

## Install

```bash
git clone <your-repo-url> kiro-linker
cd kiro-linker
npm install
cp .env.example .env
```

Edit `.env` and set at least the dashboard URL and password:

```dotenv
DASHBOARD_URL=http://localhost:20128
DASHBOARD_PASSWORD=your-dashboard-password
MAILSTACK_API_KEY=dummy
SPEED=0.3
```

The inbox provider needs no API key, so `MAILSTACK_API_KEY` can stay as `dummy`.
The variable name is kept for backward compatibility.

## Quick start

Check the dashboard credentials first. A wrong password locks the API for 120
seconds after four attempts, which makes every registration fail with a `429`:

```bash
node test-dashboard-auth.js
```

Then register accounts:

```bash
npm run register                  # asks how many
node agent/main.js --register --count 5
```

Or open the interactive menu:

```bash
npm start
```

## Usage

### Interactive menu

`npm start` offers four options:

| Option | What it does |
| --- | --- |
| Login with existing Kiro account | Sign in to an existing AWS/Kiro account |
| Full registration | Create a new account and link it to the dashboard |
| Settings | Workers, browser mode, inbox list |
| Exit | Quit |

### CLI reference

```bash
node agent/main.js [options]
```

| Flag | Description |
| --- | --- |
| *(none)* | Interactive menu |
| `-r`, `--register` | Full registration |
| `-l`, `--login` | Login with an existing account |
| `-d`, `--dashboard-only` | Link saved accounts to the dashboard |
| `-n`, `--count N` | How many accounts to register |
| `-e`, `--email` | Existing account email (login mode) |
| `-p`, `--password` | Existing account password (login mode) |
| `-m`, `--mfa` | MFA code; omit to poll the inbox |
| `-f`, `--credentials` | Use a specific credentials file |
| `--speed N` | Delay multiplier (default `0.3`, `1` = slowest) |
| `-v`, `--verbose` | Detailed progress |
| `--debug` | Debug output |
| `-h`, `--help` | Help |

Examples:

```bash
node agent/main.js --register --count 3
node agent/main.js --login --email user@example.com --password 'secret'
node agent/main.js --register --speed 1
```

### Settings

Inside the menu, **Settings** has two tabs:

| Key | Action |
| --- | --- |
| `left` / `right` | Switch tab |
| `up` / `down` | Move |
| `Space` | Toggle the selected item |
| `R` | Refresh the inbox list |
| `Esc` / `Q` | Back to the menu |

`Workers` sets how many registrations run at once. `Browser mode` switches
between headed and headless Chromium.

### Speed

Every artificial delay scales with one value:

```dotenv
SPEED=0.3   # 1 = slowest/original, 0.3 = default, 0.2 = fastest
```

Measured with `node test-speed.js` on a fixed workload:

| SPEED | Total | vs original |
| --- | --- | --- |
| `1` | 45.8s | — |
| `0.3` | ~13s | ~3.5x faster |
| `0.2` | 9.1s | 5.0x faster |

Field values land correctly at every setting. Going below `0.2` is not
recommended: the pacing floor exists so the run does not look mechanical.

## How it works

Each registration:

1. Generates a fresh `@xyntaur.com` inbox through the inbox API.
2. Requests a device code from the dashboard and opens the AWS verification URL.
3. Fills the AWS signup form (email, name, password) and submits it.
4. Polls the inbox for the verification email and enters the code.
5. Approves the OAuth device authorization and stores the token.

Three details are worth knowing, because each one caused silent failures before:

- **Fields are verified.** AWS forms are React-controlled, so a value typed with
  real keystrokes can be dropped when React re-renders. After filling a field the
  value is read back and force-written if it did not stick.
- **The code box is found semantically**, by placeholder, `maxlength` and
  `inputmode` — not by AWS field number, which changes between deployments
  (observed: `formField38` to `formField41`).
- **AWS error pages are detected immediately.** An `ERR-8xx` interstitial is
  recognised right after each step and retried with a new inbox, instead of
  waiting for a verification email that will never arrive.

## Project layout

```text
agent/main.js               CLI entry point and menu routing
core/KiroAgent.js           Browser/session orchestration
core/signupFlow.js          New account registration
core/awsLoginFlow.js        Existing account login
core/dashboardFlow.js       Dashboard linking
services/MailstackClient.js Inbox and message API client
utils/timing.js             Speed profile for all delays
utils/humanInput.js         Human-like input, verified field writes
utils/dashboardClient.js    Dashboard HTTP with auth and rate-limit handling
utils/settings.js           Local settings and inbox cache
utils/tui.js                Terminal output
```

## Local files

| File | Purpose | Committed? |
| --- | --- | --- |
| `.env` | Credentials and settings | No |
| `.settings.json` | Inbox cache and preferences | No |
| `credentials.json` | Registered accounts | No |
| `.cache/` | Screenshots and debug logs | No |
| `.env.example` | Configuration template | Yes |

Never commit `.env`, `credentials.json`, `.settings.json` or `.cache/` — they
hold passwords, cookies and account details. `node_modules/` and `.cache/` are
ignored as well.

## Troubleshooting

### Dashboard returns 429

Almost always the lockout, not a rate limit. 9router blocks the API for 120s
after four wrong passwords. Diagnose it with:

```bash
node test-dashboard-auth.js
```

A wrong password reports itself as such instead of a bare `429`. Fix it in
`.env`, wait out the lockout, then re-run.

### The verification code arrives but the field stays empty

The code box changed shape upstream. The tool now resolves it semantically; if a
run still misses it, `node test-code-field.js` shows which input it picks.

### AWS returns ERR-837

An AWS-side, intermittent rejection that also affects plain browser signups (see
[kirodotdev/Kiro#11856](https://github.com/kirodotdev/Kiro/issues/11856)). The
tool retries with a fresh inbox up to three times. If it persists across many
addresses it is usually an IP-level block — change network before retrying.

### No saved accounts found

`credentials.json` must exist in the project root and contain an array:

```json
[
  {
    "email": "example.account@example.com",
    "password": "replace-with-password",
    "name": "Example User"
  }
]
```

### Browser is too noisy

Set browser mode to `Headless` in Settings, or `HEADLESS=true` in `.env`.

## Development

```bash
npm test            # syntax check + smoke test
npm run check       # syntax only
node test-speed.js  # measure the speed profile
```

The test scripts cover the areas that broke repeatedly:

| Script | Covers |
| --- | --- |
| `test-field-fill.js` | React-controlled field writes |
| `test-code-field.js` | Verification-code box resolution |
| `test-aws-error-detect.js` | ERR-8xx detection, no false positives |
| `test-dashboard-auth.js` | Dashboard credential check |
| `test-speed.js` | Speed profile timings and correctness |
| `test-generate.js` | Inbox generation and uniqueness |

## License

MIT — see [LICENSE](LICENSE).
