import 'dotenv/config';

export type TestEnvironment = 'local' | 'dev' | 'live';

interface EnvironmentConfig {
  name: TestEnvironment;
  baseUrl: string;
}

const environmentUrls: Record<TestEnvironment, string | undefined> = {
  local: process.env.LOCAL_BASE_URL,
  dev: process.env.DEV_BASE_URL,
  live: process.env.LIVE_BASE_URL,
};

const testEnvironment = process.env.TEST_ENV as TestEnvironment | undefined;

if (!testEnvironment) {
  throw new Error(
    'TEST_ENV is not defined. Expected one of: local, dev, live.',
  );
}

if (!['local', 'dev', 'live'].includes(testEnvironment)) {
  throw new Error(
    `Invalid TEST_ENV: "${testEnvironment}". Expected one of: local, dev, live.`,
  );
}

const baseUrl = environmentUrls[testEnvironment];

if (!baseUrl) {
  throw new Error(
    `No URL configured for TEST_ENV="${testEnvironment}". ` +
      `Please configure the corresponding environment URL in .env.`,
  );
}

try {
  new URL(baseUrl);
} catch {
  throw new Error(
    `Invalid URL configured for TEST_ENV="${testEnvironment}": ${baseUrl}`,
  );
}

export const environment: EnvironmentConfig = {
  name: testEnvironment,
  baseUrl: baseUrl.replace(/\/+$/, ''),
};