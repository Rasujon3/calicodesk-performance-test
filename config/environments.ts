import {
  isTestEnvironment,
  resolveBaseUrl,
  type TestEnvironment,
} from './base-url.js';

interface EnvironmentConfig {
  name: TestEnvironment;
  baseUrl: string;
}

const testEnvironment = process.env.TEST_ENV?.trim();

if (!testEnvironment) {
  throw new Error(
    'TEST_ENV is not defined. Expected one of: local, dev, live.',
  );
}

if (!isTestEnvironment(testEnvironment)) {
  throw new Error(
    `Invalid TEST_ENV: "${testEnvironment}". Expected one of: local, dev, live.`,
  );
}

export const environment: EnvironmentConfig = {
  name: testEnvironment,
  baseUrl: resolveBaseUrl(testEnvironment),
};
