import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { environment } from '../../../config/environments.js';
import {
  FIXTURE_EMBED_URL,
  FIXTURE_ORIGIN,
} from '../fixtures/fixture-config.js';

interface EmbedPlaywrightResult {
  runId: string;
  scenario: 'chat';
  environment: string;
  status: 'passed' | 'failed';
  startedAt: string;
  completedAt: string;
  duration: number;
  message: string;
  fixtureUrl: string;
  loaderUrl: string;
  widgetIframeAttached: boolean;
  widgetReady: boolean;
}

/**
 * Resolves the real CalicoDesk Live Chat installation script URL.
 *
 * The value is environment/workspace specific (the loader derives the tenant
 * from its host, e.g. https://<tenant>.manobik.com/livechat-loader.js), so it
 * is never hardcoded: configure CALICODESK_LIVECHAT_LOADER_URL in .env.
 */
function resolveLiveChatLoaderUrl(): string {
  const configured = process.env.CALICODESK_LIVECHAT_LOADER_URL?.trim();

  if (!configured) {
    throw new Error(
      'CALICODESK_LIVECHAT_LOADER_URL is not configured. Set it in .env ' +
        'before running the chat embed test, e.g. ' +
        'https://<tenant>.manobik.com/livechat-loader.js',
    );
  }

  try {
    new URL(configured);
  } catch {
    throw new Error(
      `Invalid CALICODESK_LIVECHAT_LOADER_URL: ${configured}`,
    );
  }

  return configured;
}

async function writeEmbedResult(
  result: EmbedPlaywrightResult,
): Promise<string> {
  const resultsDirectory = path.resolve(
    `scenarios/chat/results/playwright/${result.environment}/${result.runId}`,
  );

  await mkdir(resultsDirectory, { recursive: true });

  const resultsPath = path.join(resultsDirectory, 'results.json');

  await writeFile(resultsPath, JSON.stringify(result, null, 2), 'utf8');

  return resultsPath;
}

test('chat widget renders in the local embed fixture [@embed]', async ({
  page,
}) => {
  // Dev can be slow: widget bootstrap + iframe render can take a while on a
  // cold connection, so use a generous timeout instead of the default 30s.
  test.setTimeout(180_000);

  const runId = process.env.PLAYWRIGHT_RUN_ID;

  if (!runId) {
    throw new Error(
      'PLAYWRIGHT_RUN_ID is not defined. Playwright config must assign a run ID before tests start.',
    );
  }

  const startedAtDate = new Date();
  const startedAtMs = Date.now();
  let testStatus: 'passed' | 'failed' = 'failed';
  let message = 'Chat widget local embed fixture check failed.';
  let widgetIframeAttached = false;
  let widgetReady = false;

  const loaderUrl = resolveLiveChatLoaderUrl();

  // The fixture is a static external-website embed page; the real
  // installation script URL is supplied as a query parameter so the same
  // fixture works for local/dev/live without hardcoding the loader URL.
  const fixtureUrl = `${FIXTURE_EMBED_URL}?loaderUrl=${encodeURIComponent(loaderUrl)}`;

  try {
    // 1. Load the local embed fixture (served by the fixture static server).
    await page.goto(fixtureUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });

    // The fixture page itself must be valid and self-describing.
    await expect(page.locator('#fixture-status')).toBeAttached();

    // 2. The real loader must inject the widget iframe element.
    const widgetIframe = page.locator('#be-chat-iframe');
    await expect(
      widgetIframe,
      'CalicoDesk chat widget iframe (#be-chat-iframe) should be injected by the real livechat-loader.js',
    ).toBeAttached({
      timeout: 60_000,
    });
    widgetIframeAttached = true;

    console.log(
      `Widget iframe attached from loader: ${await widgetIframe.getAttribute('src')}`,
    );

    // 3. The loader must receive a bootstrap message from the widget app
    //    (documented via window.BeChatReady in the fixture) ...
    await expect(
      page.locator('body'),
      'the loader should call window.BeChatReady after the widget posts its bootstrap message',
    ).toHaveAttribute('data-be-chat-ready', 'true', {
      timeout: 60_000,
    });

    // ... and the widget must visibly render (the loader keeps #be-chat-iframe
    // hidden at 0x0 until the widget bootstraps).
    await expect(
      widgetIframe,
      'CalicoDesk chat widget iframe should become visible after bootstrap',
    ).toBeVisible({
      timeout: 60_000,
    });
    widgetReady = true;

    message =
      `Local embed fixture (${FIXTURE_ORIGIN}) loaded the real CalicoDesk ` +
      'Live Chat installation script; the widget iframe (#be-chat-iframe) ' +
      'attached, bootstrapped, and became visible.';
    testStatus = 'passed';
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const completedAtDate = new Date();

    const result: EmbedPlaywrightResult = {
      runId,
      scenario: 'chat',
      environment: environment.name,
      status: testStatus,
      startedAt: startedAtDate.toISOString(),
      completedAt: completedAtDate.toISOString(),
      duration: Date.now() - startedAtMs,
      message,
      fixtureUrl,
      loaderUrl,
      widgetIframeAttached,
      widgetReady,
    };

    const resultsPath = await writeEmbedResult(result);

    console.log(`JSON result: ${resultsPath}`);
  }
});