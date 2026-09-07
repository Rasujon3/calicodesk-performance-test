/**
 * Embed-fixture widget helpers for the two-actor chat scenario.
 *
 * These helpers target the **local embed fixture** served by the fixture static
 * server on `127.0.0.1:4177`.  The widget pipeline is straightforward:
 *
 *   page → #be-chat-iframe (CalicoDesk widget)
 *
 * This is simpler than the W3Schools pipeline which nests an extra
 * `iframeResult` preview frame.
 *
 * All helpers are condition-based — no fixed sleeps, no coordinate clicks,
 * no guessed iframe names.
 */

import { randomBytes } from 'node:crypto';
import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test';
import {
  CHAT_IFRAME_SELECTOR,
  locateMessageInput,
  locateSendControl,
  typeIntoInput,
  waitForMessageInWidgetFrame,
} from './chat-widget.js';
import {
  FIXTURE_EMBED_URL,
} from '../../scenarios/chat/fixtures/fixture-config.js';

// ---------------------------------------------------------------------------
// Unique message generation
// ---------------------------------------------------------------------------

let visitorMessageCounter = 0;

/**
 * Generates a deterministic, run-unique visitor message.
 *
 * Format: `CalicoDesk Chat Test <timestamp>-<counter>-<hex4>`
 *
 * The per-process counter guarantees uniqueness even when two messages are
 * generated in the same millisecond.  Old conversations cannot accidentally
 * satisfy assertions because the timestamp changes on every test run.
 */
export function generateVisitorMessage(): string {
  visitorMessageCounter += 1;
  const nonce = `${Date.now()}-${visitorMessageCounter}-${randomBytes(2).toString('hex')}`;
  return `CalicoDesk Chat Test ${nonce}`;
}

// ---------------------------------------------------------------------------
// Loader URL resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the real CalicoDesk Live Chat installation script URL.
 *
 * Configured via `CALICODESK_LIVECHAT_LOADER_URL` in `.env`.  Never hardcoded.
 */
function resolveLiveChatLoaderUrl(): string {
  const configured = process.env.CALICODESK_LIVECHAT_LOADER_URL?.trim();

  if (!configured) {
    throw new Error(
      'CALICODESK_LIVECHAT_LOADER_URL is not configured. Set it in .env before running the chat embed test, e.g. ' +
        'https://<tenant>.manobik.com/livechat-loader.js',
    );
  }

  try {
    new URL(configured);
  } catch {
    throw new Error(`Invalid CALICODESK_LIVECHAT_LOADER_URL: ${configured}`);
  }

  return configured;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Opens the local embed fixture in the given page.
 *
 * The fixture is a static HTML page served by the fixture static server
 * (`127.0.0.1:4177`).  The real CalicoDesk `livechat-loader.js` URL is
 * passed as a query parameter so the same fixture works across environments.
 *
 * Returns the full fixture URL that was loaded.
 */
export async function openEmbedFixture(page: Page): Promise<string> {
  const loaderUrl = resolveLiveChatLoaderUrl();
  const fixtureUrl = `${FIXTURE_EMBED_URL}?loaderUrl=${encodeURIComponent(loaderUrl)}`;

  await page.goto(fixtureUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });

  return fixtureUrl;
}

// ---------------------------------------------------------------------------
// Widget frame helpers
// ---------------------------------------------------------------------------

/**
 * Returns a `FrameLocator` for the chat widget iframe inside the embed
 * fixture.
 *
 * Pipeline: `page → #be-chat-iframe` (one frame boundary only).
 *
 * Unlike the W3Schools pipeline there is no intermediate preview iframe.
 */
export function getEmbedWidgetFrame(page: Page): FrameLocator {
  return page.frameLocator(CHAT_IFRAME_SELECTOR);
}

/**
 * Waits for the embed fixture's chat widget to fully bootstrap and render.
 *
 * Condition-based — no fixed sleeps.  Verifies four conditions in order:
 * 1. The fixture `#fixture-status` element is attached.
 * 2. The `#be-chat-iframe` element is injected by the loader script.
 * 3. `window.BeChatReady` fires (signalled via `data-be-chat-ready="true"`).
 * 4. The widget iframe becomes visible (loader keeps it hidden until ready).
 */
export async function waitEmbedWidgetReady(
  page: Page,
  timeoutMs = 60_000,
): Promise<void> {
  await expect(
    page.locator('#fixture-status'),
    'fixture status element should be attached',
  ).toBeAttached({ timeout: 30_000 });

  const widgetIframe = page.locator(CHAT_IFRAME_SELECTOR);

  await expect(
    widgetIframe,
    'CalicoDesk chat widget iframe (#be-chat-iframe) should be injected by the real livechat-loader.js',
  ).toBeAttached({ timeout: timeoutMs });

  await expect(
    page.locator('body'),
    'the loader should call window.BeChatReady after the widget posts its bootstrap message',
  ).toHaveAttribute('data-be-chat-ready', 'true', { timeout: timeoutMs });

  await expect(
    widgetIframe,
    'CalicoDesk chat widget iframe should become visible after bootstrap',
  ).toBeVisible({ timeout: timeoutMs });
}

// ---------------------------------------------------------------------------
// Widget interaction helpers
// ---------------------------------------------------------------------------

/**
 * Opens the chat widget panel inside the embed fixture and ensures a
 * conversation form (textarea) is visible.
 *
 * Handles two widget states:
 * 1. **Fresh widget** — shows a "Send us a message" CTA on the home panel.
 * 2. **Existing conversations** — the widget server tracks conversations by
 *    `embedParentOrigin`.  When previous test runs created conversations, the
 *    home panel shows a "Recent message" card instead of the CTA.  This
 *    helper detects and clicks the conversation card to enter it.
 *
 * All waits are condition-based (no fixed sleeps).
 */
export async function openVisitorWidget(widget: FrameLocator): Promise<string> {
  // Phase 1 — Wait for the widget to be interactive.
  await expect(
    widget.locator('button[class*="chat-toggle" i]').first(),
    'chat widget launcher button should be visible before opening',
  ).toBeVisible({ timeout: 30_000 });

  const textarea = widget
    .locator('textarea[placeholder*="message" i]')
    .first();
  const sendUsMessage = widget
    .locator('a[href="/lc/widget/conversations/new"]')
    .first();

  // Phase 2a — Textarea already visible (conversation form open).
  try {
    await textarea.waitFor({ state: 'visible', timeout: 2_000 });
    return 'conversation form already open (message textarea visible)';
  } catch { /* proceed */ }

  // Phase 2b — "Send us a message" already visible.
  try {
    await sendUsMessage.waitFor({ state: 'visible', timeout: 2_000 });
    await sendUsMessage.click();
    return 'clicked "Send us a message"';
  } catch { /* proceed */ }

  // Phase 3 — Click the launcher to open the home panel.
  const launcher = widget
    .locator('button[class*="chat-toggle" i]')
    .first();
  await launcher.click();

  // Phase 4 — Fresh widget: "Send us a message" link after launcher.
  try {
    await sendUsMessage.waitFor({ state: 'visible', timeout: 10_000 });
    await sendUsMessage.click();
    return 'launcher then "Send us a message"';
  } catch { /* widget may show existing conversations */ }

  // Phase 5 — Existing conversations: click the conversation card.
  // When previous test runs created conversations via the same
  // embedParentOrigin, the widget home panel shows a "Recent message"
  // card instead of "Send us a message".  Clicking the card opens the
  // existing conversation where the textarea becomes visible.
  const conversationCardCandidates: Array<{
    description: string;
    locator: Locator;
  }> = [
    {
      description: 'a[href*="conversation"]',
      locator: widget.locator('a[href*="conversation"]').first(),
    },
    {
      description: '[class*="recent" i]',
      locator: widget.locator('[class*="recent" i]').first(),
    },
    {
      description: 'button:has-text("Visitor")',
      locator: widget.locator('button:has-text("Visitor")').first(),
    },
    {
      description: 'text=Visitor',
      locator: widget.locator('text=Visitor').first(),
    },
  ];

  for (const candidate of conversationCardCandidates) {
    try {
      await candidate.locator.waitFor({ state: 'visible', timeout: 5_000 });
      await candidate.locator.click();
      await textarea.waitFor({ state: 'visible', timeout: 10_000 });
      return `opened existing conversation via ${candidate.description}`;
    } catch { /* try next */ }
  }

  // Phase 6 — Panel candidates (widgets that skip the home panel).
  for (const selector of [
    '[data-testid*="chat-panel" i], [data-testid*="chat-window" i]',
    '[class*="chat-panel" i], [class*="chat-window" i]',
    '[role="dialog"]',
  ]) {
    try {
      await widget.locator(selector).first().waitFor({
        state: 'visible',
        timeout: 5_000,
      });
      return `panel opened via launcher (${selector})`;
    } catch { /* try next */ }
  }

  throw new Error(
    `Chat widget launcher was clicked but could not open a conversation. ` +
      `Tried: "Send us a message", conversation card candidates, and panel candidates.`,
  );
}

/**
 * Locates the message input (textarea / contenteditable / text input) inside
 * the visitor's chat widget.  Returns the visible locator and a description
 * of which selector matched.
 */
export async function locateVisitorInput(
  widget: FrameLocator,
): Promise<{ element: Locator; description: string }> {
  return locateMessageInput(widget);
}

/**
 * Locates the send / submit control inside the visitor's chat widget.
 * Returns the visible locator and a description of which selector matched.
 */
export async function locateVisitorSendControl(
  widget: FrameLocator,
): Promise<{ element: Locator; description: string }> {
  return locateSendControl(widget);
}

// ---------------------------------------------------------------------------
// Send message
// ---------------------------------------------------------------------------

export interface SendVisitorMessageResult {
  /** The exact message text that was sent. */
  message: string;
  /** Description of the input locator that was used. */
  messageInputLocator: string;
  /** Description of the send-control locator that was used. */
  sendControlLocator: string;
}

/**
 * Types a unique visitor message into the chat widget input, sends it, and
 * verifies it appears as a sent bubble in the conversation.
 *
 * Opens the chat panel first (6-phase fallback).  Use this for the **first**
 * message when the panel may not yet be open.
 *
 * Condition-based — no fixed sleeps.  Uses `typeIntoInput` for real
 * keystrokes (React's `onChange` picks up input events reliably) and
 * `waitForMessageInWidgetFrame` to confirm the bubble is visible.
 */
export async function sendVisitorMessage(
  page: Page,
  message: string,
): Promise<SendVisitorMessageResult> {
  const widget = getEmbedWidgetFrame(page);

  // Wait for the widget iframe body to be reachable.
  await expect(
    widget.locator('body'),
    'chat widget iframe body should be reachable',
  ).toBeAttached({ timeout: 30_000 });

  // Open the chat panel (click launcher → "Send us a message" if needed).
  const openResult = await openVisitorWidget(widget);
  console.log(`Visitor widget opened: ${openResult}`);

  // Locate input and send controls.
  const input = await locateVisitorInput(widget);
  const send = await locateVisitorSendControl(widget);

  console.log(`Visitor input locator: ${input.description}`);
  console.log(`Visitor send control locator: ${send.description}`);

  // Type the message using real keystrokes.
  await typeIntoInput(input.element, message);

  // Click send.
  await send.element.click({ timeout: 5_000 });

  // Verify the message bubble is visible in the conversation.
  await waitForMessageInWidgetFrame(widget, message, 15_000);

  console.log(`Visitor message sent and verified: "${message}"`);

  return {
    message,
    messageInputLocator: input.description,
    sendControlLocator: send.description,
  };
}

/**
 * Sends a visitor message to an **already-open** chat widget panel.
 *
 * Unlike `sendVisitorMessage`, this skips the 6-phase panel-opening logic,
 * which would waste ~10 s of timeouts when the panel is already visible.
 * Use this for the **second** (and subsequent) messages in an ongoing
 * conversation.
 */
export async function sendVisitorMessageToOpenWidget(
  page: Page,
  message: string,
): Promise<SendVisitorMessageResult> {
  const widget = getEmbedWidgetFrame(page);

  // Wait for the widget iframe body to be reachable.
  await expect(
    widget.locator('body'),
    'chat widget iframe body should be reachable (open widget)',
  ).toBeAttached({ timeout: 30_000 });

  // Widget panel is already open — locate input and send controls directly.
  const input = await locateVisitorInput(widget);
  const send = await locateVisitorSendControl(widget);

  console.log(`Visitor input locator (open widget): ${input.description}`);
  console.log(`Visitor send control locator (open widget): ${send.description}`);

  // Type the message using real keystrokes.
  await typeIntoInput(input.element, message);

  // Click send.
  await send.element.click({ timeout: 5_000 });

  // Verify the message bubble is visible in the conversation.
  await waitForMessageInWidgetFrame(widget, message, 15_000);

  console.log(`Visitor message sent and verified (open widget): "${message}"`);

  return {
    message,
    messageInputLocator: input.description,
    sendControlLocator: send.description,
  };
}

// ---------------------------------------------------------------------------
// Wait for message
// ---------------------------------------------------------------------------

/**
 * Waits for a specific message to appear anywhere in the visitor's chat
 * widget.
 *
 * Used to verify that an agent reply arrives on the visitor side, or that
 * the visitor's own message is visible.  Condition-based — no fixed sleeps.
 */
export async function waitForVisitorMessage(
  page: Page,
  expectedMessage: string,
  timeoutMs = 60_000,
): Promise<void> {
  const widget = getEmbedWidgetFrame(page);
  await waitForMessageInWidgetFrame(widget, expectedMessage, timeoutMs);
}
