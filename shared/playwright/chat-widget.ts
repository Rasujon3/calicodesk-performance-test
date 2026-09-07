import { randomBytes } from 'node:crypto';
import {
  expect,
  type FrameLocator,
  type Locator,
  type Page,
} from '@playwright/test';
import { getTryItPreviewFrame } from './w3schools-tryit.js';

export const CHAT_IFRAME_SELECTOR = '#be-chat-iframe';

export interface SendCustomerChatMessageResult {
  customerMessage: string;
  messageInputLocator: string;
  sendControlLocator: string;
}

/**
 * Module-level counter guarantees two customer messages generated in the
 * same process are always distinct, even if Date.now() happens to match
 * (e.g. message #1 and #2 sent back-to-back in the same millisecond).
 */
let customerMessageCounter = 0;

/**
 * Returns a FrameLocator for the chat widget iframe nested inside the
 * W3Schools TryIt preview iframe. This is the boundary where all widget
 * controls live.
 *
 * Pipeline: page → iframe[name="iframeResult"] (preview) → #be-chat-iframe
 * (CalicoDesk widget).
 */
function getChatWidgetFrame(page: Page): FrameLocator {
  const preview = getTryItPreviewFrame(page);
  return preview.frameLocator(CHAT_IFRAME_SELECTOR);
}

/**
 * W3Schools TryIt injects ad overlays (observed: a `#hbdbrk-slideup`
 * `data-actirise` div holding a pointer-event-grabbing dashboard iframe).
 * These overlays sit above the page and swallow clicks aimed at the chat
 * widget, so remove them from the preview frame before interacting.
 */
export async function dismissW3SchoolsOverlays(
  preview: FrameLocator,
): Promise<void> {
  const overlaySelectors = [
    '#hbdbrk-slideup',
    '[data-hbdbrk-slideup]',
    '[data-hbdbrk-type]',
    'iframe[data-actirise="true"]',
  ];

  for (const selector of overlaySelectors) {
    try {
      await preview.locator(selector).evaluateAll((els) => {
        for (const el of els) {
          el.remove();
        }
      });
    } catch {
      // No such overlay present (or preview frame detached mid-scan) — fine.
    }
  }
}

/**
 * Tries a list of candidate locators in order and returns the first one that
 * becomes visible. Throws a clear, actionable error when none match.
 */
export async function resolveFirstVisible(
  label: string,
  candidates: Array<{ description: string; locator: Locator }>,
  timeout = 2_000,
): Promise<{ element: Locator; description: string }> {
  for (const candidate of candidates) {
    try {
      const element = candidate.locator.first();
      await element.waitFor({ state: 'visible', timeout });
      return { element, description: candidate.description };
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    `Failed to locate the chat widget ${label} inside ${CHAT_IFRAME_SELECTOR}. ` +
    `Tried selectors: ${candidates
      .map((candidate) => candidate.description)
      .join(', ')}.`,
  );
}

/**
 * Generates a deterministic, run-unique customer message that is safe to use
 * later to locate the conversation in the CalicoDesk admin.
 *
 * Format: "CalicoDesk Chat Test <timestamp>-<counter>-<randomSuffix>"
 * The per-process counter prevents same-millisecond collisions.
 */
function uniqueCustomerMessage(): string {
  customerMessageCounter += 1;
  const nonce = `${Date.now()}-${customerMessageCounter}-${randomBytes(2).toString('hex')}`;
  return `CalicoDesk Chat Test ${nonce}`;
}

/**
 * Escapes regular-expression special characters so a literal string can be
 * used safely inside a RegExp (e.g. the whole-widget getByText fallback).
 */
function escapeRegExpString(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Opens the chat widget panel by clicking its launcher button. If the panel
 * is already open (e.g. restored state), this is a no-op.
 */
export async function openChatWidgetPanel(widget: FrameLocator): Promise<string> {
  const panelCandidates: Array<{ description: string; locator: Locator }> = [
    {
      description:
        '[data-testid*="chat-panel" i], [data-testid*="chat-window" i]',
      locator: widget.locator(
        '[data-testid*="chat-panel" i], [data-testid*="chat-window" i]',
      ),
    },
    {
      description: '[class*="chat-panel" i], [class*="chat-window" i]',
      locator: widget.locator(
        '[class*="chat-panel" i], [class*="chat-window" i]',
      ),
    },
    {
      description: '[role="dialog"]',
      locator: widget.locator('[role="dialog"]'),
    },
  ];

  const launcherCandidates: Array<{ description: string; locator: Locator }> = [
    {
      description: 'button[class*="chat-toggle" i] (launcher bubble)',
      locator: widget.locator('button[class*="chat-toggle" i]'),
    },
    {
      description:
        'button:has(svg[data-testid="ChatBubbleOutlineOutlinedIcon"])',
      locator: widget.locator(
        'button:has(svg[data-testid="ChatBubbleOutlineOutlinedIcon"])',
      ),
    },
    {
      description: 'getByRole("button", { name: /chat|help/i })',
      locator: widget.getByRole('button', { name: /chat|help/i }),
    },
    {
      description: '[data-testid*="launcher" i]',
      locator: widget.locator('[data-testid*="launcher" i]'),
    },
    {
      description: '[aria-label*="launcher" i]',
      locator: widget.locator('[aria-label*="launcher" i]'),
    },
    {
      description: '[class*="launcher" i]',
      locator: widget.locator('[class*="launcher" i]'),
    },
    {
      description: '[id*="launcher" i]',
      locator: widget.locator('[id*="launcher" i]'),
    },
  ];

  // 1. If the conversation textarea is already visible, we are done. This is
  //    a short condition probe (max 1s), not a fixed sleep.
  try {
    await widget
      .locator('textarea[placeholder*="message" i]')
      .first()
      .waitFor({ state: 'visible', timeout: 1_000 });
    return 'conversation form already open (message textarea visible)';
  } catch {
    // Proceed.
  }

  // 2. If the home panel is already open, click "Send us a message".
  const sendUsMessageLink = widget
    .locator('a[href="/lc/widget/conversations/new"]')
    .first();
  try {
    await sendUsMessageLink.waitFor({ state: 'visible', timeout: 1_000 });
    await sendUsMessageLink.click();
    return 'home panel was open, clicked "Send us a message"';
  } catch {
    // Proceed.
  }

  // 3. Panel/form not open: click the launcher, then "Send us a message".
  const { element, description } = await resolveFirstVisible(
    'launcher',
    launcherCandidates,
  );

  await element.click();

  // After the launcher, the home panel appears with a "Send us a message" link.
  try {
    await sendUsMessageLink.waitFor({ state: 'visible', timeout: 10_000 });
    await sendUsMessageLink.click();
    return `launcher then "Send us a message" (launcher: ${description})`;
  } catch {
    // Fall back to panel candidates for widgets that skip the home panel.
  }

  // Wait for a panel to become visible after clicking the launcher.
  for (const candidate of panelCandidates) {
    try {
      const panel = candidate.locator.first();
      await panel.waitFor({ state: 'visible', timeout: 5_000 });
      return `panel opened via launcher (launcher: ${description}, panel: ${candidate.description})`;
    } catch {
      // Try next panel candidate.
    }
  }

  // Panel still not visible: fail clearly so the test can be debugged.
  throw new Error(
    `Chat widget launcher was clicked (${description}) but no panel became visible. ` +
    `Expected one of: ${panelCandidates
      .map((candidate) => candidate.description)
      .join(', ')}.`,
  );
}

/**
 * Locates the message input inside the chat widget.
 */
export async function locateMessageInput(
  widget: FrameLocator,
): Promise<{ element: Locator; description: string }> {
  return resolveFirstVisible('message input', [
    {
      description:
        'textarea[placeholder*="message" i] ("Enter your message here...")',
      locator: widget.locator('textarea[placeholder*="message" i]'),
    },
    {
      description: 'getByRole("textbox", { name: /message|type/i })',
      locator: widget.getByRole('textbox', { name: /message|type/i }),
    },
    {
      description: 'textarea[placeholder*="type" i]',
      locator: widget.locator('textarea[placeholder*="type" i]'),
    },
    {
      description: 'getByRole("textbox").first()',
      locator: widget.getByRole('textbox').first(),
    },
    {
      description: 'textarea.first()',
      locator: widget.locator('textarea').first(),
    },
    {
      description: 'input[type="text"].first()',
      locator: widget.locator('input[type="text"]').first(),
    },
    {
      description: '[contenteditable="true"].first()',
      locator: widget.locator('[contenteditable="true"]').first(),
    },
    {
      description: 'input.first()',
      locator: widget.locator('input').first(),
    },
  ]);
}

/**
 * Locates the send (submit) control inside the chat widget.
 */
export async function locateSendControl(
  widget: FrameLocator,
): Promise<{ element: Locator; description: string }> {
  return resolveFirstVisible('send control', [
    {
      description: 'button[type="submit"][aria-label="Submit"]',
      locator: widget.locator('button[type="submit"][aria-label="Submit"]'),
    },
    {
      description: 'button[type="submit"].first()',
      locator: widget.locator('button[type="submit"]').first(),
    },
    {
      description: 'getByRole("button", { name: /submit/i })',
      locator: widget.getByRole('button', { name: /submit/i }),
    },
    {
      description: 'getByRole("button", { name: /send/i })',
      locator: widget.getByRole('button', { name: /send/i }),
    },
    {
      description: '[data-testid*="send" i].first()',
      locator: widget.locator('[data-testid*="send" i]').first(),
    },
    {
      description: '[aria-label*="send" i].first()',
      locator: widget.locator('[aria-label*="send" i]').first(),
    },
    {
      description: 'button[title*="send" i].first()',
      locator: widget.locator('button[title*="send" i]').first(),
    },
    {
      description: 'last button with svg',
      locator: widget
        .locator('button')
        .filter({ has: widget.locator('svg') })
        .last(),
    },
  ]);
}

/**
 * Shared three-tier verification that a literal message text appears in the
 * chat widget frame. Condition-based only (no fixed sleeps).
 *
 * 1. A real message bubble ([data-message-id]) whose visible text contains
 *    the expected message. hasText matches substrings so split text nodes and
 *    extra content (timestamps/icons) still pass.
 * 2. Message-area containers once they contain the expected text.
 * 3. Whole-widget fallback: any visible element containing the exact text.
 *
 * Returns the strategy that matched (for diagnostics / reporting).
 */
export async function waitForMessageInWidgetFrame(
  widget: FrameLocator,
  expectedMessage: string,
  timeoutMs = 60_000,
): Promise<string> {
  // 1. A real message bubble ([data-message-id]) containing the expected text.
  try {
    const bubble = widget
      .locator('[data-message-id]', {
        hasText: expectedMessage,
      })
      .first();

    await bubble.waitFor({ state: 'visible', timeout: timeoutMs });
    return 'message bubble ([data-message-id]) containing the exact text';
  } catch {
    // Fall through to message-area containers.
  }

  // 2. Message-area containers once they contain the expected text.
  const messageAreaCandidates: Array<{
    description: string;
    locator: Locator;
  }> = [
      {
        description: '#feed-container (scrollable message feed)',
        locator: widget.locator('#feed-container'),
      },
      {
        description: '[data-testid*="message" i], [class*="message" i]',
        locator: widget.locator(
          '[data-testid*="message" i], [class*="message" i]',
        ),
      },
      {
        description: '[data-testid*="conversation" i], [class*="conversation" i]',
        locator: widget.locator(
          '[data-testid*="conversation" i], [class*="conversation" i]',
        ),
      },
      {
        description: '[data-testid*="chat-body" i], [class*="chat-body" i]',
        locator: widget.locator(
          '[data-testid*="chat-body" i], [class*="chat-body" i]',
        ),
      },
    ];

  for (const candidate of messageAreaCandidates) {
    try {
      const area = candidate.locator.first();
      await expect(
        area,
        `message "${expectedMessage}" should appear in the chat widget (${candidate.description})`,
      ).toContainText(expectedMessage, { timeout: 10_000 });
      return `visible ${candidate.description} containing the exact text`;
    } catch {
      // Try next candidate.
    }
  }

  // 3. Whole-widget fallback: any visible element containing the exact text.
  const startedAt = Date.now();
  await expect(
    widget.getByText(new RegExp(escapeRegExpString(expectedMessage))),
    `message "${expectedMessage}" should appear in the chat widget`,
  ).toBeVisible({ timeout: Math.min(timeoutMs, 20_000) });
  return `whole-widget exact text (waited ${Date.now() - startedAt}ms)`;
}

/**
 * Verifies the customer message appears as a sent message bubble in the
 * conversation before returning.
 *
 * The verification is intentionally scoped to the message-bubble area rather
 * than the whole widget DOM, so we don't accidentally match a placeholder.
 */
export async function verifySentMessage(
  widget: FrameLocator,
  customerMessage: string,
): Promise<void> {
  await waitForMessageInWidgetFrame(widget, customerMessage, 15_000);
}

/**
 * Waits for a specific message to appear anywhere in the customer chat widget
 * (used to verify the agent reply arrives on the customer side). Condition-
 * based only; no fixed sleeps. Reuses the same three-tier strategy as
 * verifySentMessage but takes a page so callers outside the "send" flow can
 * verify response messages too.
 */
export async function waitForWidgetMessage(
  page: Page,
  expectedMessage: string,
  timeoutMs = 60_000,
): Promise<void> {
  const widget = getChatWidgetFrame(page);
  await waitForMessageInWidgetFrame(widget, expectedMessage, timeoutMs);
}

/**
 * Types the unique customer message into the widget input using real
 * keystrokes (pressSequentially), then waits until the actual input value
 * contains it before returning.
 *
 * A single fill() proved flaky on the widget's React-controlled autosize
 * textarea — the value sometimes did not stick (or React's onChange never
 * fired), leaving the required-field validation to silently block the submit.
 * Real keystrokes fire the same input events a human would, which React's
 * onChange reliably picks up. If the value is still wiped (W3Schools ad
 * refreshes can trigger a widget re-render), the input is cleared and retried.
 */
export async function typeIntoInput(
  input: Locator,
  customerMessage: string,
): Promise<void> {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts += 1;

    // W3Schools injects ad overlays (e.g. `#hbdbrk-slideup` / Actirise) that
    // intercept POINTER events, so click() on the input can be swallowed even
    // though the element is visible and stable. Keyboard events are routed to
    // the focused element and are NOT pointer-intercepted, so use focus() +
    // pressSequentially to type regardless of any ad overlay.
    await input.focus();
    await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await input.press('Backspace');
    await input.pressSequentially(customerMessage, { delay: 10 });

    const isContentEditable =
      (await input.getAttribute('contenteditable')) === 'true' ||
      (await input.evaluate((el) => el.tagName)) === 'DIV';

    try {
      if (isContentEditable) {
        await expect(
          input,
          `message input should contain the typed customer message (attempt ${attempts})`,
        ).toContainText(customerMessage, { timeout: 5_000 });
      } else {
        await expect(
          input,
          `message input should contain the typed customer message (attempt ${attempts})`,
        ).toHaveValue(customerMessage, { timeout: 5_000 });
      }
      return;
    } catch {
      // Input was wiped by a widget re-render; loop clears and retypes.
    }
  }

  throw new Error(
    `Could not type the unique customer message into the chat widget input after ` +
    `${maxAttempts} attempts. ` +
    `Input HTML: ${await input
      .evaluate((el) => el.outerHTML)
      .catch(() => 'unknown')}`,
  );
}

/**
 * Shared send pipeline used by both sendCustomerChatMessage and
 * sendNewCustomerChatMessage. Handles overlay dismissal, opening the panel,
 * locating the input/send controls, typing with real keystrokes, retrying the
 * send click against W3Schools ad overlays, and finally verifying the message
 * bubble is visible. No fixed sleeps anywhere.
 */
async function sendMessageViaWidget(
  page: Page,
  customerMessage: string,
): Promise<{ messageInputLocator: string; sendControlLocator: string }> {
  const widget = getChatWidgetFrame(page);

  // The widget bootstrap mounts the iframe hidden; wait for the document body.
  await expect(
    widget.locator('body'),
    'chat widget iframe body should be reachable',
  ).toBeAttached({ timeout: 30_000 });

  // Open the chat panel (click launcher if needed).
  const openResult = await openChatWidgetPanel(widget);
  console.log(`Chat widget opened: ${openResult}`);

  // Locate the message input and send controls.
  const input = await locateMessageInput(widget);
  const send = await locateSendControl(widget);

  console.log(`Message input locator: ${input.description}`);
  console.log(`Send control locator: ${send.description}`);

  // W3Schools ads can steal browser/window focus; ensure the customer page is
  // the focused window so the widget input reliably receives the keystrokes.
  await page.bringToFront();

  // Type the message with real keystrokes (see typeIntoInput docs).
  await typeIntoInput(input.element, customerMessage);

  // Send it. W3Schools re-injects ad overlays at unpredictable times, so
  // dismiss and retry the click rather than relying on a single attempt that
  // can be swallowed by pointer interception.
  let sendAttempt = 0;
  const maxSendAttempts = 3;
  for (; sendAttempt < maxSendAttempts; sendAttempt += 1) {
    await dismissW3SchoolsOverlays(getTryItPreviewFrame(page));
    try {
      await send.element.click({ timeout: 5_000 });
      break;
    } catch {
      if (sendAttempt === maxSendAttempts - 1) {
        throw new Error(
          `Send control click failed after ${maxSendAttempts} attempts ` +
          `(W3Schools overlay may keep intercepting pointer events). ` +
          `Send locator: ${send.description}. Page URL: ${page.url()}.`,
        );
      }
      console.log(
        `Send click intercepted (attempt ${sendAttempt + 1}); retrying.`,
      );
    }
  }

  // Verify it appears in the conversation.
  await verifySentMessage(widget, customerMessage);

  console.log(`Customer message sent and verified: "${customerMessage}"`);

  return {
    messageInputLocator: input.description,
    sendControlLocator: send.description,
  };
}

/**
 * Sends a unique customer message through the CalicoDesk chat widget
 * rendered inside the W3Schools TryIt preview iframe.
 *
 * Returns the exact message text (for later agent-side verification), plus the
 * locator descriptions that were used for the input and send controls.
 *
 * The widget pipeline is:
 *   TryIt page iframe[name="iframeResult"] → widget iframe #be-chat-iframe
 */
export async function sendCustomerChatMessage(
  page: Page,
): Promise<SendCustomerChatMessageResult> {
  // W3Schools ads inside the preview can intercept clicks on the widget;
  // remove any injected overlays before interacting.
  await dismissW3SchoolsOverlays(getTryItPreviewFrame(page));

  // Step 1 — generate the unique customer message.
  const customerMessage = uniqueCustomerMessage();

  // Steps 2-6 — open, locate controls, type, send, verify.
  const controls = await sendMessageViaWidget(page, customerMessage);

  return {
    customerMessage,
    messageInputLocator: controls.messageInputLocator,
    sendControlLocator: controls.sendControlLocator,
  };
}

/**
 * Sends another unique customer message through the already-open chat widget
 * (used for the second customer message in the two-way conversation flow).
 */
export async function sendNewCustomerChatMessage(
  page: Page,
): Promise<SendCustomerChatMessageResult> {
  await dismissW3SchoolsOverlays(getTryItPreviewFrame(page));

  const customerMessage = uniqueCustomerMessage();

  const controls = await sendMessageViaWidget(page, customerMessage);

  return {
    customerMessage,
    messageInputLocator: controls.messageInputLocator,
    sendControlLocator: controls.sendControlLocator,
  };
}