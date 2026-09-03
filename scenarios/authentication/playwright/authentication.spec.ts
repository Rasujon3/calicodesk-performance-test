import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { environment } from '../../../config/environments.js';

interface FailedResource {
  method: string;
  url: string;
  reason: string;
}

interface NavigationTimings {
  dnsMs: number;
  tcpMs: number;
  ttfbMs: number;
  downloadMs: number;
  domContentLoadedMs: number;
  loadEventMs: number;
}

interface AuthenticationSummary {
  runId: string;
  environment: string;
  url: string;
  status: number | null;
  wallClockLoadMs: number;
  navigationTimings: NavigationTimings | null;
  pageErrors: string[];
  consoleErrors: string[];
  failedResources: FailedResource[];
}

interface AuthenticationPlaywrightResult {
  runId: string;
  scenario: 'authentication';
  environment: string;
  url: string;
  status: 'passed' | 'failed';
  startedAt: string;
  completedAt: string;
  duration: number;
  httpStatus: number | null;
  javascriptErrors: string[];
  consoleErrors: string[];
  failedResources: FailedResource[];
  performanceTiming: {
    wallClockLoadMs: number;
    navigation: NavigationTimings | null;
  };
}

function getRequiredCredential(name: 'TEST_USER_EMAIL' | 'TEST_USER_PASSWORD'): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is not configured. Set it in .env before running the authentication Playwright scenario.`
    );
  }

  return value;
}

/** Redact credential-bearing query params before console/results persistence. */
function sanitizeUrlForReporting(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const sensitiveKeys = [
      'email',
      'password',
      'token',
      'access_token',
      'accessToken',
      'authorization',
    ];

    for (const key of sensitiveKeys) {
      if (parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }

    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

async function writeAuthenticationResult(
  result: AuthenticationPlaywrightResult
): Promise<string> {
  const resultsDirectory = path.resolve(
    `scenarios/authentication/results/playwright/${result.environment}/${result.runId}`
  );

  await mkdir(resultsDirectory, {
    recursive: true,
  });

  const resultsPath = path.join(
    resultsDirectory,
    'results.json'
  );

  await writeFile(
    resultsPath,
    JSON.stringify(
      {
        ...result,
        url: sanitizeUrlForReporting(result.url),
        failedResources: result.failedResources.map((resource) => ({
          ...resource,
          url: sanitizeUrlForReporting(resource.url),
        })),
      },
      null,
      2
    ),
    'utf8'
  );

  return resultsPath;
}

function printAuthenticationSummary(summary: AuthenticationSummary): void {
  console.log('\n========== Authentication Playwright Summary ==========');
  console.log(`Run ID:          ${summary.runId}`);
  console.log(`Environment:     ${summary.environment}`);
  console.log(`URL:             ${summary.url}`);
  console.log(`HTTP status:     ${summary.status ?? 'no response'}`);
  console.log(`Wall-clock load: ${summary.wallClockLoadMs} ms`);

  if (summary.navigationTimings) {
    console.log('Navigation timing:');
    console.log(`  DNS:                ${summary.navigationTimings.dnsMs.toFixed(1)} ms`);
    console.log(`  TCP:                ${summary.navigationTimings.tcpMs.toFixed(1)} ms`);
    console.log(`  TTFB:               ${summary.navigationTimings.ttfbMs.toFixed(1)} ms`);
    console.log(`  Download:           ${summary.navigationTimings.downloadMs.toFixed(1)} ms`);
    console.log(`  DOMContentLoaded:   ${summary.navigationTimings.domContentLoadedMs.toFixed(1)} ms`);
    console.log(`  Load event:         ${summary.navigationTimings.loadEventMs.toFixed(1)} ms`);
  } else {
    console.log('Navigation timing:  not available');
  }

  console.log(`JS page errors:  ${summary.pageErrors.length}`);
  for (const message of summary.pageErrors) {
    console.log(`  - ${message}`);
  }

  console.log(`Console errors:  ${summary.consoleErrors.length}`);
  for (const message of summary.consoleErrors) {
    console.log(`  - ${message}`);
  }

  console.log(`Failed resources: ${summary.failedResources.length}`);
  for (const resource of summary.failedResources) {
    console.log(`  - ${resource.method} ${resource.url} (${resource.reason})`);
  }

  console.log('=======================================================\n');
}

async function confirmRecaptchaIfPresent(page: Page): Promise<void> {
  const recaptchaPrompt = page.getByText(/let us know you're human/i);

  try {
    await expect(recaptchaPrompt).toBeVisible({
      timeout: 5_000,
    });
  } catch {
    return;
  }

  await page
    .locator('iframe[src*="recaptcha"], iframe[title="reCAPTCHA"]')
    .first()
    .waitFor({
      timeout: 10_000,
    })
    .catch(() => undefined);

  for (const frame of page.frames()) {
    const checkbox = frame.getByRole('checkbox', {
      name: /i'm not a robot/i,
    });

    if ((await checkbox.count()) === 0) {
      continue;
    }

    await checkbox.click();

    try {
      await expect(checkbox).toBeChecked({
        timeout: 10_000,
      });

      return;
    } catch {
      break;
    }
  }

  throw new Error(
    'Login is blocked by Google reCAPTCHA. Disable captcha on the login page for the test environment, or configure Google reCAPTCHA test keys, then re-run the authentication scenario.'
  );
}

async function collectNavigationTimings(
  page: Page
): Promise<NavigationTimings | null> {
  return page.evaluate((): NavigationTimings | null => {
    const perf = (
      globalThis as unknown as {
        performance?: {
          getEntriesByType: (
            type: string
          ) => Array<Record<string, number>>;
        };
      }
    ).performance;

    const navigation = perf?.getEntriesByType('navigation')[0];

    if (!navigation) {
      return null;
    }

    return {
      dnsMs:
        navigation.domainLookupEnd - navigation.domainLookupStart,
      tcpMs: navigation.connectEnd - navigation.connectStart,
      ttfbMs: navigation.responseStart - navigation.requestStart,
      downloadMs:
        navigation.responseEnd - navigation.responseStart,
      domContentLoadedMs:
        navigation.domContentLoadedEventEnd - navigation.startTime,
      loadEventMs:
        navigation.loadEventEnd - navigation.startTime,
    };
  });
}

test('authentication login and logout lifecycle succeeds', async ({ page }) => {
  test.setTimeout(120_000);

  const runId = process.env.PLAYWRIGHT_RUN_ID;

  if (!runId) {
    throw new Error(
      'PLAYWRIGHT_RUN_ID is not defined. Playwright config must assign a run ID before tests start.',
    );
  }

  let testStatus: 'passed' | 'failed' = 'failed';
  let pageUrl = `${environment.baseUrl}/login`;
  let httpStatus: number | null = null;
  let wallClockLoadMs = 0;
  let navigationTimings: NavigationTimings | null = null;

  const startedAtDate = new Date();
  const startedAtMs = Date.now();

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedResources: FailedResource[] = [];
  const failedRequestUrls = new Set<string>();

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  page.on('requestfailed', (request) => {
    const url = request.url();

    if (failedRequestUrls.has(url)) {
      return;
    }

    failedRequestUrls.add(url);

    failedResources.push({
      method: request.method(),
      url: sanitizeUrlForReporting(url),
      reason: request.failure()?.errorText ?? 'request failed',
    });
  });

  page.on('response', (response) => {
    const status = response.status();

    if (status < 400) {
      return;
    }

    const url = response.url();

    if (failedRequestUrls.has(url)) {
      return;
    }

    failedRequestUrls.add(url);

    failedResources.push({
      method: response.request().method(),
      url: sanitizeUrlForReporting(url),
      reason: `HTTP ${status}`,
    });
  });

  try {
    const navigationStartedAt = Date.now();

    const response = await page.goto('/login', {
      waitUntil: 'load',
    });

    wallClockLoadMs = Date.now() - navigationStartedAt;
    pageUrl = sanitizeUrlForReporting(page.url());
    httpStatus = response?.status() ?? null;
    navigationTimings = await collectNavigationTimings(page);

    const acceptAll = page.getByRole('button', { name: 'Accept All' });

    if (await acceptAll.isVisible()) {
      await acceptAll.click();
    }

    const summary: AuthenticationSummary = {
      runId,
      environment: environment.name,
      url: pageUrl,
      status: httpStatus,
      wallClockLoadMs,
      navigationTimings,
      pageErrors,
      consoleErrors,
      failedResources,
    };

    printAuthenticationSummary(summary);

    expect(response, 'login page should return an HTTP response').not.toBeNull();
    expect(response?.status(), 'login page should return HTTP 200').toBe(200);

    await expect(
      page.getByRole('heading', {
        name: 'Welcome back',
      }),
      'login heading should be visible',
    ).toBeVisible();

    const emailField = page.getByRole('textbox', { name: 'Email' });
    const continueButton = page.getByRole('button', {
      name: 'Continue',
      exact: true,
    });

    await expect(emailField, 'email field should be visible').toBeVisible();
    await expect(continueButton, 'continue button should be visible').toBeVisible();

    const email = getRequiredCredential('TEST_USER_EMAIL');
    const password = getRequiredCredential('TEST_USER_PASSWORD');

    await emailField.fill(email);
    await continueButton.click();

    await page.waitForURL(/step=password/, {
      timeout: 30_000,
    });

    await expect(
      page.getByRole('heading', {
        name: 'Welcome back',
      }),
      'password step should finish loading',
    ).toBeVisible({
      timeout: 30_000,
    });

    const passwordStepAcceptAll = page.getByRole('button', {
      name: 'Accept All',
    });

    if (await passwordStepAcceptAll.isVisible()) {
      await passwordStepAcceptAll.click();
    }

    const passwordField = page.getByRole('textbox', {
      name: 'Password',
    });

    await expect(
      passwordField,
      'password field should appear after submitting a valid email',
    ).toBeVisible({
      timeout: 30_000,
    });

    await passwordField.fill(password);
    await confirmRecaptchaIfPresent(page);

    await page.getByRole('button', {
      name: 'Sign in',
      exact: true,
    }).click();

    await expect(
      page,
      'successful login should navigate to the dashboard',
    ).toHaveURL(/\/dashboard/, {
      timeout: 30_000,
    });

    pageUrl = sanitizeUrlForReporting(page.url());

    const authMenuToggle = page.getByRole('button', {
      name: 'toggle authentication menu',
    });

    await expect(
      authMenuToggle,
      'authenticated dashboard should show the authentication menu control',
    ).toBeVisible({
      timeout: 30_000,
    });

    await authMenuToggle.click();

    const logoutMenuItem = page.getByRole('menuitem', {
      name: 'Log out',
    });

    await expect(
      logoutMenuItem,
      'authentication menu should expose Log out',
    ).toBeVisible({
      timeout: 10_000,
    });

    // Observe the logout request the UI already makes (do not invent a separate API call).
    const logoutResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/api/v1/auth/logout'),
      {
        timeout: 30_000,
      },
    );

    await logoutMenuItem.click();

    const logoutResponse = await logoutResponsePromise;

    expect(
      logoutResponse.ok(),
      'UI logout request should succeed',
    ).toBeTruthy();

    await expect(
      page,
      'logout should leave the dashboard (app redirects to /)',
    ).not.toHaveURL(/\/dashboard/, {
      timeout: 30_000,
    });

    await expect(
      page,
      'logout should navigate to the app home path',
    ).toHaveURL((url) => {
      const { pathname } = new URL(url);
      return pathname === '/' || pathname === '';
    }, {
      timeout: 30_000,
    });

    await expect(
      authMenuToggle,
      'dashboard authentication menu should be gone after logout',
    ).toHaveCount(0);

    // After SPA logout the help-center/home navbar shows guest Login (not a full reload,
    // which can rehydrate a leftover local HTTP session cookie).
    const loginLink = page.getByRole('link', {
      name: 'Login',
      exact: true,
    });

    await expect(
      loginLink,
      'guest Login control should be visible after logout',
    ).toBeVisible({
      timeout: 30_000,
    });

    await loginLink.click();

    await expect(
      page,
      'Login should open the login page',
    ).toHaveURL(/\/login/, {
      timeout: 30_000,
    });

    await expect(
      page.getByRole('heading', {
        name: 'Welcome back',
      }),
      'login form should be visible after logout',
    ).toBeVisible({
      timeout: 30_000,
    });

    await expect(
      page.getByRole('textbox', {
        name: 'Email',
      }),
      'login email field should be visible after logout',
    ).toBeVisible({
      timeout: 30_000,
    });

    pageUrl = sanitizeUrlForReporting(page.url());

    expect(
      pageErrors,
      'authentication lifecycle should not throw uncaught JavaScript errors',
    ).toEqual([]);

    testStatus = 'passed';
  } finally {
    const completedAtDate = new Date();

    const result: AuthenticationPlaywrightResult = {
      runId,
      scenario: 'authentication',
      environment: environment.name,
      url: pageUrl,
      status: testStatus,
      startedAt: startedAtDate.toISOString(),
      completedAt: completedAtDate.toISOString(),
      duration: Date.now() - startedAtMs,
      httpStatus,
      javascriptErrors: pageErrors,
      consoleErrors,
      failedResources,
      performanceTiming: {
        wallClockLoadMs,
        navigation: navigationTimings,
      },
    };

    const resultsPath = await writeAuthenticationResult(result);

    console.log(`JSON result: ${resultsPath}`);
  }
});
