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
CalicoDesk Performance Test Runner

Usage:
  npm run test:runner -- --scenario <scenario> --env <environment>

Scenarios:
  homepage
  authentication

Environments:
  local
  dev
  live

Examples:
  npm run test:runner -- --scenario homepage --env local
  npm run test:runner -- --scenario homepage --env dev
  npm run test:runner -- --scenario homepage --env live

  npm run test:runner -- --scenario authentication --env local
  npm run test:runner -- --scenario authentication --env dev
  npm run test:runner -- --scenario authentication --env live
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

const reportDirectory = path.resolve(
  `scenarios/${selectedScenario}/reports/playwright/${selectedEnvironment}/${runId}`
);

const metadataPath = path.join(
  reportDirectory,
  'metadata.json'
);

const startedAt = new Date().toISOString();

const command =
  `npm run test:runner -- --scenario ${selectedScenario} --env ${selectedEnvironment}`;

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

await writeFile(
  metadataPath,
  JSON.stringify(metadata, null, 2),
  'utf8'
);

console.log('\n========================================');
console.log('CalicoDesk Performance Test Runner');
console.log('========================================');
console.log(`Scenario:    ${selectedScenario}`);
console.log(`Environment: ${selectedEnvironment}`);
console.log(`Run ID:      ${runId}`);
console.log('========================================\n');

const playwrightCommand =
  process.platform === 'win32'
    ? 'npx.cmd'
    : 'npx';

const playwrightArgs = [
  'playwright',
  'test',
  '--project',
  selectedScenario,
];

const child = spawn(playwrightCommand, playwrightArgs, {
  stdio: 'inherit',

  shell: process.platform === 'win32',

  env: {
    ...process.env,

    TEST_ENV: selectedEnvironment,

    PLAYWRIGHT_SCENARIO: selectedScenario,

    PLAYWRIGHT_RUN_ID: runId,
  },
});

child.on('error', async (error) => {
  console.error('\nFailed to start Playwright.');
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

child.on('exit', async (code) => {
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
  console.log('Test Run Completed');
  console.log('========================================');
  console.log(`Scenario:    ${selectedScenario}`);
  console.log(`Environment: ${selectedEnvironment}`);
  console.log(`Run ID:      ${runId}`);
  console.log(`Status:      ${status.toUpperCase()}`);
  console.log('========================================');

  console.log('\nHTML Report:');
  console.log(
    path.join(reportDirectory, 'html')
  );

  console.log('\nJSON Result:');
  console.log(
    path.join(reportDirectory, 'results.json')
  );

  console.log('\nMetadata:');
  console.log(metadataPath);

  process.exit(code ?? 1);
});