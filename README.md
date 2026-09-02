# CalicoDesk Performance Testing

TypeScript suite for CalicoDesk performance and browser checks.

- **k6** — HTTP load tests (profiles, thresholds, custom runner)
- **Playwright** — browser-level checks for the same scenarios

Supported scenarios: **homepage** and **authentication**.

Environments: **local**, **dev**, and **live**. The k6 runner always requires an explicit `--env`. It does not default to live.

## Prerequisites

Install these before running tests:

| Tool | Role in this repo |
| --- | --- |
| **Node.js** and **npm** | Runtime and package install (`package.json`) |
| **k6** | Must be installed separately and available as `k6` on `PATH`. It is not an npm dependency. |
| **Playwright** | Provided by `@playwright/test` after `npm install`. Browsers may still need `npx playwright install`. |
| **tsx** | Used by `k6:runner` and `test:runner` (`tsx` is a devDependency). |
| **TypeScript** | `npm run typecheck` runs `tsc --noEmit`. |
| **esbuild** | The k6 runner bundles scenario TypeScript before `k6 run`. |

This repository does not pin a Node.js version in `package.json`.

## Installation

```bash
npm install
npx playwright install
```

Confirm k6 is available:

```bash
k6 version
```

Copy environment placeholders and fill in local values (never commit `.env`):

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

## Environment configuration

| File | Purpose |
| --- | --- |
| `.env.example` | Tracked placeholders only. Safe to commit. |
| `.env` | Local values. Gitignored. Do not commit. |

### Variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `TEST_ENV` | Playwright (`test:runner` sets this from `--env`) | `local`, `dev`, or `live` |
| `LOCAL_BASE_URL` | Both runners | URL for `--env local` |
| `DEV_BASE_URL` | Both runners | URL for `--env dev` |
| `LIVE_BASE_URL` | Both runners | URL for `--env live` |
| `TEST_USER_EMAIL` | Playwright authentication only | Test account email |
| `TEST_USER_PASSWORD` | Playwright authentication only | Test account password |

Example placeholders (not real credentials):

```env
TEST_ENV=local
LOCAL_BASE_URL=http://localhost:8000
DEV_BASE_URL=https://dev.example.com
LIVE_BASE_URL=https://www.example.com
TEST_USER_EMAIL=test-user@example.com
TEST_USER_PASSWORD=replace-with-local-test-password
```

### How BASE_URL is resolved

`config/base-url.ts` maps the selected environment to one variable:

- `local` → `LOCAL_BASE_URL`
- `dev` → `DEV_BASE_URL`
- `live` → `LIVE_BASE_URL`

The k6 runner requires `--env` and calls `resolveBaseUrl()`. There is no default URL and no fallback to live. The value is validated as a URL and trailing slashes are removed.

k6 scenarios read `BASE_URL` from the runner. They do not hardcode hosts.

Playwright uses `TEST_ENV` plus the same URL resolver (`config/environments.ts`). `npm run test:runner -- --env <environment>` sets `TEST_ENV` for that run.

k6 authentication does **not** use `TEST_USER_EMAIL` or `TEST_USER_PASSWORD`.

## Available scenarios

### homepage

| Tool | What it tests |
| --- | --- |
| k6 | `GET ${BASE_URL}/` and checks HTTP 200 |
| Playwright | Opens `/`, expects HTTP 200, heading **Live Chat, AI Chatbot & Helpdesk Software for Websites**, and no uncaught page errors. Records navigation timings. |

### authentication

| Tool | What it tests |
| --- | --- |
| k6 | `GET ${BASE_URL}/login`. Checks HTTP 200, HTML `Content-Type`, and a substantial login document. Does **not** POST credentials. |
| Playwright | Browser login: `/login` → email → Continue → password step → Sign in → `/dashboard`. Uses env credentials. Google reCAPTCHA on the login page can block Sign in in automation. |

k6 does not replay the full login. The UI is a JavaScript SPA; the password step often uses a workspace host; Sign in can require reCAPTCHA; there is no documented HTTP login API in this repo.

## k6 profiles

Shared configuration lives in `config/load-profiles.ts`. Values are conservative for shared/dev validation, not production traffic estimates.

| Profile | Shape | Duration | Peak |
| --- | --- | --- | --- |
| **smoke** | 1 VU | 30s | 1 VU |
| **load** | stages 0→4→8 (hold 40s)→0 | 2m | 8 VUs |
| **stress** | stages 4→8→12→16→0 (20s each) | 1m40s | 16 VUs |
| **spike** | stages 2→12 (hold 20s)→2→0 | 1m10s | 12 VUs |
| **soak** | 5 VUs for 3m, plus ramp | 3m40s | 5 VUs |
| **rps** | `constant-arrival-rate` 1 request/s, `preAllocatedVUs` 4, `maxVUs` 8 | 30s | 8 VUs |

If `--profile` is omitted, the runner defaults to **smoke**.

Do not run heavy profiles against live unless that is an explicit, intentional `--env live` choice. The runner warns when `--env live` is selected.

## k6 runner commands

```bash
npm run k6:runner -- --scenario <homepage|authentication> --env <local|dev|live> --profile <smoke|load|stress|spike|soak|rps>
```

`--scenario` and `--env` are required. `--profile` is optional (default: `smoke`).

### Homepage

```bash
npm run k6:runner -- --scenario homepage --env local --profile smoke
npm run k6:runner -- --scenario homepage --env dev --profile smoke
npm run k6:runner -- --scenario homepage --env live --profile smoke
```

### Authentication

```bash
npm run k6:runner -- --scenario authentication --env local --profile smoke
npm run k6:runner -- --scenario authentication --env dev --profile smoke
npm run k6:runner -- --scenario authentication --env live --profile smoke
```

### Profiles (dev examples)

```bash
npm run k6:runner -- --scenario homepage --env dev --profile smoke
npm run k6:runner -- --scenario homepage --env dev --profile load
npm run k6:runner -- --scenario homepage --env dev --profile stress
npm run k6:runner -- --scenario homepage --env dev --profile spike
npm run k6:runner -- --scenario homepage --env dev --profile soak
npm run k6:runner -- --scenario homepage --env dev --profile rps
```

The same `--profile` values work with `--scenario authentication`.

## Playwright commands

Preferred runner (sets `TEST_ENV` and a run ID):

```bash
npm run test:runner -- --scenario homepage --env local
npm run test:runner -- --scenario homepage --env dev
npm run test:runner -- --scenario homepage --env live

npm run test:runner -- --scenario authentication --env local
npm run test:runner -- --scenario authentication --env dev
npm run test:runner -- --scenario authentication --env live
```

Package shortcuts (use `TEST_ENV` from `.env`):

```bash
npm run test:homepage
npm run test:auth
npm test
```

HTML reports:

```bash
npm run report:homepage
npm run report:auth
```

## Type checking

```bash
npm run typecheck
```

This runs `tsc --noEmit`.

## Results and artifacts

Generated under the scenario folder. These paths are gitignored.

### k6

| Artifact | Path | Purpose |
| --- | --- | --- |
| `results.json` | `scenarios/<scenario>/results/k6/<env>/<runId>/results.json` | k6 JSON metric stream |
| `summary.json` | `scenarios/<scenario>/reports/k6/<env>/<runId>/summary.json` | End-of-run metrics, checks, and thresholds |
| `metadata.json` | `scenarios/<scenario>/reports/k6/<env>/<runId>/metadata.json` | Run ID, scenario, env, profile, base URL, command, PASS/FAIL, exit code |

Run IDs look like `YYYY-MM-DD_HHmmss_<hex>`.

### Playwright

| Artifact | Path | Purpose |
| --- | --- | --- |
| Custom `results.json` | `scenarios/<scenario>/results/playwright/<env>/<runId>/results.json` | Status, timings, console/page errors |
| Playwright JSON | `scenarios/<scenario>/reports/playwright/<env>/<runId>/results.json` | Playwright JSON reporter output |
| `metadata.json` | `scenarios/<scenario>/reports/playwright/<env>/<runId>/metadata.json` | Runner metadata (from `test:runner`) |
| HTML report | `scenarios/<scenario>/reports/playwright/html` | Playwright HTML report |

Failure traces, screenshots, and videos may also appear under `test-results/` (gitignored). Treat them as sensitive if a login test filled a password.

## PASS/FAIL behavior

k6 scenarios set:

- `checks: rate==1` — every check must pass
- `http_req_failed: rate==0` — no failed HTTP requests

The custom runner (`scripts/k6-runner.ts`) still inspects `summary.json` after k6 exits. It marks the run **failed** if:

- k6 exits non-zero
- any check failed
- `http_req_failed` is greater than 0
- any threshold was crossed
- `summary.json` cannot be read

Invalid `--scenario`, `--env`, or `--profile` values are rejected before k6 starts.

A missing or invalid `{LOCAL,DEV,LIVE}_BASE_URL` fails immediately with the variable name.

## Security

- Do not commit `.env`.
- `.env.example` may be committed; it contains placeholders only.
- Do not hardcode credentials, tokens, or cookies.
- k6 logs URL and HTTP status only. It does not log passwords, tokens, cookies, or Authorization headers.
- `metadata.json` stores the public base URL and command, not credentials.
- Playwright traces, screenshots, and videos from a failed login can show a filled password. Keep `test-results/` and report folders local.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `LOCAL_BASE_URL` / `DEV_BASE_URL` / `LIVE_BASE_URL` is not configured | Copy `.env.example` to `.env` and set the URL for that environment. |
| Invalid URL for environment | The value must be a valid URL. Remove a trailing slash if needed; the resolver strips them. |
| Invalid environment / profile / scenario | Allowed values: envs `local`, `dev`, `live`; profiles `smoke`, `load`, `stress`, `spike`, `soak`, `rps`; scenarios `homepage`, `authentication`. |
| Failed to start k6 | Install k6 and ensure `k6` is on `PATH` (`k6 version`). |
| Playwright browsers missing | Run `npx playwright install`. |
| Authentication Playwright fails at Sign in | Google reCAPTCHA can block automation. Disable captcha or use reCAPTCHA test keys on the test environment. |
| `TEST_USER_EMAIL` / `TEST_USER_PASSWORD` is not configured | Required only for Playwright authentication. Set them in `.env`. |
| `npm run typecheck` fails | Fix TypeScript errors. The command is `tsc --noEmit`. |
| Where did my run go? | See **Results and artifacts**. The runner prints the three k6 paths at the end of each run. |

## Project structure

```text
.
├── .env.example
├── .gitignore
├── package.json
├── playwright.config.ts
├── tsconfig.json
├── README.md
├── config/
│   ├── base-url.ts          # resolveBaseUrl() for local/dev/live
│   ├── environments.ts      # Playwright TEST_ENV + base URL
│   ├── load-profiles.ts     # smoke/load/stress/spike/soak/rps
│   ├── run-id.ts
│   └── check-environment.ts
├── scripts/
│   ├── k6-runner.ts         # npm run k6:runner
│   └── test-runner.ts       # npm run test:runner
└── scenarios/
    ├── homepage/
    │   ├── k6/homepage.ts
    │   └── playwright/homepage.spec.ts
    └── authentication/
        ├── k6/authentication.ts
        └── playwright/authentication.spec.ts
```

Generated `scenarios/**/results/` and `scenarios/**/reports/` directories appear after a run and are gitignored.

## Development workflow

```bash
npm install
npx playwright install
cp .env.example .env          # then edit .env
npm run typecheck
npm run k6:runner -- --scenario homepage --env dev --profile smoke
```

Inspect the printed `results.json`, `summary.json`, and `metadata.json` paths. Confirm the runner status is `PASSED`.

Then run authentication smoke:

```bash
npm run k6:runner -- --scenario authentication --env dev --profile smoke
```

Use `load`, `stress`, `spike`, `soak`, or `rps` only when you intend that traffic. Prefer `--env local` or `--env dev` for broader profiles. Do not point heavy profiles at live unless that is explicit and approved.
