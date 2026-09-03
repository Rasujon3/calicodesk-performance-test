# Homepage tests — commands cheat sheet

Use this file when you want to **run** homepage Playwright or k6 tests and **find the results**.

What homepage tests:

| Tool           | What it checks                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------- |
| **Playwright** | Opens `/` in a browser, expects HTTP 200 and the homepage heading. Records navigation timings. |
| **k6**         | HTTP `GET /` with load profiles. Expects HTTP 200.                                             |

You need a filled `.env` (`LOCAL_BASE_URL`, `DEV_BASE_URL`, `LIVE_BASE_URL`, optional `K6_DEFAULT_VUS`). Copy from `.env.example` if you have not already.

---

## Playwright (browser)

The runner sets the environment and a run ID. **Prefer these commands.**

### Local

Opens the homepage on your local app.

```bash
npm run test:runner -- --scenario homepage --env local
```

### Dev

Opens the homepage on the dev URL.

```bash
npm run test:runner -- --scenario homepage --env dev
```

### Live

Opens the homepage on the live URL. Use only when you intend to hit live.

```bash
npm run test:runner -- --scenario homepage --env live
```

### Shortcut (uses `TEST_ENV` from `.env`)

Does not take `--env`. It uses whatever `TEST_ENV` is in `.env`.

```bash
npm run test:homepage
```

### Open the HTML report

After a Playwright run:

```bash
npm run report:homepage
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
npm run k6:runner -- --scenario homepage --env local --profile smoke
```

Override VUs from the CLI:

```bash
npm run k6:runner -- --scenario homepage --env local --profile smoke --vus 2
npm run k6:runner -- --scenario homepage --env local --profile load --vus 10
npm run k6:runner -- --scenario homepage --env local --profile stress --vus 20
```

Same environment, other profiles (uses `K6_DEFAULT_VUS` from `.env` when `--vus` is omitted):

```bash
npm run k6:runner -- --scenario homepage --env local --profile load
npm run k6:runner -- --scenario homepage --env local --profile stress
npm run k6:runner -- --scenario homepage --env local --profile spike
npm run k6:runner -- --scenario homepage --env local --profile soak
npm run k6:runner -- --scenario homepage --env local --profile rps
```

### Dev

Quick check against the shared/dev app:

```bash
npm run k6:runner -- --scenario homepage --env dev --profile smoke
```

With an explicit VU override:

```bash
npm run k6:runner -- --scenario homepage --env dev --profile load --vus 10
```

Same environment, other profiles:

```bash
npm run k6:runner -- --scenario homepage --env dev --profile load
npm run k6:runner -- --scenario homepage --env dev --profile stress
npm run k6:runner -- --scenario homepage --env dev --profile spike
npm run k6:runner -- --scenario homepage --env dev --profile soak
npm run k6:runner -- --scenario homepage --env dev --profile rps
```

### Live

Smoke only, unless you have an explicit reason to run more:

```bash
npm run k6:runner -- --scenario homepage --env live --profile smoke
```

The runner warns when `--env live` is selected.

---

## k6 VUs (`.env` and CLI)

In `.env`:

```env
K6_DEFAULT_VUS=10
```

| Source | When it applies | Example |
| ------ | --------------- | ------- |
| CLI `--vus` | Highest priority | `--vus 20` → `VU Source: CLI` |
| `K6_DEFAULT_VUS` | Used when `--vus` is omitted | `K6_DEFAULT_VUS=10` → `VU Source: .env` |
| Profile default | Used when neither CLI nor `.env` sets VUs | smoke peak `1` → `VU Source: profile default` |

`--vus` must be a positive integer. Invalid values (`0`, `-1`, `abc`, `1.5`) fail before k6 starts.

---

## k6 profiles (short)

| Profile  | Meaning                      |
| -------- | ---------------------------- |
| `smoke`  | 1 user, 30s — start here     |
| `load`   | Ramp to 8 VUs over 2 minutes |
| `stress` | Ramp to 16 VUs over 1m40s    |
| `spike`  | Jump to 12 VUs, then recover |
| `soak`   | 5 VUs for about 3m40s        |
| `rps`    | 1 request/second for 30s     |

---

## Where to find results

The terminal prints the exact paths at the end of each run. Look for **Status: PASSED** or **FAILED**.

Run IDs look like `2026-09-02_105911_609424`.

Replace `<env>` with `local`, `dev`, or `live`. Replace `<runId>` with the printed run ID.

### Playwright

| File            | Path                                                                | What it is                           |
| --------------- | ------------------------------------------------------------------- | ------------------------------------ |
| Custom result   | `scenarios/homepage/results/playwright/<env>/<runId>/results.json`  | Status, timings, page/console errors |
| Playwright JSON | `scenarios/homepage/reports/playwright/<env>/<runId>/results.json`  | Playwright reporter JSON             |
| Metadata        | `scenarios/homepage/reports/playwright/<env>/<runId>/metadata.json` | Run ID, env, command, PASS/FAIL      |
| HTML report     | `scenarios/homepage/reports/playwright/html`                        | Open with `npm run report:homepage`  |

Failed runs may also leave traces, screenshots, or video under `test-results/` (gitignored).

### k6

| File           | Path                                                        | What it is                                |
| -------------- | ----------------------------------------------------------- | ----------------------------------------- |
| Metrics stream | `scenarios/homepage/results/k6/<env>/<runId>/results.json`  | Per-request k6 metrics                    |
| Summary        | `scenarios/homepage/reports/k6/<env>/<runId>/summary.json`  | Checks, HTTP failures, thresholds         |
| Metadata       | `scenarios/homepage/reports/k6/<env>/<runId>/metadata.json` | Run ID, env, profile, base URL, PASS/FAIL |

k6 can exit with code 0 even when checks fail. Trust **Status** in the terminal and `metadata.json`, not the process exit code alone.

---

## Combined k6 PDF report (homepage)

Reads **every** run under `scenarios/homepage/reports/k6/<env>/` and writes HTML + PDF. The terminal prints the PDF path.

### Local

```bash
npm run loadtestreport -- --scenario homepage --env local
```

### Dev

```bash
npm run loadtestreport -- --scenario homepage --env dev
```

### Live

```bash
npm run loadtestreport -- --scenario homepage --env live
```

`npm run loadtestresport` is the same command.

Generated files (today’s date):

- `scenarios/homepage/reports/k6/<env>/pdf/YYYY-MM-DD/load_test.html`
- `scenarios/homepage/reports/k6/<env>/pdf/YYYY-MM-DD/load_test.pdf`

Example for local on 2026-09-02:

`scenarios/homepage/reports/k6/local/pdf/2026-09-02/load_test.pdf`

## k6 PDF report

Builds one readable HTML + PDF from **all** k6 runs under `scenarios/<scenario>/reports/k6/<env>/`.

```bash
npm run loadtestreport -- --scenario homepage --env local
npm run loadtestreport -- --scenario homepage --env dev
npm run loadtestreport -- --scenario homepage --env live

npm run loadtestreport -- --scenario authentication --env local
npm run loadtestreport -- --scenario authentication --env dev
npm run loadtestreport -- --scenario authentication --env live
```

`npm run loadtestresport` is the same command.

Output (today’s date folder, files are overwritten if you generate again the same day):

- `scenarios/<scenario>/reports/k6/<env>/pdf/YYYY-MM-DD/load_test.html`
- `scenarios/<scenario>/reports/k6/<env>/pdf/YYYY-MM-DD/load_test.pdf`

The terminal prints the PDF path when it finishes.

---

## Suggested order

1. Playwright local (confirm the page looks right)
2. k6 smoke on local or dev (confirm HTTP 200 under load tooling)
3. Open the printed result files
4. Only then run a heavier k6 profile
