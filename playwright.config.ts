import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { environment } from './config/environments.js';

const scenario = process.env.PLAYWRIGHT_SCENARIO ?? 'all';

const environmentName = process.env.TEST_ENV ?? 'local';

const runId =
  process.env.PLAYWRIGHT_RUN_ID ?? 'manual';

const scenarioReportDirectory = path.resolve(
  `scenarios/${scenario}/reports/playwright/${environmentName}/${runId}`
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
        outputFolder: path.join(
          scenarioReportDirectory,
          'html'
        ),
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