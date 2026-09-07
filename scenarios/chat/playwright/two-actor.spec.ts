/**
 * Two-actor Playwright scenario: full bidirectional chat conversation.
 *
 * Architecture:
 *   - AGENT (authenticated CalicoDesk user) in isolated BrowserContext
 *   - VISITOR (anonymous, local embed fixture) in isolated BrowserContext
 *
 * Business flow (23 checkpoints):
 *   AGENT  -> Login, verify Live Chat install, obtain script
 *   VISITOR -> Open fixture, verify widget, send CUSTOMER_MESSAGE_1
 *   AGENT  -> Navigate to conversations, find conversation by message,
 *            open it, verify CUSTOMER_MESSAGE_1, send AGENT_REPLY_1
 *   VISITOR -> Wait for AGENT_REPLY_1, verify, send CUSTOMER_MESSAGE_2
 *   AGENT  -> Wait for CUSTOMER_MESSAGE_2, verify
 *
 * Proves bidirectional communication:
 *   Visitor -> Agent  (CUSTOMER_MESSAGE_1)
 *   Agent -> Visitor  (AGENT_REPLY_1)
 *   Visitor -> Agent  (CUSTOMER_MESSAGE_2)
 *
 * All waits are condition-based.  No fixed sleeps.  No conversation-order
 * assumptions.  Unique messages per run.  Bounded polling.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { environment } from '../../../config/environments.js';
import { loginWithTestUser } from '../../../shared/playwright/auth.js';
import {
  extractLiveChatInstallationScript,
  openLiveChatInstallPage,
} from '../../../shared/playwright/live-chat-install.js';
import {
  openEmbedFixture,
  waitEmbedWidgetReady,
  generateVisitorMessage,
  sendVisitorMessage,
  sendVisitorMessageToOpenWidget,
  waitForVisitorMessage,
} from '../../../shared/playwright/embed-widget.js';
import {
  findAndOpenConversationByMessage,
  sendAgentReply,
  uniqueAgentReply,
  waitForAgentMessage,
} from '../../../shared/playwright/agent-conversations.js';
import { FIXTURE_ORIGIN } from '../fixtures/fixture-config.js';

// ---------------------------------------------------------------------------
// Result interface
// ---------------------------------------------------------------------------

interface TwoActorPlaywrightResult {
  runId: string;
  scenario: 'chat';
  environment: string;
  status: 'passed' | 'failed';
  startedAt: string;
  completedAt: string;
  duration: number;
  message: string;

  // --- Agent login & Live Chat install ---
  agentAuthenticated?: boolean;
  agentUrl?: string;
  tenantOrigin?: string;
  liveChatInstallPageVisited?: boolean;
  installationScriptExtracted?: boolean;
  installationScriptLength?: number;

  // --- Visitor widget ---
  fixtureUrl?: string;
  loaderUrl?: string;
  widgetIframeAttached?: boolean;
  widgetReady?: boolean;

  // --- CUSTOMER_MESSAGE_1 (Visitor -> Agent) ---
  customerMessage1?: string;
  customerMessage1Sent?: boolean;
  messageInputLocator?: string;
  sendControlLocator?: string;
  customerMessage1LocatedByAgent?: boolean;
  conversationOpenStrategy?: string;

  // --- AGENT_REPLY_1 (Agent -> Visitor) ---
  agentReply1?: string;
  agentReply1Sent?: boolean;
  agentReply1ComposerLocator?: string;
  agentReply1SendLocator?: string;
  agentReply1ReceivedByVisitor?: boolean;

  // --- CUSTOMER_MESSAGE_2 (Visitor -> Agent) ---
  customerMessage2?: string;
  customerMessage2Sent?: boolean;
  customerMessage2ReceivedByAgent?: boolean;
}

// ---------------------------------------------------------------------------
// Result writer
// ---------------------------------------------------------------------------

async function writeTwoActorResult(
  result: TwoActorPlaywrightResult,
): Promise<string> {
  const resultsDirectory = path.resolve(
    `scenarios/chat/results/playwright/${result.environment}/${result.runId}`,
  );

  await mkdir(resultsDirectory, { recursive: true });

  const resultsPath = path.join(resultsDirectory, 'two-actor-results.json');

  await writeFile(resultsPath, JSON.stringify(result, null, 2), 'utf8');

  return resultsPath;
}

// ---------------------------------------------------------------------------
// Format assertion helpers
// ---------------------------------------------------------------------------

function expectUniqueChatMessageFormat(
  value: string | undefined,
  label: string,
): asserts value is string {
  expect(value, `${label} should be defined`).toBeDefined();
  expect(
    value,
    `${label} should use the deterministic unique chat-test format`,
  ).toMatch(/^CalicoDesk Chat Test \d+-\d+-[a-f0-9]{4}$/);
}

function expectUniqueAgentReplyFormat(
  value: string | undefined,
  label: string,
): asserts value is string {
  expect(value, `${label} should be defined`).toBeDefined();
  expect(
    value,
    `${label} should use the deterministic unique agent-reply format`,
  ).toMatch(/^CalicoDesk Agent Reply \d+-\d+-[a-f0-9]{4}$/);
}
// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('two-actor chat: full bidirectional conversation [@two-actor]', async ({
  browser,
}) => {
  // 10 minutes: login (~60-90s) + install page (~30s) + widget bootstrap +
  // visitor msg 1 + agent find + agent reply + visitor wait + visitor msg 2 +
  // agent wait for msg 2.  Dev can be very slow.
  test.setTimeout(600_000);

  const runId = process.env.PLAYWRIGHT_RUN_ID;

  if (!runId) {
    throw new Error(
      'PLAYWRIGHT_RUN_ID is not defined. Playwright config must assign a run ID before tests start.',
    );
  }

  let testStatus: 'passed' | 'failed' = 'failed';
  let message = 'Two-actor chat test failed.';
  const startedAtDate = new Date();
  const startedAtMs = Date.now();

  // --- Result accumulators ---
  let agentAuthenticated = false;
  let agentUrl: string | undefined;
  let tenantOrigin: string | undefined;
  let liveChatInstallPageVisited = false;
  let installationScriptExtracted = false;
  let installationScriptLength: number | undefined;
  let fixtureUrl: string | undefined;
  let loaderUrl: string | undefined;
  let widgetIframeAttached = false;
  let widgetReady = false;
  let customerMessage1: string | undefined;
  let customerMessage1Sent = false;
  let messageInputLocator: string | undefined;
  let sendControlLocator: string | undefined;
  let customerMessage1LocatedByAgent = false;
  let conversationOpenStrategy: string | undefined;
  let agentReply1: string | undefined;
  let agentReply1Sent = false;
  let agentReply1ComposerLocator: string | undefined;
  let agentReply1SendLocator: string | undefined;
  let agentReply1ReceivedByVisitor = false;
  let customerMessage2: string | undefined;
  let customerMessage2Sent = false;
  let customerMessage2ReceivedByAgent = false;

  // ---- Create isolated browser contexts (one per actor) ----
  const agentContext = await browser.newContext();
  const visitorContext = await browser.newContext();

  const agentPage = await agentContext.newPage();
  const visitorPage = await visitorContext.newPage();

  try {
    // =====================================================================
    // ACTOR 1 — AGENT (authenticated CalicoDesk user)
    // =====================================================================

    // ---- CHECKPOINT 1: Agent login ----
    console.log('[1] AGENT: Logging in...');

    await loginWithTestUser(agentPage);

    agentAuthenticated = true;
    agentUrl = agentPage.url();
    tenantOrigin = new URL(agentUrl).origin;

    console.log(`[1] ✓ Agent authenticated. URL: ${agentUrl}`);
    console.log(`    Tenant origin: ${tenantOrigin}`);

    // ---- CHECKPOINT 2: Live Chat installation configuration ----
    console.log('[2] AGENT: Verifying Live Chat installation settings...');

    await openLiveChatInstallPage(agentPage);

    liveChatInstallPageVisited = true;

    console.log('[2] ✓ Live Chat install page verified.');

    // ---- CHECKPOINT 3: Obtain installation script ----
    console.log('[3] AGENT: Extracting Live Chat installation script...');

    const installScript = await extractLiveChatInstallationScript(agentPage);

    installationScriptExtracted = true;
    installationScriptLength = installScript.length;

    console.log(
      `[3] ✓ Installation script extracted (${installationScriptLength} chars).`,
    );

// =====================================================================
    // ACTOR 2 — VISITOR (anonymous, uses local embed fixture)
    // =====================================================================

    // ---- CHECKPOINT 4: Open embed fixture ----
    console.log('[4] VISITOR: Opening embed fixture...');

    fixtureUrl = await openEmbedFixture(visitorPage);
    loaderUrl = process.env.CALICODESK_LIVECHAT_LOADER_URL?.trim();

    console.log(`[4] ✓ Fixture loaded: ${fixtureUrl}`);

    // ---- CHECKPOINT 5: Widget renders ----
    console.log('[5] VISITOR: Waiting for widget to render...');

    await waitEmbedWidgetReady(visitorPage);

    widgetIframeAttached = true;
    widgetReady = true;

    console.log('[5] ✓ Widget iframe attached, bootstrapped, and visible.');

    // ---- CHECKPOINT 7: Generate CUSTOMER_MESSAGE_1 ----
    console.log('[7] VISITOR: Generating CUSTOMER_MESSAGE_1...');

    customerMessage1 = generateVisitorMessage();

    expectUniqueChatMessageFormat(customerMessage1, 'customer message 1');

    console.log(`[7] ✓ CUSTOMER_MESSAGE_1: "${customerMessage1}"`);

    // ---- CHECKPOINT 6+8: Open panel, send CUSTOMER_MESSAGE_1, verify ----
    //      (panel opening is handled inside sendVisitorMessage)
    console.log('[6] VISITOR: Opening panel & sending CUSTOMER_MESSAGE_1...');

    const sendResult1 = await sendVisitorMessage(visitorPage, customerMessage1);

    customerMessage1Sent = true;
    messageInputLocator = sendResult1.messageInputLocator;
    sendControlLocator = sendResult1.sendControlLocator;

    console.log(
      `[8] ✓ CUSTOMER_MESSAGE_1 sent and verified in widget. ` +
        `Input: ${messageInputLocator}; Send: ${sendControlLocator}`,
    );

    // =====================================================================
    // ACTOR 1 — AGENT: find conversation & reply
    // =====================================================================

    // ---- CHECKPOINT 9: Navigate to conversations page ----
    console.log('[9] AGENT: Navigating to conversations (viewId=mine)...');

    const conversationsUrl = `${tenantOrigin}/dashboard/conversations?viewId=mine`;

    await agentPage.goto(conversationsUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });

    await expect(
      agentPage,
      'conversations page should load under /dashboard/conversations',
    ).toHaveURL(/\/dashboard\/conversations/, {
      timeout: 90_000,
    });

    console.log(`[9] ✓ Conversations page loaded: ${conversationsUrl}`);
// ---- CHECKPOINT 10-12: Find conversation by unique message ----
    //      (not by position — hasText filter on the exact unique message)
    console.log(
      '[10-12] AGENT: Finding conversation by CUSTOMER_MESSAGE_1...',
    );

    conversationOpenStrategy = await findAndOpenConversationByMessage(
      agentPage,
      customerMessage1,
    );

    customerMessage1LocatedByAgent = true;

    console.log(
      `[10-12] ✓ Conversation found and opened via: ${conversationOpenStrategy}`,
    );

    // ---- CHECKPOINT 13: Conversation opened ----
    //      (findAndOpenConversationByMessage already clicked the row)

    console.log('[13] ✓ Conversation is open.');

    // ---- CHECKPOINT 14: Verify CUSTOMER_MESSAGE_1 in agent thread ----
    console.log('[14] AGENT: Verifying CUSTOMER_MESSAGE_1 in agent thread...');

    const msgWaitStrategy = await waitForAgentMessage(
      agentPage,
      customerMessage1,
      30_000,
    );

    console.log(`[14] ✓ CUSTOMER_MESSAGE_1 verified via: ${msgWaitStrategy}`);

    // ---- CHECKPOINT 15: Generate and send AGENT_REPLY_1 ----
    console.log('[15] AGENT: Generating and sending AGENT_REPLY_1...');

    agentReply1 = uniqueAgentReply();

    expectUniqueAgentReplyFormat(agentReply1, 'agent reply 1');

    console.log(`[15] AGENT_REPLY_1: "${agentReply1}"`);

    const replyResult = await sendAgentReply(agentPage, agentReply1);

    agentReply1Sent = true;
    agentReply1ComposerLocator = replyResult.composerLocator;
    agentReply1SendLocator = replyResult.sendLocator;

    console.log(
      `[15] ✓ AGENT_REPLY_1 sent. ` +
        `Composer: ${agentReply1ComposerLocator}; ` +
        `Send: ${agentReply1SendLocator}`,
    );

    // ---- CHECKPOINT 16: AGENT_REPLY_1 verified in agent thread ----
    //      (sendAgentReply internally calls waitForAgentMessage)

    console.log('[16] ✓ AGENT_REPLY_1 verified in agent thread.');

    // =====================================================================
    // ACTOR 2 — VISITOR: receive reply & send second message
    // =====================================================================

    // ---- CHECKPOINT 17: Wait for AGENT_REPLY_1 in widget ----
    console.log('[17] VISITOR: Waiting for AGENT_REPLY_1 in widget...');

    await waitForVisitorMessage(visitorPage, agentReply1, 90_000);

    agentReply1ReceivedByVisitor = true;

    console.log('[17] ✓ AGENT_REPLY_1 received in widget.');

    // ---- CHECKPOINT 18: Verify exact reply ----
    //      (waitForVisitorMessage checks exact text content)

    console.log(
      `[18] ✓ Exact AGENT_REPLY_1 verified in widget: "${agentReply1}"`,
    );

    // ---- CHECKPOINT 19: Generate CUSTOMER_MESSAGE_2 ----
    console.log('[19] VISITOR: Generating CUSTOMER_MESSAGE_2...');

    customerMessage2 = generateVisitorMessage();

    expectUniqueChatMessageFormat(customerMessage2, 'customer message 2');

    console.log(`[19] ✓ CUSTOMER_MESSAGE_2: "${customerMessage2}"`);

    // ---- CHECKPOINT 20: Send CUSTOMER_MESSAGE_2 ----
    console.log('[20] VISITOR: Sending CUSTOMER_MESSAGE_2...');

    const sendResult2 = await sendVisitorMessageToOpenWidget(
      visitorPage,
      customerMessage2,
    );

    customerMessage2Sent = true;

console.log(
      `[20] ✓ CUSTOMER_MESSAGE_2 sent. ` +
        `Input: ${sendResult2.messageInputLocator}; ` +
        `Send: ${sendResult2.sendControlLocator}`,
    );

    // ---- CHECKPOINT 21: CUSTOMER_MESSAGE_2 verified in widget ----
    //      (sendVisitorMessageToOpenWidget already verifies)

    console.log('[21] ✓ CUSTOMER_MESSAGE_2 verified in widget.');

    // =====================================================================
    // ACTOR 1 — AGENT: receive second customer message
    // =====================================================================

    // ---- CHECKPOINT 22: Wait for CUSTOMER_MESSAGE_2 ----
    console.log(
      '[22] AGENT: Waiting for CUSTOMER_MESSAGE_2 in agent thread...',
    );

    const msg2Strategy = await waitForAgentMessage(
      agentPage,
      customerMessage2,
      60_000,
    );

    customerMessage2ReceivedByAgent = true;

    console.log(
      `[22] ✓ CUSTOMER_MESSAGE_2 received in agent thread via: ${msg2Strategy}`,
    );

    // ---- CHECKPOINT 23: Verify exact second customer message ----
    //      (waitForAgentMessage checks exact text content in same thread)

    console.log(
      '[23] ✓ CUSTOMER_MESSAGE_2 exactly verified in the same conversation.',
    );
// =====================================================================
    // ALL CHECKPOINTS PASSED
    // =====================================================================

    message =
      'Full bidirectional two-actor chat conversation verified. ' +
      'Agent authenticated and verified Live Chat install settings. ' +
      `Visitor opened embed fixture (${FIXTURE_ORIGIN}), widget rendered, ` +
      `CUSTOMER_MESSAGE_1 ("${customerMessage1}") sent and received by agent. ` +
      `AGENT_REPLY_1 ("${agentReply1}") sent by agent and received by visitor. ` +
      `CUSTOMER_MESSAGE_2 ("${customerMessage2}") sent by visitor and ` +
      'received by agent. All 23 checkpoints passed.';

    testStatus = 'passed';

    console.log('\n=== ALL 23 CHECKPOINTS PASSED ===');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const completedAtDate = new Date();

    const result: TwoActorPlaywrightResult = {
      runId,
      scenario: 'chat',
      environment: environment.name,
      status: testStatus,
      startedAt: startedAtDate.toISOString(),
      completedAt: completedAtDate.toISOString(),
      duration: Date.now() - startedAtMs,
      message,
      agentAuthenticated,
      agentUrl,
      tenantOrigin,
      liveChatInstallPageVisited,
      installationScriptExtracted,
      installationScriptLength,
      fixtureUrl,
      loaderUrl,
      widgetIframeAttached,
      widgetReady,
      customerMessage1,
      customerMessage1Sent,
      messageInputLocator,
      sendControlLocator,
      customerMessage1LocatedByAgent,
      conversationOpenStrategy,
      agentReply1,
      agentReply1Sent,
      agentReply1ComposerLocator,
      agentReply1SendLocator,
      agentReply1ReceivedByVisitor,
      customerMessage2,
      customerMessage2Sent,
      customerMessage2ReceivedByAgent,
    };

    const resultsPath = await writeTwoActorResult(result);

    console.log(`JSON result: ${resultsPath}`);

    await visitorContext.close();
    await agentContext.close();
  }
});
