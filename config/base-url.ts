import 'dotenv/config';

export type TestEnvironment = 'local' | 'dev' | 'live';

export const testEnvironments: TestEnvironment[] = [
  'local',
  'dev',
  'live',
];

const baseUrlEnvVars: Record<TestEnvironment, string> = {
  local: 'LOCAL_BASE_URL',
  dev: 'DEV_BASE_URL',
  live: 'LIVE_BASE_URL',
};

export function isTestEnvironment(
  value: string
): value is TestEnvironment {
  return testEnvironments.includes(value as TestEnvironment);
}

export function resolveBaseUrl(
  environment: TestEnvironment
): string {
  const envVar = baseUrlEnvVars[environment];
  const configuredUrl = process.env[envVar]?.trim();

  if (!configuredUrl) {
    throw new Error(
      `${envVar} is not configured for environment "${environment}". ` +
        `Set ${envVar} in .env. Do not rely on a default URL.`
    );
  }

  try {
    new URL(configuredUrl);
  } catch {
    throw new Error(
      `Invalid ${envVar} for environment "${environment}": ${configuredUrl}`
    );
  }

  return configuredUrl.replace(/\/+$/, '');
}
