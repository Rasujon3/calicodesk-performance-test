import 'dotenv/config';

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

type Scenario = 'homepage' | 'authentication';

type Environment = 'local' | 'dev' | 'live';

type Profile =
  | 'smoke'
  | 'load'
  | 'stress'
  | 'spike'
  | 'soak'
  | 'rps';

interface RunMetadata {
  runId: string;
  scenario: Scenario;
  environment: Environment;
  profile: Profile;
  baseUrl: string;
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

const validEnvironments: Environment[] = [
  'local',
  'dev',
  'live',
];

const validProfiles: Profile[] = [
  'smoke',
  'load',
  'stress',
  'spike',
  'soak',
  'rps',
];

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
  npm run k6:runner -- --scenario <scenario> --env <environment> --profile <profile>

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

Examples:

  npm run k6:runner -- --scenario homepage --env local --profile smoke

  npm run k6:runner -- --scenario homepage --env dev --profile load

  npm run k6:runner -- --scenario homepage --env live --profile smoke

  npm run k6:runner -- --scenario authentication --env dev --profile smoke
`);
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

if (!validEnvironments.includes(environment as Environment)) {
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

const runId = generateRunId();

const baseUrl =
  process.env[
    `${selectedEnvironment.toUpperCase()}_BASE_URL`
  ] ?? '';

if (!baseUrl) {
  console.log('baseUrl', baseUrl);
  
  fail(
    `BASE_URL is not configured for environment: ${selectedEnvironment}`
  );
}

console.log(`Base URL: ${baseUrl}`);

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
  `npm run k6:runner -- --scenario ${selectedScenario} --env ${selectedEnvironment} --profile ${profile}`;

const metadata: RunMetadata = {
  runId,
  scenario: selectedScenario,
  environment: selectedEnvironment,
  profile,
  baseUrl,
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