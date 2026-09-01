import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { environment } from './config/environments.js';
import { resolvePlaywrightRunId } from './config/run-id.js';

const validScenarios = ['homepage', 'authentication'] as const;

function resolveScenario(): string {
  if (
    process.env.PLAYWRIGHT_SCENARIO &&
    validScenarios.includes(
      process.env.PLAYWRIGHT_SCENARIO as (typeof validScenarios)[number]
    )
  ) {
    return process.env.PLAYWRIGHT_SCENARIO;
  }

  const projectIndex = process.argv.findIndex(
    (argument) => argument === '--project' || argument === '-p'
  );

  if (projectIndex !== -1) {
    const projectName = process.argv[projectIndex + 1];

    if (
      projectName &&
      validScenarios.includes(
        projectName as (typeof validScenarios)[number]
      )
    ) {
      return projectName;
    }
  }

  return 'homepage';
}

const scenario = resolveScenario();

const environmentName = process.env.TEST_ENV ?? 'local';

const runId = resolvePlaywrightRunId();

const scenarioReportDirectory = path.resolve(
  `scenarios/${scenario}/reports/playwright/${environmentName}/${runId}`
);

const htmlReportDirectory = path.resolve(
  `scenarios/${scenario}/reports/playwright/html`
);

export default defineConfig({
  testDir: './scenarios',

  fullyParallel: true,

  forbidOnly: process.env.CI === 'true',

  retries: process.env.CI === 'true' ? 1 : 0,

  workers: process.env.CI === 'true' ? 2 : undefined,

  timeout: 30_000,

  expect: {
    timeout: 5_000,
  },

  reporter: [
    [
      'html',
      {
        outputFolder: htmlReportDirectory,
        open: 'never',
      },
    ],

    [
      'json',
      {
        outputFile: path.join(
          scenarioReportDirectory,
          'results.json'
        ),
      },
    ],

    ['list'],
  ],

  use: {
    baseURL: environment.baseUrl,

    trace: 'retain-on-failure',

    screenshot: 'only-on-failure',

    video: 'retain-on-failure',

    navigationTimeout: 30_000,

    actionTimeout: 10_000,

    ignoreHTTPSErrors: false,
  },

  projects: [
    {
      name: 'homepage',

      testMatch: '**/homepage/playwright/**/*.spec.ts',

      use: {
        ...devices['Desktop Chrome'],
      },
    },

    {
      name: 'authentication',

      testMatch:
        '**/authentication/playwright/**/*.spec.ts',

      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});