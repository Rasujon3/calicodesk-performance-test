import { randomBytes } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { typeIntoInput } from './chat-widget.js';

export interface AgentReplyResult {
    agentReply: string;
    composerLocator: string;
    sendLocator: string;
}

/**
 * Module-level counter guarantees two agent replies generated in the same
 * process are always distinct, even if Date.now() happens to match (e.g. when
 * a second reply is sent shortly after the first within the same millisecond).
 * This keeps every agent message unique per run, which in turn makes
 * conversation selection unambiguous.
 */
let agentReplyCounter = 0;

/**
 * Generates a deterministic, run-unique agent reply message.
 */
export function uniqueAgentReply(): string {
    agentReplyCounter += 1;
    const nonce = `${Date.now()}-${agentReplyCounter}-${randomBytes(2).toString('hex')}`;
    return `CalicoDesk Agent Reply ${nonce}`;
}

/**
 * Opens the agent conversations page on the tenant dashboard host.
 *
 * The tenant origin must be captured while the page is still on a CalicoDesk
 * origin (e.g. right after a successful login). It must NOT be derived from
 * page.url() at call time: by the time the agent conversations are opened, the
 * page may be on a third-party host such as the W3Schools TryIt customer
 * preview, which would otherwise produce a wrong URL like
 * https://www.w3schools.com/dashboard/conversations.
 */
export async function openAgentConversations(
    page: Page,
    tenantOrigin: string,
): Promise<string> {
    const origin = new URL(tenantOrigin).origin;
    expect(
        /^https:\/\//.test(origin),
        `tenant origin must be an https URL, got "${origin}"`,
    ).toBe(true);
    const conversationsUrl = `${origin}/dashboard/conversations`;

    await page.goto(conversationsUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
    });

    await expect(
        page,
        'agent conversations page should load under /dashboard/conversations',
    ).toHaveURL(/\/dashboard\/conversations/, {
        timeout: 90_000,
    });

    return conversationsUrl;
}

/**
 * Returns locator candidates that represent the "conversation thread area".
 * These are tried first when looking for message bubbles, so the search is
 * scoped to the open conversation rather than the whole admin app (which also
 * contains sidebar lists whose previews could match).
 */
function conversationAreaCandidates(page: Page): Array<{
    description: string;
    locator: Locator;
}> {
    return [
        {
            description: '[data-testid*="conversation" i], [class*="conversation" i]',
            locator: page.locator(
                '[data-testid*="conversation" i], [class*="conversation" i]',
            ),
        },
        {
            description: '[data-testid*="thread" i], [class*="thread" i]',
            locator: page.locator(
                '[data-testid*="thread" i], [class*="thread" i]',
            ),
        },
        {
            description: '[data-testid*="chat-body" i], [class*="chat-body" i]',
            locator: page.locator(
                '[data-testid*="chat-body" i], [class*="chat-body" i]',
            ),
        },
        {
            description: '#feed-container',
            locator: page.locator('#feed-container'),
        },
        {
            description: '[role="main"]',
            locator: page.locator('[role="main"]'),
        },
        {
            description: 'main',
            locator: page.locator('main'),
        },
        {
            description: 'body (fallback)',
            locator: page.locator('body'),
        },
    ];
}


/**
 * Waits until the exact message text appears in the agent UI. Condition-based
 * only; no fixed sleeps.
 *
 * Bounded polling strategy. The agent UI is checked across MANY candidate
 * scopes (message bubbles, thread areas, whole page). A naive sequential
 * implementation waits the FULL timeout per scope, so with N scopes the worst
 * case is timeout * N, which is exactly what has repeatedly caused 5-10 minute
 * hangs. Instead we keep one shared deadline and poll EVERY scope together on
 * each iteration, returning as soon as any scope matches. Total worst-case time
 * is therefore bounded by a single timeout, independent of scope count.
 *
 * Scopes are checked in priority order:
 * 1. A real message bubble ([data-message-id]) inside a conversation thread
 *    area containing the exact message text (hasText is substring-based so
 *    split text nodes / timestamps still match).
 * 2. The conversation thread area visible text once it contains the message.
 * 3. Whole-page fallback.
 *
 * Returns the strategy that matched (for diagnostics / reporting).
 */
export async function waitForAgentMessage(
    page: Page,
    message: string,
    timeout = 90_000,
): Promise<string> {
    const bubbleScopes: Array<{ description: string; locator: Locator }> = [
        ...conversationAreaCandidates(page).map((candidate) => ({
            description: `${candidate.description} > [data-message-id]`,
            locator: candidate.locator.locator('[data-message-id]'),
        })),
        {
            description: 'page-wide [data-message-id]',
            locator: page.locator('[data-message-id]'),
        },
    ];

    const areaScopes = conversationAreaCandidates(page);
    const deadline = Date.now() + timeout;
    const pollIntervalMs = 250;

    let sawBubbleCandidate = false;
    let sawAreaCandidate = false;

    while (Date.now() < deadline) {
        for (const bubbleScope of bubbleScopes) {
            const bubble = bubbleScope.locator
                .filter({ hasText: message })
                .first();
            const count = await bubble.count().catch(() => 0);
            if (count === 0) {
                continue;
            }
            if (await bubble.isVisible().catch(() => false)) {
                return `message bubble (${bubbleScope.description}) containing the exact text`;
            }
            sawBubbleCandidate = true;
        }

        for (const candidate of areaScopes) {
            const area = candidate.locator.filter({ hasText: message }).first();
            const count = await area.count().catch(() => 0);
            if (count === 0) {
                continue;
            }
            if (await area.isVisible().catch(() => false)) {
                return `visible ${candidate.description} containing the exact text`;
            }
            sawAreaCandidate = true;
        }

        const bodyArea = page.locator('body').filter({ hasText: message }).first();
        const bodyCount = await bodyArea.count().catch(() => 0);
        if (bodyCount > 0 && (await bodyArea.isVisible().catch(() => false))) {
            return 'whole page body containing the exact text';
        }

        await page.waitForTimeout(pollIntervalMs);
    }

    throw new Error(
        `Agent UI never showed the exact message "${message}" within ${timeout}ms.\n` +
        'Checked message bubbles, conversation thread areas, and whole-page text. ' +
        `bubbleCandidateSeen=${sawBubbleCandidate}; areaCandidateSeen=${sawAreaCandidate}. ` +
        `Page URL: ${page.url()}.`,
    );
}


/**
 * Finds the conversation whose list preview contains the exact unique customer
 * message and opens it. Because every customer message is unique per run, the
 * filter can only match one row - the test never depends on conversation
 * ordering. Falls back gracefully when the conversation is already
 * open/auto-selected.
 *
 * Strategy: always click the matching row (pre-filtered by hasText so we never
 * open the wrong conversation). The sidebar list shows message preview text,
 * so we cannot assume the conversation is "already open" just because the
 * message text is visible on the page - we must click into it.
 */
export async function findAndOpenConversationByMessage(
    page: Page,
    message: string,
): Promise<string> {
    const rowCandidates: Array<{
        description: string;
        locator: Locator;
    }> = [
            {
                description: 'table row (tbody tr) with message preview',
                locator: page.locator('table tbody tr'),
            },
            {
                description: '[role="listitem"] conversation row',
                locator: page.locator('[role="listitem"]'),
            },
            {
                description: '[role="row"] conversation row',
                locator: page.locator('[role="row"]'),
            },
            {
                description:
                    '[data-testid*="conversation" i], [class*="conversation" i] row',
                locator: page.locator(
                    '[data-testid*="conversation" i], [class*="conversation" i]',
                ),
            },
            {
                description: 'list item (li) row',
                locator: page.locator('li'),
            },
        ];

    // 1. Pre-filter: find a visible row whose preview text contains the message.
    //    Short per-candidate wait -> fast failover to the next candidate type.
    for (const candidate of rowCandidates) {
        const matchingRow = candidate.locator
            .filter({ hasText: message })
            .first();

        try {
            await matchingRow.waitFor({ state: 'visible', timeout: 3_000 });
        } catch {
            continue;
        }

        // Click the matching row to open the conversation.
        await matchingRow.click({ timeout: 5_000 });

        // Verify the thread area now shows the exact message (not just the
        // sidebar preview - we need to confirm the conversation actually opened).
        // Use thread-scoped checks only, NOT the body fallback.
        try {
            await waitForThreadMessage(page, message, 8_000);
            return `conversation row (${candidate.description})`;
        } catch {
            // The thread did not load within the short window. Try the next
            // candidate type before giving up.
        }
    }

    // 2. Fallback: the conversation may already be open / auto-selected.
    //    Check thread-scoped areas only (NOT body to avoid sidebar false positives).
    try {
        await waitForThreadMessage(page, message, 8_000);
        return 'conversation already open (message visible in thread area)';
    } catch {
        throw new Error(
            `Could not find or open the conversation containing "${message}". ` +
            'Tried conversation rows: ' +
            rowCandidates.map((candidate) => candidate.description).join(', ') +
            '. No row matched and the message was not already visible in a thread area. ' +
            `Page URL: ${page.url()}.`,
        );
    }
}

/**
 * Waits for a message to appear inside a conversation THREAD area only,
 * NOT the sidebar list or page-wide body. This avoids false positives where
 * the sidebar preview text matches the message but the conversation is not
 * actually open.
 */
async function waitForThreadMessage(
    page: Page,
    message: string,
    timeout = 10_000,
): Promise<string> {
    // Thread-scoped scopes only (no body fallback).
    const bubbleScopes: Array<{ description: string; locator: Locator }> = [
        ...conversationAreaCandidates(page).map((candidate) => ({
            description: `${candidate.description} > [data-message-id]`,
            locator: candidate.locator.locator('[data-message-id]'),
        })),
    ];

    const areaScopes = conversationAreaCandidates(page);
    const deadline = Date.now() + timeout;
    const pollIntervalMs = 250;

    while (Date.now() < deadline) {
        // Check message bubbles.
        for (const bubbleScope of bubbleScopes) {
            const bubble = bubbleScope.locator
                .filter({ hasText: message })
                .first();
            const count = await bubble.count().catch(() => 0);
            if (count > 0 && (await bubble.isVisible().catch(() => false))) {
                return `message bubble (${bubbleScope.description}) containing the exact text`;
            }
        }

        // Check conversation thread areas.
        for (const candidate of areaScopes) {
            const area = candidate.locator.filter({ hasText: message }).first();
            const count = await area.count().catch(() => 0);
            if (count > 0 && (await area.isVisible().catch(() => false))) {
                return `visible ${candidate.description} containing the exact text`;
            }
        }

        await page.waitForTimeout(pollIntervalMs);
    }

    throw new Error(
        `Thread area never showed message "${message}" within ${timeout}ms. ` +
        `Page URL: ${page.url()}.`,
    );
}


/**
 * Locates the agent message composer inside the open conversation. Tries
 * conversation-thread-scoped candidates first so a sidebar search box or
 * unrelated textarea on the admin page is never mistaken for the composer.
 */
async function resolveComposer(
    page: Page,
): Promise<{ element: Locator; description: string }> {
    const scopedCandidates: Array<{ description: string; locator: Locator }> = [];

    for (const scope of conversationAreaCandidates(page)) {
        scopedCandidates.push({
            description: `textarea in ${scope.description} (message composer)`,
            locator: scope.locator.locator('textarea'),
        });
        scopedCandidates.push({
            description: `[contenteditable="true"] in ${scope.description} (composer)`,
            locator: scope.locator.locator('[contenteditable="true"]'),
        });
        scopedCandidates.push({
            description: `textbox role in ${scope.description} (composer)`,
            locator: scope.locator.getByRole('textbox'),
        });
    }

    const pageWideCandidates: Array<{ description: string; locator: Locator }> = [
        {
            description: 'textarea (message composer)',
            locator: page.locator('textarea'),
        },
        {
            description: '[contenteditable="true"] composer',
            locator: page.locator('[contenteditable="true"]'),
        },
        {
            description: 'input[type="text"] composer',
            locator: page.locator('input[type="text"]'),
        },
        {
            description: 'textbox role composer',
            locator: page.getByRole('textbox'),
        },
    ];

    const allCandidates = [...scopedCandidates, ...pageWideCandidates];

    for (const candidate of allCandidates) {
        try {
            const element = candidate.locator.first();
            await element.waitFor({ state: 'visible', timeout: 3_000 });
            return { element, description: candidate.description };
        } catch {
            // Try next candidate.
        }
    }

    throw new Error(
        'Could not locate the agent message composer (textarea, contenteditable, or textbox). ' +
        'Tried conversation-scoped candidates first, then page-wide: ' +
        allCandidates.map((candidate) => candidate.description).join(', ') +
        `. Page URL: ${page.url()}.`,
    );
}

/**
 * Locates the agent send control inside the open conversation. Falls back to
 * Enter-key submission when no visible send button exists. Never assumes a
 * specific send button label ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â order is stable so the .last() candidate used
 * here preferentially matches the composer's own submit, not a sidebar action.
 */
async function resolveSendControl(
    page: Page,
): Promise<{
    element?: Locator;
    description: string;
    usesEnter: boolean;
}> {
    const scopedCandidates: Array<{ description: string; locator: Locator }> = [];

    for (const scope of conversationAreaCandidates(page)) {
        scopedCandidates.push({
            description: `button[type="submit"] in ${scope.description}`,
            locator: scope.locator.locator('button[type="submit"]'),
        });
        scopedCandidates.push({
            description: `getByRole("button") with name /send|submit/i in ${scope.description}`,
            locator: scope.locator.getByRole('button', { name: /send|submit/i }),
        });
        scopedCandidates.push({
            description: `button[aria-label*="send" i] in ${scope.description}`,
            locator: scope.locator.locator('button[aria-label*="send" i]'),
        });
        scopedCandidates.push({
            description: `button[data-testid*="send" i] in ${scope.description}`,
            locator: scope.locator.locator('button[data-testid*="send" i]'),
        });
    }

    const pageWideCandidates: Array<{ description: string; locator: Locator }> = [
        {
            description: 'button[type="submit"]',
            locator: page.locator('button[type="submit"]'),
        },
        {
            description: 'button with aria-label containing "send"',
            locator: page.locator('button[aria-label*="send" i]'),
        },
        {
            description: 'button with aria-label containing "submit"',
            locator: page.locator('button[aria-label*="submit" i]'),
        },
        {
            description: 'button with data-testid containing "send"',
            locator: page.locator('button[data-testid*="send" i]'),
        },
    ];

    const allCandidates = [...scopedCandidates, ...pageWideCandidates];

    for (const candidate of allCandidates) {
        try {
            const element = candidate.locator.last();
            await element.waitFor({ state: 'visible', timeout: 3_000 });
            return {
                element,
                description: candidate.description,
                usesEnter: false,
            };
        } catch {
            // Try next candidate.
        }
    }

    return {
        element: undefined,
        description: 'Enter key (no visible send button found)',
        usesEnter: true,
    };
}


/**
 * If the current conversation is closed (e.g. the visitor's widget session
 * ended or timed out, marking "customer left the chat"), CalicoDesk disables the
 * composer so no reply can be typed. The admin exposes a Re-open action that
 * re-activates the conversation. This helper clicks it when present so the
 * reply can proceed.
 */
async function reopenConversationIfClosed(page: Page): Promise<boolean> {
    const reopen = page.getByRole('button', { name: 'Re-open' }).first();

    try {
        await reopen.waitFor({ state: 'visible', timeout: 2_000 });
        await reopen.click({ timeout: 3_000 });
        console.log('Conversation was closed; clicked Re-open to re-activate it.');
        return true;
    } catch {
        // No Re-open button visible - conversation is already open/live.
        return false;
    }
}

/**
 * Types a unique agent reply into the open conversation composer and verifies
 * it appears in the agent thread before returning. If the conversation was
 * closed by the visitor leaving, it is re-opened first.
 */
export async function sendAgentReply(
    page: Page,
    replyText: string,
): Promise<AgentReplyResult> {
    // If the visitor's session ended and the conversation is closed, the
    // composer is disabled. Re-open it so the reply can actually be sent.
    await reopenConversationIfClosed(page);

    const composer = await resolveComposer(page);
    const send = await resolveSendControl(page);

    // Reuse the robust keystroke-typing helper (fill() is flaky on React inputs).
    await typeIntoInput(composer.element, replyText);

    if (send.element) {
        await send.element.click({ timeout: 5_000 });
    } else {
        await composer.element.press('Enter');
    }

    // Verify the exact reply text now appears in the agent thread - both
    // directions of messaging are explicitly verified (customer->agent was
    // checked in findAndOpenConversationByMessage; here agent->agent).
    await waitForAgentMessage(page, replyText, 30_000);

    console.log(`Agent reply sent and verified in agent UI: "${replyText}"`);

    return {
        agentReply: replyText,
        composerLocator: composer.description,
        sendLocator: send.description,
    };
}

