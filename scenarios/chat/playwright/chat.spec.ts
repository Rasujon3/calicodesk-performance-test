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
  sendCustomerChatMessage,
  sendNewCustomerChatMessage,
  waitForWidgetMessage,
} from '../../../shared/playwright/chat-widget.js';
import { renderChatWidgetInW3SchoolsTryIt } from '../../../shared/playwright/w3schools-tryit.js';
import {
  findAndOpenConversationByMessage,
  openAgentConversations,
  sendAgentReply,
  uniqueAgentReply,
  waitForAgentMessage,
} from '../../../shared/playwright/agent-conversations.js';

interface ChatPlaywrightResult {
  runId: string;
  scenario: 'chat';
  environment: string;
  status: 'passed' | 'failed';
  startedAt: string;
  completedAt: string;
  duration: number;
  message: string;
  installPageUrl?: string;
  installationScriptLength?: number;
  installationScriptPreview?: string;
  w3SchoolsTryItUrl?: string;
  widgetRendered?: boolean;
  customerMessage?: string;
  customerMessageSent?: boolean;
  messageInputLocator?: string;
  sendControlLocator?: string;
  conversationsUrl?: string;
  conversationOpenStrategy?: string;
  agentMessageWaitStrategy?: string;
  agentReply?: string;
  agentReplyComposerLocator?: string;
  agentReplySendLocator?: string;
  customerReceivedReply?: boolean;
  secondCustomerMessage?: string;
  secondCustomerMessageReceivedByAgent?: boolean;
}

/**
 * Asserts the message uses the deterministic unique chat-test format
 * "CalicoDesk Chat Test <timestamp>-<counter>-<hex4>".
 */
function expectUniqueChatMessageFormat(
  value: string | undefined,
  label: string
): asserts value is string {
  expect(value, `${label} should be defined`).toBeDefined();
  expect(
    value,
    `${label} should use the deterministic unique chat-test format`
  ).toMatch(/^CalicoDesk Chat Test \d+-\d+-[a-f0-9]{4}$/);
}

/**
 * Asserts the reply uses the deterministic unique agent-reply format
 * "CalicoDesk Agent Reply <timestamp>-<counter>-<hex4>".
 */
function expectUniqueAgentReplyFormat(
  value: string | undefined,
  label: string
): asserts value is string {
  expect(value, `${label} should be defined`).toBeDefined();
  expect(
    value,
    `${label} should use the deterministic unique agent-reply format`
  ).toMatch(/^CalicoDesk Agent Reply \d+-\d+-[a-f0-9]{4}$/);
}

async function writeChatResult(
  result: ChatPlaywrightResult
): Promise<string> {
  const resultsDirectory = path.resolve(
    `scenarios/chat/results/playwright/${result.environment}/${result.runId}`
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

test('chat customer-agent conversation via W3Schools widget [@w3schools]', async ({
  browser,
}) => {
  // Dev can be slow: tolerant login (~60-90s) + settings install page
  // (up to 90s) + W3Schools render + two customer messages + agent reply.
  test.setTimeout(600_000);

  const runId = process.env.PLAYWRIGHT_RUN_ID;

  if (!runId) {
    throw new Error(
      'PLAYWRIGHT_RUN_ID is not defined. Playwright config must assign a run ID before tests start.'
    );
  }

  const startedAtDate = new Date();
  const startedAtMs = Date.now();
  let testStatus: 'passed' | 'failed' = 'failed';
  let message = 'Chat customer-agent conversation flow failed.';
  let installPageUrl: string | undefined;
  let installationScriptLength: number | undefined;
  let installationScriptPreview: string | undefined;
  let w3SchoolsTryItUrl: string | undefined;
  let widgetRendered = false;
  let customerMessage: string | undefined;
  let customerMessageSent = false;
  let messageInputLocator: string | undefined;
  let sendControlLocator: string | undefined;
  let conversationsUrl: string | undefined;
  let conversationOpenStrategy: string | undefined;
  let agentMessageWaitStrategy: string | undefined;
  let agentReply: string | undefined;
  let agentReplyComposerLocator: string | undefined;
  let agentReplySendLocator: string | undefined;
  let customerReceivedReply = false;
  let secondCustomerMessage: string | undefined;
  let secondCustomerMessageReceivedByAgent = false;

  // Manual contexts don't inherit use.baseURL or the chat project viewport.
  const agentContext = await browser.newContext({
    baseURL: environment.baseUrl,
    viewport: { width: 1400, height: 900 },
  });
  const agentPage = await agentContext.newPage();

  const customerContext = await browser.newContext({
    baseURL: environment.baseUrl,
    viewport: { width: 1400, height: 900 },
  });
  const customerPage = await customerContext.newPage();

  try {
    // 1. Agent: login and extract the live chat installation script.
    await loginWithTestUser(agentPage);

    // Capture the tenant origin right after login, while the page is still on
    // a CalicoDesk origin. It must NOT be derived from page.url() later: once
    // the page navigates elsewhere (e.g. the W3Schools customer preview), the
    // origin would be wrong (https://www.w3schools.com/dashboard/conversations).
    const tenantOrigin = new URL(agentPage.url()).origin;

    await openLiveChatInstallPage(agentPage);

    installPageUrl = agentPage.url();

    const installationScript =
      await extractLiveChatInstallationScript(agentPage);

    installationScriptLength = installationScript.length;
    installationScriptPreview = installationScript.slice(0, 160);

    expect(
      installationScriptLength,
      'extracted installation script should be non-empty'
    ).toBeGreaterThan(0);

    console.log(
      `Live Chat Install page loaded: ${installPageUrl}`
    );
    console.log(
      `Installation script extracted (${installationScriptLength} chars): ${installationScriptPreview}`
    );

    // 2. Customer: render the widget on W3Schools TryIt in its own context.
    await renderChatWidgetInW3SchoolsTryIt(
      customerPage,
      installationScript
    );

    w3SchoolsTryItUrl = customerPage.url();
    widgetRendered = true;

    console.log(
      `CalicoDesk chat widget rendered in W3Schools TryIt preview: ${w3SchoolsTryItUrl}`
    );

    // 3. Customer: send the first unique message and verify it appears.
    const firstChat = await sendCustomerChatMessage(customerPage);

    customerMessage = firstChat.customerMessage;
    customerMessageSent = true;
    messageInputLocator = firstChat.messageInputLocator;
    sendControlLocator = firstChat.sendControlLocator;

    // The message must be unique for this run so the agent side can locate
    // this exact conversation later.
    expectUniqueChatMessageFormat(customerMessage, 'customer message');

    // 4. Agent: open conversations, locate the conversation by the exact
    //    customer message, open it, and verify the message arrived.
    conversationsUrl = await openAgentConversations(agentPage, tenantOrigin);

    console.log(
      `Agent conversations page loaded: ${conversationsUrl}`
    );

    conversationOpenStrategy = await findAndOpenConversationByMessage(
      agentPage,
      customerMessage
    );

    console.log(
      `Conversation located and opened via: ${conversationOpenStrategy}`
    );

    agentMessageWaitStrategy = await waitForAgentMessage(
      agentPage,
      customerMessage,
      60_000
    );

    console.log(
      `Agent UI verified first customer message via: ${agentMessageWaitStrategy}`
    );

    // 5. Agent: send a unique reply and verify it appears in the agent thread.
    const reply = uniqueAgentReply();
    const replyResult = await sendAgentReply(agentPage, reply);

    agentReply = replyResult.agentReply;
    agentReplyComposerLocator = replyResult.composerLocator;
    agentReplySendLocator = replyResult.sendLocator;

    console.log(
      `Agent reply sent using composer: ${replyResult.composerLocator}; ` +
      `send: ${replyResult.sendLocator}`
    );

    expectUniqueAgentReplyFormat(agentReply, 'agent reply');

    // 6. Customer: the reply must arrive in the widget (condition-based wait).
    await waitForWidgetMessage(customerPage, reply, 90_000);
    customerReceivedReply = true;

    console.log(
      `Customer widget received the agent reply: "${reply}"`
    );

    // 7. Customer: send a second unique message in the same conversation.
    const secondChat = await sendNewCustomerChatMessage(customerPage);

    secondCustomerMessage = secondChat.customerMessage;

    expectUniqueChatMessageFormat(
      secondCustomerMessage,
      'second customer message'
    );

    console.log(
      `Second customer message sent and verified: "${secondCustomerMessage}"`
    );

    // 8. Agent: the second customer message must appear in the open thread.
    await waitForAgentMessage(
      agentPage,
      secondCustomerMessage,
      60_000
    );
    secondCustomerMessageReceivedByAgent = true;

    message =
      'Agent logged in, extracted the installation script, and the customer rendered the ' +
      'widget on W3Schools TryIt. First customer message sent and verified in widget, then ' +
      'located and opened in CalicoDesk conversations, verified in the agent thread, agent ' +
      'replied, customer widget received the reply, second customer message sent and ' +
      'received by the agent. Full two-way conversation verified.';
    testStatus = 'passed';
  } catch (error) {
    message =
      error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const completedAtDate = new Date();

    const result: ChatPlaywrightResult = {
      runId,
      scenario: 'chat',
      environment: environment.name,
      status: testStatus,
      startedAt: startedAtDate.toISOString(),
      completedAt: completedAtDate.toISOString(),
      duration: Date.now() - startedAtMs,
      message,
      installPageUrl,
      installationScriptLength,
      installationScriptPreview,
      w3SchoolsTryItUrl,
      widgetRendered,
      customerMessage,
      customerMessageSent,
      messageInputLocator,
      sendControlLocator,
      conversationsUrl,
      conversationOpenStrategy,
      agentMessageWaitStrategy,
      agentReply,
      agentReplyComposerLocator,
      agentReplySendLocator,
      customerReceivedReply,
      secondCustomerMessage,
      secondCustomerMessageReceivedByAgent,
    };

    const resultsPath = await writeChatResult(result);

    console.log(`JSON result: ${resultsPath}`);

    await customerContext.close();
    await agentContext.close();
  }
});