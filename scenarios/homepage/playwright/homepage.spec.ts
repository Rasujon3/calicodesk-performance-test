import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
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

interface HomepageSummary {
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

interface HomepagePlaywrightResult {
  runId: string;
  scenario: 'homepage';
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

async function writeHomepageResult(
  result: HomepagePlaywrightResult
): Promise<string> {
  const resultsDirectory = path.resolve(
    `scenarios/homepage/results/playwright/${result.environment}/${result.runId}`
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
    JSON.stringify(result, null, 2),
    'utf8'
  );

  return resultsPath;
}

function printHomepageSummary(summary: HomepageSummary): void {
  console.log('\n========== Homepage Playwright Summary ==========');
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

  console.log('=================================================\n');
}

test('homepage loads successfully', async ({ page }) => {
  const runId = process.env.PLAYWRIGHT_RUN_ID;

  if (!runId) {
    throw new Error(
      'PLAYWRIGHT_RUN_ID is not defined. Playwright config must assign a run ID before tests start.',
    );
  }
  const startedAtDate = new Date();
  const startedAtMs = Date.now();

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedResources: FailedResource[] = [];
  const failedRequestUrls = new Set<string>();

  let testStatus: 'passed' | 'failed' = 'failed';
  let pageUrl = environment.baseUrl;
  let httpStatus: number | null = null;
  let wallClockLoadMs = 0;
  let navigationTimings: NavigationTimings | null = null;

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
      url,
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
      url,
      reason: `HTTP ${status}`,
    });
  });

  try {
    const navigationStartedAt = Date.now();

    const response = await page.goto('/', {
      waitUntil: 'load',
    });

    wallClockLoadMs = Date.now() - navigationStartedAt;
    pageUrl = page.url();
    httpStatus = response?.status() ?? null;

    navigationTimings = await page.evaluate((): NavigationTimings | null => {
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

    const summary: HomepageSummary = {
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

    printHomepageSummary(summary);

    expect(response, 'homepage should return an HTTP response').not.toBeNull();
    expect(response?.status(), 'homepage should return HTTP 200').toBe(200);

    await expect(
      page.getByRole('heading', {
        name: 'Live Chat, AI Chatbot & Helpdesk Software for Websites',
        level: 1,
      }),
      'homepage heading should be visible',
    ).toBeVisible();

    expect(
      pageErrors,
      'homepage should not throw uncaught JavaScript errors',
    ).toEqual([]);

    testStatus = 'passed';
  } finally {
    const completedAtDate = new Date();

    const result: HomepagePlaywrightResult = {
      runId,
      scenario: 'homepage',
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

    const resultsPath = await writeHomepageResult(result);

    console.log(`JSON result: ${resultsPath}`);
  }
});
