# Chat tests — commands cheat sheet

Use this file when you want to **run** chat Playwright or k6 tests and **find the results**.

What chat tests:

| Tool | What it checks |
| --- | --- |
| **Playwright** | **Two-actor conversation (primary regression):** anonymous visitor widget + authenticated agent, full bidirectional message flow (23 checkpoints). **Embed fixture:** loads `scenarios/chat/fixtures/embed.html` with the real installation script from `CALICODESK_LIVECHAT_LOADER_URL`, verifies widget renders in an external-site iframe. Uses headed system Chrome. |
| **k6** | Full two-actor conversation against the real widget + helpdesk APIs: anonymous visitor bootstrap (widget document, XSRF/session/customer cookies), visit tracking, chat creation via `POST /api/v1/lc/widget/chats` (SSE `conversationCreated`), agent login (`workspace lookup` + `/auth/login`), agent reply via `POST /api/v1/helpdesk/agent/conversations/{id}/messages`, visitor message #2, and bidirectional polling checks. One agent session (setup) shared across all VUs. |

You need a filled `.env` (`LOCAL_BASE_URL`, `DEV_BASE_URL`, `LIVE_BASE_URL`, `TEST_USER_EMAIL`, `TEST_USER_PASSWORD`, `CALICODESK_LIVECHAT_LOADER_URL`, optional `K6_DEFAULT_VUS`). Copy from `.env.example` if you have not already.

---

## Playwright (browser)

The runner sets the environment and a run ID. **Prefer these commands.**

The `test:runner` approach runs **all three** Playwright chat specs (embed fixture + W3Schools + two-actor). The `test:chat` shortcut runs the **primary regression only** (embed fixture + two-actor, no external W3Schools dependency).

### Local

```bash
npm run test:runner -- --scenario chat --env local
```

### Dev

```bash
npm run test:runner -- --scenario chat --env dev
```

### Live

```bash
npm run test:runner -- --scenario chat --env live
```

### Shortcut — primary regression only (uses `TEST_ENV` from `.env`)

Runs `@embed` + `@two-actor`. Does not take `--env`. No W3Schools dependency.

```bash
npm run test:chat
```

### Open the HTML report

After a Playwright run:

```bash
npm run report:chat
```

---

## k6 (HTTP load)

`--scenario` and `--env` are required. If you omit `--profile`, it defaults to **smoke**.

Peak VUs are resolved in this order:

1. CLI `--vus <number>`
2. `.env` `K6_DEFAULT_VUS` (default in `.env.example`: `10`)
3. Profile default peak VUs

The terminal prints `VUs` and `VU Source` (`CLI`, `.env`, or `profile default`) before the run starts. For the **rps** profile, arrival rate stays as configured; `--vus` / `K6_DEFAULT_VUS` only resize the VU pool.

Heavy profiles (`load`, `stress`, `spike`, `soak`, `rps`) should usually stay on **local** or **dev**. Do not point them at live unless that is explicit and approved.

### Local

Quick check against your local app:

```bash
npm run k6:runner -- --scenario chat --env local --profile smoke
```

Override VUs from the CLI:

```bash
npm run k6:runner -- --scenario chat --env local --profile smoke --vus 2
npm run k6:runner -- --scenario chat --env local --profile load --vus 10
npm run k6:runner -- --scenario chat --env local --profile stress --vus 20
```

Same environment, other profiles (uses `K6_DEFAULT_VUS` from `.env` when `--vus` is omitted):

```bash
npm run k6:runner -- --scenario chat --env local --profile load
npm run k6:runner -- --scenario chat --env local --profile stress
npm run k6:runner -- --scenario chat --env local --profile spike
npm run k6:runner -- --scenario chat --env local --profile soak
npm run k6:runner -- --scenario chat --env local --profile rps
```

### Dev

Quick check against the shared/dev app:

```bash
npm run k6:runner -- --scenario chat --env dev --profile smoke
```

With an explicit VU override:

```bash
npm run k6:runner -- --scenario chat --env dev --profile load --vus 10
```

Same environment, other profiles:

```bash
npm run k6:runner -- --scenario chat --env dev --profile load
npm run k6:runner -- --scenario chat --env dev --profile stress
npm run k6:runner -- --scenario chat --env dev --profile spike
npm run k6:runner -- --scenario chat --env dev --profile soak
npm run k6:runner -- --scenario chat --env dev --profile rps
```

### Live

Use only when you intend to hit live. Prefer `smoke` or `rps` only.

```bash
npm run k6:runner -- --scenario chat --env live --profile smoke
```

---

## Results and artifacts

The terminal prints three paths at the end of every run. Replace `<runId>` with the printed run ID.

### Playwright

| File | Path | What it is |
| --- | --- | --- |
| Two-actor result | `scenarios/chat/results/playwright/<env>/<runId>/two-actor-results.json` | Full 23-checkpoint bidirectional conversation result |
| Embed result | `scenarios/chat/results/playwright/<env>/<runId>/results.json` | Widget-in-iframe fixture result |
| Metadata | `scenarios/chat/reports/playwright/<env>/<runId>/metadata.json` | Run ID, env, command, PASS/FAIL |
| HTML report | `scenarios/chat/reports/playwright/html` | Open with `npm run report:chat` |

Failed runs may also leave traces, screenshots, or video under `test-results/` (gitignored).

### k6

| File | Path | What it is |
| --- | --- | --- |
| Metrics stream | `scenarios/chat/results/k6/<env>/<runId>/results.json` | Per-request k6 metrics |
| Summary | `scenarios/chat/reports/k6/<env>/<runId>/summary.json` | Checks, HTTP failures, thresholds |
| Metadata | `scenarios/chat/reports/k6/<env>/<runId>/metadata.json` | Run ID, env, profile, base URL, PASS/FAIL |

k6 can exit with code 0 even when checks fail. Trust **Status** in the terminal and `metadata.json`, not the process exit code alone.

---

## k6 PDF report

Builds one readable HTML + PDF from **all** k6 runs under `scenarios/chat/reports/k6/<env>/`.

```bash
npm run loadtestreport -- --scenario chat --env local
npm run loadtestreport -- --scenario chat --env dev
npm run loadtestreport -- --scenario chat --env live
```

`npm run loadtestresport` is the same command.

Output (today's date folder, files are overwritten if you generate again the same day):

- `scenarios/chat/reports/k6/<env>/pdf/YYYY-MM-DD/load_test.html`
- `scenarios/chat/reports/k6/<env>/pdf/YYYY-MM-DD/load_test.pdf`

---

## How the k6 chat scenario works

Each k6 iteration reproduces a complete two-actor conversation against the real CalicoDesk widget and helpdesk APIs:

1. **`setup()`** (once): authenticates the agent — workspace email lookup → `/auth/login` (Bearer token). The token is shared by all VUs. The k6 runner strips `setup_data` from the persisted summary so the token never reaches reports/results.
2. **Per-iteration visitor side** (anonymous, Chrome User-Agent):
   - GET widget document (`/lc/widget`) → sets XSRF-TOKEN, session, and customer cookies
   - POST visit tracking (`/api/v1/lc/widget/visits`)
   - POST chat creation + visitor message #1 (`/api/v1/lc/widget/chats`) → SSE response, extract `conversationId`
   - POST visitor message #2 to the created conversation
   - GET poll for agent reply
3. **Per-iteration agent side** (Bearer token):
   - GET conversation detail (`/api/v1/helpdesk/agent/conversations/{id}`)
   - POST agent reply (`/api/v1/helpdesk/agent/conversations/{id}/messages`)
   - GET poll for visitor message #2

The visitor session is per-VU (cookies scoped to the VU number). The agent session is shared (single Bearer token). All checks verify HTTP 200/201 and message content.

---

## How the Playwright chat scenario works

### Two-actor (primary regression)

Two isolated browser contexts, two independent actors:

- **AGENT**: logs in via the real login page, verifies Live Chat install settings, extracts the installation script
- **VISITOR**: opens the local embed fixture (`http://127.0.0.1:4177/embed.html`), the loader injects the widget iframe, visitor sends `CUSTOMER_MESSAGE_1`
- **AGENT**: navigates to conversations, finds the conversation by message text, opens it, verifies `CUSTOMER_MESSAGE_1`, sends `AGENT_REPLY_1`
- **VISITOR**: waits for `AGENT_REPLY_1` in the widget, sends `CUSTOMER_MESSAGE_2`
- **AGENT**: verifies `CUSTOMER_MESSAGE_2` in the same conversation

All 23 checkpoints must pass. Unique messages per run (`CalicoDesk Chat Test <timestamp>-<counter>-<hex4>`). Bounded polling. No fixed sleeps.

### Embed fixture

Loads the real `CALICODESK_LIVECHAT_LOADER_URL` (configured in `.env`) into a static external-website page (`scenarios/chat/fixtures/embed.html`) served by a local fixture server on port 4177. The loader injects `#be-chat-iframe`, the widget bootstraps (`window.BeChatReady`), and the iframe renders visibly. No dependency on W3Schools or any external DOM structure.

The embed fixture is configurable via query parameters without editing code: `loaderUrl` (required) and optionally `widgetDomain`. The fixture never contains credentials, tokens, or cookies.

### W3Schools (optional, not part of primary regression)

`npm run test:chat:w3schools` (tagged `[@w3schools]`) runs the exploratory W3Schools TryIt flow. This depends on W3Schools availability and is intentionally **not** part of the primary CI chat test.

---

## Limitations

- **k6 agent login throttling:** Dev Fortify allows ~5 logins/min per email+IP. The k6 `setup()` retries up to 6 times with 12-second spacing.
- **k6 does not use browser rendering:** k6 uses the proven API contract (HTTP endpoints + SSE) captured from the real two-actor Playwright flow. It does not load the widget iframe or execute JavaScript.
- **k6 creates real conversations:** Every k6 iteration creates a new conversation on the tenant. Heavy profiles generate many conversations (e.g., soak produces ~145). Use local or dev.
- **Playwright fixture server:** The embed fixture server runs on `127.0.0.1:4177`. Set `CALICODESK_FIXTURE_PORT` in `.env` if the port is in use.
- **W3Schools dependency:** `test:chat:w3schools` and `test:runner --scenario chat` (which includes it) depend on W3Schools availability. Use `test:chat` for the reliable regression.
- **Playwright Timeout:** The two-actor scenario is allocated `300_000` ms (300 seconds).

---

## Suggested order

1. **Playwright primary regression** (confirm widget renders + bidirectional conversation):
   ```bash
   npm run test:chat
   ```
2. **k6 smoke** (confirm HTTP 200 under load tooling):
   ```bash
   npm run k6:runner -- --scenario chat --env dev --profile smoke
   ```
3. Open the printed result files
4. Only then run a heavier k6 profile

---

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `CALICODESK_LIVECHAT_LOADER_URL is not configured` | Set the real installation script URL in `.env`. |
| Widget does not render in fixture | Check the fixture server is running (port 4177). Verify the loader URL is accessible. |
| Two-actor Playwright times out at login | Ensure captcha is disabled or test keys are configured on the target environment. |
| k6 setup fails: "agent login did not return a token" | Dev login limiter may have throttled all 6 retries. Wait 60 seconds and retry. |
| k6 chat run aborts: "could not resolve the workspace" | Check `TEST_USER_EMAIL` in `.env` is correct and the SSO endpoint is reachable. |
| Port 4177 already in use | Set `CALICODESK_FIXTURE_PORT` in `.env` to a free port. |
| W3Schools test fails | External dependency. Use `npm run test:chat` instead. |

---

## Security considerations

- **Never hardcode secrets.** Do not copy real passwords, tokens, API keys, cookies, or Authorization headers into `CHATTEST.md` or commit them in code.
- **Environment variables only.** All credentials are loaded dynamically from `.env`.
- **k6 strips agent token.** The k6 runner strips `setup_data` (containing the Bearer token) from the persisted summary.
- **Use test accounts only.** Always use dedicated, non-production test accounts.
- **Widget cookies are anonymous.** The visitor widget session uses anonymous cookies. No credentials are involved in the visitor path.
