import 'dotenv/config';

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  getProfilePeakVus,
  loadProfileNames,
  type LoadProfileName,
  type VuSource,
} from '../config/load-profiles.js';
import {
  isTestEnvironment,
  resolveBaseUrl,
  testEnvironments,
  type TestEnvironment,
} from '../config/base-url.js';

type Scenario = 'homepage' | 'authentication';

type Environment = TestEnvironment;

type Profile = LoadProfileName;

interface RunMetadata {
  runId: string;
  scenario: Scenario;
  environment: Environment;
  profile: Profile;
  baseUrl: string;
  vus: number;
  vusSource: VuSource;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'passed' | 'failed';
  exitCode?: number;
  command: string;
}

const validScenarios: Scenario[] = [
  'homepage',
  'authentication',
];

const validEnvironments: Environment[] = [...testEnvironments];

const validProfiles: Profile[] = [...loadProfileNames];

function getArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

function printUsage(): void {
  console.log(`
CalicoDesk k6 Test Runner

Usage:
  npm run k6:runner -- --scenario <scenario> --env <environment> --profile <profile> [--vus <number>]

Scenarios:
  homepage
  authentication

Environments:
  local
  dev
  live

Profiles:
  smoke
  load
  stress
  spike
  soak
  rps

Optional:
  --vus <number>   Override peak VUs (positive integer).
                   Priority: CLI --vus → K6_DEFAULT_VUS (.env) → profile default.
                   For the rps profile, this resizes the VU pool only; arrival rate stays as configured.

Examples:

  npm run k6:runner -- --scenario homepage --env local --profile smoke

  npm run k6:runner -- --scenario homepage --env local --profile load --vus 10

  npm run k6:runner -- --scenario homepage --env dev --profile load

  npm run k6:runner -- --scenario homepage --env live --profile smoke

  npm run k6:runner -- --scenario authentication --env dev --profile smoke
`);
}

function parsePositiveIntegerVus(
  raw: string,
  sourceLabel: string
): number {
  if (!/^\d+$/.test(raw)) {
    fail(
      `Invalid ${sourceLabel} value: "${raw}".\nVU must be a positive integer.`
    );
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    fail(
      `Invalid ${sourceLabel} value: "${raw}".\nVU must be a positive integer.`
    );
  }

  return value;
}

function resolveVus(profile: Profile): {
  vus: number;
  vusSource: VuSource;
  hasOverride: boolean;
} {
  const cliRaw = getArgument('--vus');

  if (cliRaw !== undefined) {
    return {
      vus: parsePositiveIntegerVus(cliRaw, '--vus'),
      vusSource: 'cli',
      hasOverride: true,
    };
  }

  const envRaw = process.env.K6_DEFAULT_VUS?.trim();

  if (envRaw) {
    return {
      vus: parsePositiveIntegerVus(envRaw, 'K6_DEFAULT_VUS'),
      vusSource: 'env',
      hasOverride: true,
    };
  }

  return {
    vus: getProfilePeakVus(profile),
    vusSource: 'profile default',
    hasOverride: false,
  };
}

function vuSourceLabel(source: VuSource): string {
  if (source === 'cli') {
    return 'CLI';
  }

  if (source === 'env') {
    return '.env';
  }

  return 'profile default';
}

function generateRunId(): string {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  const random = randomBytes(3).toString('hex');

  return `${year}-${month}-${day}_${hours}${minutes}${seconds}_${random}`;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

interface K6Metric {
  [key: string]: unknown;
  values?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  fails?: number;
  value?: number;
}

interface K6Summary {
  metrics?: Record<string, K6Metric>;
  root_group?: {
    checks?: Record<
      string,
      {
        fails?: number;
      }
    >;
  };
}

function readMetricNumber(
  metric: K6Metric | undefined,
  keys: string[]
): number {
  if (!metric) {
    return 0;
  }

  const nestedValues = metric.values;

  if (nestedValues) {
    for (const key of keys) {
      const nestedValue = nestedValues[key];

      if (typeof nestedValue === 'number') {
        return nestedValue;
      }
    }
  }

  for (const key of keys) {
    const value = metric[key];

    if (typeof value === 'number') {
      return value;
    }
  }

  return 0;
}

function collectFailedThresholds(
  metrics: Record<string, K6Metric> | undefined
): string[] {
  const failed: string[] = [];

  if (!metrics) {
    return failed;
  }

  for (const [metricName, metric] of Object.entries(metrics)) {
    const thresholds = metric.thresholds;

    if (!thresholds || typeof thresholds !== 'object') {
      continue;
    }

    for (const [expression, result] of Object.entries(thresholds)) {
      /*
       * k6 --summary-export (v2) stores a boolean
       * that is true when the threshold was crossed
       * (failed). Newer handleSummary-style objects
       * use { ok: true } when the threshold passed.
       */
      const crossed =
        result === true ||
        (typeof result === 'object' &&
          result !== null &&
          'ok' in result &&
          (result as { ok?: unknown }).ok === false);

      if (crossed) {
        failed.push(`${metricName}: ${expression}`);
      }
    }
  }

  return failed;
}

function collectRootGroupCheckFails(
  summary: K6Summary
): number {
  const checks = summary.root_group?.checks;

  if (!checks) {
    return 0;
  }

  let fails = 0;

  for (const check of Object.values(checks)) {
    fails += check.fails ?? 0;
  }

  return fails;
}

function evaluateK6Summary(summary: K6Summary): {
  failed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  const checkFails = Math.max(
    readMetricNumber(summary.metrics?.checks, ['fails']),
    collectRootGroupCheckFails(summary)
  );

  if (checkFails > 0) {
    reasons.push(`k6 checks failed: ${checkFails}`);
  }

  const httpFailedRate = readMetricNumber(
    summary.metrics?.http_req_failed,
    ['rate', 'value']
  );

  if (httpFailedRate > 0) {
    reasons.push(
      `HTTP request failure rate: ${httpFailedRate}`
    );
  }

  const failedThresholds = collectFailedThresholds(
    summary.metrics
  );

  if (failedThresholds.length > 0) {
    reasons.push(
      `k6 thresholds failed: ${failedThresholds.join('; ')}`
    );
  }

  return {
    failed: reasons.length > 0,
    reasons,
  };
}

const scenario = getArgument('--scenario');
const environment = getArgument('--env');

const profile =
  (getArgument('--profile') ?? 'smoke') as Profile;

if (!scenario || !environment) {
  printUsage();

  fail('Missing required arguments.');
}

if (!validScenarios.includes(scenario as Scenario)) {
  fail(
    `Invalid scenario: ${scenario}\nAllowed scenarios: ${validScenarios.join(', ')}`
  );
}

if (!environment || !isTestEnvironment(environment)) {
  fail(
    `Invalid environment: ${environment}\nAllowed environments: ${validEnvironments.join(', ')}`
  );
}

if (!validProfiles.includes(profile)) {
  fail(
    `Invalid profile: ${profile}\nAllowed profiles: ${validProfiles.join(', ')}`
  );
}

const selectedScenario = scenario as Scenario;

const selectedEnvironment =
  environment as Environment;

const { vus, vusSource, hasOverride } = resolveVus(profile);

const runId = generateRunId();

let baseUrl: string;

try {
  baseUrl = resolveBaseUrl(selectedEnvironment);
} catch (error) {
  fail(
    error instanceof Error
      ? error.message
      : `BASE_URL is not configured for environment: ${selectedEnvironment}`
  );
}

if (selectedEnvironment === 'live') {
  console.warn(
    '\nWarning: Targeting the live environment. ' +
      'Heavy profiles (load, stress, spike, soak, rps) are not started automatically. ' +
      'Only continue if this explicit --env live selection is intentional.\n'
  );
}

console.log(`Base URL: ${baseUrl}`);

let testUserEmail: string | undefined;
let testUserPassword: string | undefined;

if (selectedScenario === 'authentication') {
  testUserEmail = process.env.TEST_USER_EMAIL?.trim();
  testUserPassword = process.env.TEST_USER_PASSWORD?.trim();

  if (!testUserEmail || !testUserPassword) {
    fail(
      'Authentication k6 requires TEST_USER_EMAIL and TEST_USER_PASSWORD in .env. ' +
        'Use a dedicated non-production test account.'
    );
  }
}

const scenarioRoot = path.resolve(
  `scenarios/${selectedScenario}/k6`
);

const reportDirectory = path.resolve(
  `scenarios/${selectedScenario}/reports/k6/${selectedEnvironment}/${runId}`
);

const resultsDirectory = path.resolve(
  `scenarios/${selectedScenario}/results/k6/${selectedEnvironment}/${runId}`
);

const metadataPath = path.join(
  reportDirectory,
  'metadata.json'
);

const bundlePath = path.resolve(
  `.tmp/k6/${selectedScenario}.js`
);

const scriptPath = path.resolve(
  `${scenarioRoot}/${selectedScenario}.ts`
);

const resultsPath = path.join(
  resultsDirectory,
  'results.json'
);

const summaryPath = path.join(
  reportDirectory,
  'summary.json'
);

const startedAt = new Date().toISOString();

const command =
  `npm run k6:runner -- --scenario ${selectedScenario} --env ${selectedEnvironment} --profile ${profile}` +
  (vusSource === 'cli' ? ` --vus ${vus}` : '');

const metadata: RunMetadata = {
  runId,
  scenario: selectedScenario,
  environment: selectedEnvironment,
  profile,
  baseUrl,
  vus,
  vusSource,
  startedAt,
  status: 'running',
  command,
};

await mkdir(reportDirectory, {
  recursive: true,
});

await mkdir(resultsDirectory, {
  recursive: true,
});

await mkdir(
  path.dirname(bundlePath),
  {
    recursive: true,
  }
);

await writeFile(
  metadataPath,
  JSON.stringify(metadata, null, 2),
  'utf8'
);

console.log('\n========================================');
console.log('CalicoDesk k6 Test Runner');
console.log('========================================');
console.log(`Scenario:    ${selectedScenario}`);
console.log(`Environment: ${selectedEnvironment}`);
console.log(`Profile:     ${profile}`);
console.log(`VUs:         ${vus}`);
console.log(`VU Source:   ${vuSourceLabel(vusSource)}`);
console.log(`Base URL:    ${baseUrl}`);
console.log(`Run ID:      ${runId}`);
console.log('========================================\n');

console.log('Step 1/2: Bundling TypeScript...');

const esbuildCommand =
  process.platform === 'win32'
    ? 'npx.cmd'
    : 'npx';

const esbuildArgs = [
  'esbuild',
  scriptPath,
  '--bundle',
  '--platform=neutral',
  '--target=es2020',
  '--external:k6',
  '--external:k6/*',
  `--outfile=${bundlePath}`,
];

const build = spawn(
  esbuildCommand,
  esbuildArgs,
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
    },
  }
);

build.on('error', async (error) => {
  console.error('\nFailed to start esbuild.');
  console.error(error);

  const failedMetadata: RunMetadata = {
    ...metadata,
    completedAt: new Date().toISOString(),
    status: 'failed',
    exitCode: 1,
  };

  await writeFile(
    metadataPath,
    JSON.stringify(failedMetadata, null, 2),
    'utf8'
  );

  process.exit(1);
});

build.on('exit', async (buildCode) => {
  if (buildCode !== 0) {
    const failedMetadata: RunMetadata = {
      ...metadata,
      completedAt: new Date().toISOString(),
      status: 'failed',
      exitCode: buildCode ?? 1,
    };

    await writeFile(
      metadataPath,
      JSON.stringify(failedMetadata, null, 2),
      'utf8'
    );

    process.exit(buildCode ?? 1);
  }

  console.log(
    '\nTypeScript bundle created successfully.'
  );

  console.log(
    '\nStep 2/2: Running k6...\n'
  );

  const k6Command = 'k6';

  const k6Args = [
    'run',

    '--env',
    `BASE_URL=${baseUrl}`,

    '--env',
    `K6_PROFILE=${profile}`,

    '--env',
    `K6_SCENARIO=${selectedScenario}`,

    '--env',
    `K6_RUN_ID=${runId}`,

    ...(hasOverride
      ? [
          '--env',
          `K6_VUS=${vus}`,
        ]
      : []),

    // Credentials are passed only via the child process environment
    // (k6 --include-system-env-vars defaults to true). Do not pass
    // TEST_USER_* through --env VAR=value — that puts secrets on the
    // process command line.

    '--out',
    `json=${resultsPath}`,

    '--summary-export',
    summaryPath,

    bundlePath,
  ];

  const k6 = spawn(
    k6Command,
    k6Args,
    {
      stdio: 'inherit',

      shell: process.platform === 'win32',

      env: {
        ...process.env,

        TEST_ENV: selectedEnvironment,

        K6_SCENARIO: selectedScenario,

        K6_RUN_ID: runId,

        K6_PROFILE: profile,

        BASE_URL: baseUrl,

        ...(hasOverride
          ? {
              K6_VUS: String(vus),
            }
          : {}),

        ...(selectedScenario === 'authentication' &&
        testUserEmail &&
        testUserPassword
          ? {
              TEST_USER_EMAIL: testUserEmail,
              TEST_USER_PASSWORD: testUserPassword,
            }
          : {}),
      },
    }
  );

  k6.on('error', async (error) => {
    console.error('\nFailed to start k6.');
    console.error(error);

    const failedMetadata: RunMetadata = {
      ...metadata,
      completedAt: new Date().toISOString(),
      status: 'failed',
      exitCode: 1,
    };

    await writeFile(
      metadataPath,
      JSON.stringify(failedMetadata, null, 2),
      'utf8'
    );

    process.exit(1);
  });

  k6.on('exit', async (code) => {
    let k6Failed = code !== 0;
    let failureReasons: string[] = [];

    /*
     * k6 can exit with code 0 even when
     * checks, HTTP requests, or thresholds fail.
     *
     * Therefore, always inspect summary.json
     * and never report PASSED when checks or
     * thresholds failed.
     */
    try {
      const summaryText = await readFile(
        summaryPath,
        'utf8'
      );

      const summary = JSON.parse(summaryText) as K6Summary;

      const evaluation = evaluateK6Summary(summary);

      if (evaluation.failed) {
        k6Failed = true;
        failureReasons = evaluation.reasons;
      }
    } catch (error) {
      console.error(
        '\nWarning: Could not validate k6 summary.'
      );

      console.error(error);

      k6Failed = true;
      failureReasons = [
        'Could not validate k6 summary.json',
      ];
    }

    if (code !== 0 && failureReasons.length === 0) {
      failureReasons = [
        `k6 exited with code ${code ?? 1}`,
      ];
    }

    const status =
      k6Failed
        ? 'failed'
        : 'passed';

    const completedMetadata: RunMetadata = {
      ...metadata,

      completedAt:
        new Date().toISOString(),

      status,

      exitCode:
        k6Failed
          ? (code && code !== 0 ? code : 1)
          : 0,
    };

    await writeFile(
      metadataPath,
      JSON.stringify(
        completedMetadata,
        null,
        2
      ),
      'utf8'
    );

    console.log(
      '\n========================================'
    );

    console.log(
      'k6 Test Run Completed'
    );

    console.log(
      '========================================'
    );

    console.log(
      `Scenario:    ${selectedScenario}`
    );

    console.log(
      `Environment: ${selectedEnvironment}`
    );

    console.log(
      `Profile:     ${profile}`
    );

    console.log(
      `VUs:         ${vus}`
    );

    console.log(
      `VU Source:   ${vuSourceLabel(vusSource)}`
    );

    console.log(
      `Base URL:    ${baseUrl}`
    );

    console.log(
      `Run ID:      ${runId}`
    );

    console.log(
      `Status:      ${status.toUpperCase()}`
    );

    if (failureReasons.length > 0) {
      console.log(
        '\nFailure reasons:'
      );

      for (const reason of failureReasons) {
        console.log(`- ${reason}`);
      }
    }

    console.log(
      '========================================'
    );

    console.log(
      '\nk6 JSON Result:'
    );

    console.log(resultsPath);

    console.log(
      '\nk6 Summary:'
    );

    console.log(summaryPath);

    console.log(
      '\nMetadata:'
    );

    console.log(metadataPath);

    process.exit(
      k6Failed
        ? 1
        : 0
    );
  });
});