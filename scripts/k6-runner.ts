import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

type Scenario = 'homepage' | 'authentication';
type Environment = 'local' | 'dev' | 'live';

interface RunMetadata {
  runId: string;
  scenario: Scenario;
  environment: Environment;
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
  npm run k6:runner -- --scenario <scenario> --env <environment>

Scenarios:
  homepage
  authentication

Environments:
  local
  dev
  live

Examples:
  npm run k6:runner -- --scenario homepage --env local
  npm run k6:runner -- --scenario homepage --env dev
  npm run k6:runner -- --scenario homepage --env live

  npm run k6:runner -- --scenario authentication --env local
  npm run k6:runner -- --scenario authentication --env dev
  npm run k6:runner -- --scenario authentication --env live
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

const scenario = getArgument('--scenario');
const environment = getArgument('--env');
const profile = getArgument('--profile') ?? 'smoke';

const validProfiles = [
  'smoke',
  'load',
  'stress',
  'spike',
  'soak',
  'rps',
];

if (!validProfiles.includes(profile)) {
  console.error(`Invalid profile: ${profile}`);
  process.exit(1);
}

if (!scenario || !environment) {
  console.error('\nMissing required arguments.\n');

  printUsage();

  process.exit(1);
}

if (!validScenarios.includes(scenario as Scenario)) {
  console.error(`\nInvalid scenario: ${scenario}\n`);

  console.error(
    `Allowed scenarios: ${validScenarios.join(', ')}`
  );

  process.exit(1);
}

if (!validEnvironments.includes(environment as Environment)) {
  console.error(`\nInvalid environment: ${environment}\n`);

  console.error(
    `Allowed environments: ${validEnvironments.join(', ')}`
  );

  process.exit(1);
}

const selectedScenario = scenario as Scenario;
const selectedEnvironment = environment as Environment;

const runId = generateRunId();

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

const startedAt = new Date().toISOString();

const command =
  `npm run k6:runner -- --scenario ${selectedScenario} --env ${selectedEnvironment}`;

const metadata: RunMetadata = {
  runId,
  scenario: selectedScenario,
  environment: selectedEnvironment,
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

await mkdir(path.dirname(bundlePath), {
  recursive: true,
});

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
console.log(`Profile: ${profile}`);
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

const build = spawn(esbuildCommand, esbuildArgs, {
  stdio: 'inherit',

  shell: process.platform === 'win32',

  env: {
    ...process.env,
  },
});

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

  console.log('\nTypeScript bundle created successfully.');

  console.log('\nStep 2/2: Running k6...\n');

  const k6Command = 'k6';

  const k6Args = [
    'run',

    '--out',
    `json=${path.join(resultsDirectory, 'results.json')}`,

    '--summary-export',
    path.join(reportDirectory, 'summary.json'),

    bundlePath,
  ];

  const k6 = spawn(k6Command, k6Args, {
    stdio: 'inherit',

    shell: process.platform === 'win32',

    env: {
      ...process.env,

      TEST_ENV: selectedEnvironment,

      K6_SCENARIO: selectedScenario,

      K6_RUN_ID: runId,

      BASE_URL:
        process.env[
          `${selectedEnvironment.toUpperCase()}_BASE_URL`
        ] ?? '',
    },
  });

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
    const status = code === 0 ? 'passed' : 'failed';

    const completedMetadata: RunMetadata = {
      ...metadata,
      completedAt: new Date().toISOString(),
      status,
      exitCode: code ?? 1,
    };

    await writeFile(
      metadataPath,
      JSON.stringify(completedMetadata, null, 2),
      'utf8'
    );

    console.log('\n========================================');
    console.log('k6 Test Run Completed');
    console.log('========================================');
    console.log(`Scenario:    ${selectedScenario}`);
    console.log(`Environment: ${selectedEnvironment}`);
    console.log(`Profile: ${profile}`);
    console.log(`Run ID:      ${runId}`);
    console.log(`Status:      ${status.toUpperCase()}`);
    console.log('========================================');

    console.log('\nk6 JSON Result:');
    console.log(
      path.join(resultsDirectory, 'results.json')
    );

    console.log('\nk6 Summary:');
    console.log(
      path.join(reportDirectory, 'summary.json')
    );

    console.log('\nMetadata:');
    console.log(metadataPath);

    process.exit(code ?? 1);
  });
});