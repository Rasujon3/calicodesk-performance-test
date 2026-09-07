/**
 * One-off diagnostic probe: logs in, opens the CalicoDesk agent conversations
 * page, finds the row containing a known test message, opens the conversation,
 * and dumps the DOM structure (page + frames) over time so the conversation-
 * thread locators used by waitForAgentMessage / resolveComposer /
 * resolveSendControl can be confirmed against the real admin UI.
 *
 * Run:  TEST_ENV=dev npx tsx scripts/probe-conversation.ts [message]
 *       (message defaults to the last known test message otherwise)
 *
 * No credentials are logged. TEST_USER_EMAIL / TEST_USER_PASSWORD come from
 * the environment (.env).
 */
import { chromium, type Locator, type Page } from 'playwright';
import { environment } from '../config/environments.js';
import { loginWithTestUser } from '../shared/playwright/auth.js';

const MESSAGE =
    process.argv[2] ?? 'CalicoDesk Chat Test 1788703722378-f2a61e2a';

async function dumpCandidate(
    label: string,
    locator: Locator,
    maxSnippets = 2,
    snippetLength = 500,
): Promise<void> {
    const count = await locator.count();
    console.log(`\n--- ${label}: count=${count}`);

    if (count === 0) {
        return;
    }

    for (let i = 0; i < Math.min(count, maxSnippets); i += 1) {
        const html = await locator
            .nth(i)
            .evaluate((el) => el.outerHTML)
            .catch(() => '(evaluate failed)');
        console.log(
            `  [${i}] ${html.slice(0, snippetLength).replace(/\s+/g, ' ')}`,
        );
    }
}

async function dumpFrames(page: Page): Promise<void> {
    console.log(`\n--- frames: count=${page.frames().length}`);
    for (const frame of page.frames()) {
        const url = frame.url();
        const bodyText = await frame
            .locator('body')
            .innerText()
            .catch(() => '');
        console.log(
            `  frame url=${url} | body chars=${bodyText.length} | includes message=${bodyText.includes(MESSAGE)}`,
        );
    }
}

async function snapshot(page: Page, label: string): Promise<void> {
    const bodyText = await page.locator('body').innerText().catch(() => '');
    console.log(`\n[snapshot ${label}] url=${page.url()}`);
    console.log(
        `  body innerText (first 1200 chars): ${bodyText.slice(0, 1200).replace(/\s+/g, ' ')}`,
    );
    console.log(`  body includes message: ${bodyText.includes(MESSAGE)}`);
    await dumpFrames(page);
}

async function main(): Promise<void> {
    console.log(`Probing conversation containing message: "${MESSAGE}"`);
    console.log(`Environment: ${environment.name} (${environment.baseUrl})`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        baseURL: environment.baseUrl,
        viewport: { width: 1400, height: 900 },
    });
    const page = await context.newPage();

    try {
        await loginWithTestUser(page);

        const origin = new URL(page.url()).origin;
        const conversationsUrl = `${origin}/dashboard/conversations`;
        await page.goto(conversationsUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 90_000,
        });
        console.log(`\nConversations page: ${page.url()}`);

        // Find the row containing the exact message.
        const rowCandidates: Array<{ description: string; locator: Locator }> = [
            {
                description: 'table tbody tr',
                locator: page.locator('table tbody tr'),
            },
            {
                description: '[role="listitem"]',
                locator: page.locator('[role="listitem"]'),
            },
            {
                description: '[role="row"]',
                locator: page.locator('[role="row"]'),
            },
            {
                description: '[data-testid*="conversation" i], [class*="conversation" i]',
                locator: page.locator('[data-testid*="conversation" i], [class*="conversation" i]'),
            },
            {
                description: 'li',
                locator: page.locator('li'),
            },
        ];

        let rowLocator: Locator | undefined;
        let rowDescription = '';

        for (const candidate of rowCandidates) {
            const row = candidate.locator.filter({ hasText: MESSAGE }).first();
            const visible = await row
                .waitFor({ state: 'visible', timeout: 20_000 })
                .then(() => true)
                .catch(() => false);

            if (visible) {
                rowLocator = row;
                rowDescription = candidate.description;
                break;
            }
        }

        if (!rowLocator) {
            console.log('\nNo conversation row matched the message on this page.');
            await snapshot(page, 'no-row-found');
            return;
        }

        console.log(`\nRow matched via: ${rowDescription}`);
        await dumpCandidate('matched row outerHTML', rowLocator, 1, 800);

        await snapshot(page, 'before-click');

        // NOTE: a plain row.click() did NOT open the conversation in earlier
        // probes (URL stayed ?viewId=all, body remained the list). Try several
        // interaction styles and stop at the first that switches to a detail
        // view / reveals a thread area. All are condition-based; no fixed sleeps.
        const interactions: Array<{ description: string; run: () => Promise<void> }> = [
            {
                description: 'click the row element itself',
                run: () => rowLocator!.click(),
            },
            {
                description: 'click the first gridcell (summary cell)',
                run: () => rowLocator!.locator('[role="gridcell"]').first().click(),
            },
            {
                description: 'double-click the row element',
                run: () => rowLocator!.dblclick(),
            },
            {
                description: 'click the message summary text',
                run: () =>
                    rowLocator!
                        .getByText(MESSAGE, { exact: false })
                        .first()
                        .click(),
            },
        ];

        let opened = false;
        for (const interaction of interactions) {
            console.log(`\n--- trying interaction: ${interaction.description}`);
            await interaction.run().catch((error: unknown) => {
                console.log(
                    `  interaction failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            });

            // Wait (condition-based) until a detail pane appears — anything
            // beyond the list body: a textarea, message bubble, thread
            // container, or the URL moving away from ?viewId=all.
            for (let probe = 1; probe <= 6; probe += 1) {
                const detailVisible = await page
                    .locator(
                        'textarea, [data-message-id], [class*="thread" i], [class*="chat-body" i]',
                    )
                    .first()
                    .waitFor({ state: 'visible', timeout: 5_000 })
                    .then(() => true)
                    .catch(() => false);

                const urlChanged = !page.url().includes('viewId=all');
                if (detailVisible || urlChanged) {
                    console.log(
                        `  [probe ${probe}] detail pane visible: ${detailVisible}, url changed: ${urlChanged}`,
                    );
                    opened = true;
                    break;
                }
                console.log(`  [probe ${probe}] waiting for detail pane...`);
                await dumpFrames(page);
            }

            if (opened) {
                break;
            }
        }

        if (!opened) {
            console.log('\nNone of the interactions opened a conversation detail pane.');
        }

        await snapshot(page, 'after-transition');

        console.log('\n========== AGENT THREAD DOM DUMP ==========');

        await dumpCandidate('[data-message-id]', page.locator('[data-message-id]'), 4, 400);

        await dumpCandidate(
            '[data-testid*="conversation" i], [class*="conversation" i]',
            page.locator('[data-testid*="conversation" i], [class*="conversation" i]'),
            4,
            400,
        );
        await dumpCandidate(
            '[data-testid*="thread" i], [class*="thread" i]',
            page.locator('[data-testid*="thread" i], [class*="thread" i]'),
            3,
            400,
        );
        await dumpCandidate(
            '[data-testid*="chat-body" i], [class*="chat-body" i]',
            page.locator('[data-testid*="chat-body" i], [class*="chat-body" i]'),
            3,
            400,
        );
        await dumpCandidate('#feed-container', page.locator('#feed-container'), 2, 600);

        await dumpCandidate('textarea', page.locator('textarea'), 4, 400);
        await dumpCandidate('[contenteditable="true"]', page.locator('[contenteditable="true"]'), 2, 400);
        await dumpCandidate('input[type="text"]', page.locator('input[type="text"]'), 4, 300);

        await dumpCandidate('button[type="submit"]', page.locator('button[type="submit"]'), 4, 300);
        await dumpCandidate(
            'button[aria-label*="send" i]',
            page.locator('button[aria-label*="send" i]'),
            4,
            300,
        );
        await dumpCandidate(
            'button[aria-label*="submit" i]',
            page.locator('button[aria-label*="submit" i]'),
            4,
            300,
        );
        await dumpCandidate(
            'getByRole button name /send|submit/i',
            page.getByRole('button', { name: /send|submit/i }),
            4,
            300,
        );
    } finally {
        await browser.close();
    }
}

void main();