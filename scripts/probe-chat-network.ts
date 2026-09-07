/**
 * One-off diagnostic probe: runs the real Playwright chat flow against the
 * DEV environment (https://manobik.com / https://sujon.manobik.com) and records
 * every HTTP request to a JSON file (redacted — no passwords, tokens, cookies,
 * or Authorization headers are ever written).
 *
 * The flow uses TWO SEPARATE BROWSER TABS, mirroring how a user actually works:
 *
 *   - Agent tab:  login -> live chat install page -> extract the installation
 *     script -> later open https://sujon.manobik.com/dashboard/conversations,
 *     find the new conversation row, open it, and reply.
 *
 *   - Customer tab: W3Schools TryIt -> paste the installation script into the
 *     HTML editor -> run -> open the CalicoDesk chat widget -> send a message.
 *     This tab stays open the whole time so it can receive the agent reply.
 *
 * The agent reply is verified back on the customer tab, inside the still-open
 * widget. The customer tab is NEVER navigated away from — that is what makes
 * the reply visible. (A single-page flow that navigates to the agent dashboard
 * destroys the widget and can never show the reply.)
 *
 * After the run it prints a trimmed table grouped by the business action that
 * triggered the requests, and writes the full redacted log to
 * scenarios/chat/results/playwright/probe-network/<runId>/network.json.
 *
 * Run:  npx tsx scripts/probe-chat-network.ts
 *       Requires .env with TEST_USER_EMAIL / TEST_USER_PASSWORD (dev).
 *
 * Only inspects the DEV site. Not part of the k6 scenario.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium, type BrowserContext } from 'playwright';
import { config as loadEnv } from 'dotenv';
import { environment } from '../config/environments.js';
import { loginWithTestUser } from '../shared/playwright/auth.js';
import {
    sendCustomerChatMessage,
    waitForWidgetMessage,
} from '../shared/playwright/chat-widget.js';
import { renderChatWidgetInW3SchoolsTryIt } from '../shared/playwright/w3schools-tryit.js';
import {
    findAndOpenConversationByMessage,
    openAgentConversations,
    sendAgentReply,
    uniqueAgentReply,
    waitForAgentMessage,
} from '../shared/playwright/agent-conversations.js';
import { extractLiveChatInstallationScript, openLiveChatInstallPage } from '../shared/playwright/live-chat-install.js';

loadEnv();

interface RecordedRequest {
    action: string;
    method: string;
    url: string;
    resourceType: string;
    purpose?: string;
    status?: number;
    responseContentType?: string;
    responseBodySample?: string;
    /** Redacted POST body sample for whitelisted widget endpoints only. */
    requestBodySample?: string;
    requiresAuth?: boolean;
    essential?: boolean;
}

const ESSENTIAL_KEYWORDS = [
    '/login',
    '/logout',
    '/livechat',
    '/lc/',
    '/widget',
    '/conversations',
    '/messages',
    '/chats',
    '/api/',
];

/** Basic classification: is this an essential chat API call, analytics, or UI? */
function classifyRequest(
    url: string,
    contentType: string | undefined,
): { purpose: string; essential: boolean } {
    const u = url.toLowerCase();

    if (
        /\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|ico|map|json)$/.test(u)
    ) {
        return { purpose: 'static asset', essential: false };
    }

    if (
        /(analytics|telemetry|segment|mixpanel|amplitude|gtm|beacon|clarity|sentry|bugsnag|datadog|hotjar|fullstory|newrelic|googletagmanager)\//i.test(
            u,
        )
    ) {
        return { purpose: 'analytics/tracking', essential: false };
    }

    if (
        contentType?.includes('json') ||
        ESSENTIAL_KEYWORDS.some((keyword) => u.includes(keyword))
    ) {
        return { purpose: 'application API', essential: true };
    }

    return { purpose: 'UI/document', essential: false };
}

/** Whitelisted widget POST endpoints whose redacted body we sample. */
const PLAYWRIGHT_SAFE_POST_ENDPOINTS = [
    '/lc/widget/broadcasting/auth',
    '/api/v1/lc/widget/visits',
    '/api/v1/lc/widget/chats?workspaceId=',
];

/**
 * Attaches the redacted network recorder to a context. Both contexts (agent
 * and customer) are recorded into the same records array; requests are
 * deduplicated per (action, method, url).
 */
function attachNetworkRecorder(
    context: BrowserContext,
    records: RecordedRequest[],
    activeAction: { current: string },
): void {
    context.on('request', async (request) => {
        const url = request.url();
        const method = request.method();
        const resourceType = request.resourceType();

        const existing = records.find(
            (record) =>
                record.action === activeAction.current &&
                record.method === method &&
                record.url === url,
        );
        if (existing) {
            return;
        }

        const record: RecordedRequest = {
            action: activeAction.current,
            method,
            url,
            resourceType,
        };

        // Redacted POST body for the whitelisted widget endpoints only.
        if (
            method === 'POST' &&
            PLAYWRIGHT_SAFE_POST_ENDPOINTS.some((endpoint) =>
                url.includes(endpoint),
            )
        ) {
            const body = request.postData();
            if (body) {
                record.requestBodySample = body
                    .replace(
                        /(password|passwd|pwd|token|authorization)(=|\s*:\s*)[^&,}\s]{0,80}/gi,
                        '$1$2(redacted)',
                    )
                    .slice(0, 300);
            }
        }

        records.push(record);
    });

    context.on('response', async (response) => {
        const request = response.request();
        const url = request.url();
        const method = request.method();

        const record = records.find(
            (r) =>
                r.action === activeAction.current &&
                r.method === method &&
                r.url === url,
        );
        if (!record) {
            return;
        }

        record.status = response.status();
        record.responseContentType =
            response.headers()['content-type']?.split(';')[0] ?? undefined;

        const classification = classifyRequest(url, record.responseContentType);
        record.purpose = classification.purpose;
        record.essential = classification.essential;

        // A safe, tiny body sample only for JSON API responses that are likely
        // part of the chat business API. Never include request body (it could
        // contain a password or message with a secret); only sample GET response
        // JSON. Response bodies of the app are considered non-sensitive here but
        // we truncate heavily and only keep JSON keys.
        if (
            record.essential &&
            method === 'GET' &&
            record.responseContentType?.includes('json')
        ) {
            try {
                const text = await response.text();
                record.responseBodySample = text.slice(0, 400);
            } catch {
                // Body unavailable (redirect, stream, aborted) — fine.
            }
        }

        // Mark requiresAuth from URL/origin rather than headers to avoid leaking.
        const isCalico = url.includes('manobik.com');
        const isAuthEndpoint = /\/login|\/session|\/auth\//i.test(url);
        record.requiresAuth = isCalico && !isAuthEndpoint;
    });
}

async function main(): Promise<void> {
    const runId = `network-probe-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const outputDirectory = path.resolve(
        `scenarios/chat/results/playwright/probe-network/${runId}`,
    );
    await mkdir(outputDirectory, { recursive: true });

    console.log(
        `Network probe on ${environment.name} (${environment.baseUrl}). Output: ${outputDirectory}`,
    );

    const browser = await chromium.launch({ headless: false });

    // Two separate contexts = two separate browser tabs, exactly like a real
    // user: the agent works in one tab, the customer in the other. The customer
    // tab (W3Schools) is never navigated away from.
    const agentContext = await browser.newContext({
        baseURL: environment.baseUrl,
        viewport: { width: 1400, height: 900 },
    });
    const customerContext = await browser.newContext({
        baseURL: environment.baseUrl,
        viewport: { width: 1400, height: 900 },
    });

    const records: RecordedRequest[] = [];
    const activeAction = { current: 'login/session establishment (agent)' };

    attachNetworkRecorder(agentContext, records, activeAction);
    attachNetworkRecorder(customerContext, records, activeAction);

    const agentPage = await agentContext.newPage();
    const customerPage = await customerContext.newPage();

    try {
        // --- 1. Agent tab: login/session establishment ---
        console.log('[1] Logging in (agent tab, dev)...');
        await loginWithTestUser(agentPage);

        // Capture the tenant origin while the page is still on a CalicoDesk
        // origin. It must NOT be derived from page.url() later: by the time the
        // agent conversations are opened, the agentPage may be anywhere, and
        // the customerPage is on W3Schools.
        const tenantOrigin = new URL(agentPage.url()).origin;

        // --- 2. Agent tab: live chat installation/config ---
        activeAction.current = 'live chat installation/config retrieval';
        console.log('[2] Opening live chat install page (agent tab)...');
        await openLiveChatInstallPage(agentPage);
        const installationScript =
            await extractLiveChatInstallationScript(agentPage);
        console.log(`    script: ${installationScript}`);

        // --- 3. Customer tab (NEW tab): widget initialization ---
        activeAction.current = 'chat widget initialization (customer)';
        console.log(
            '[3] Rendering widget on W3Schools TryIt (customer tab)...',
        );
        await renderChatWidgetInW3SchoolsTryIt(
            customerPage,
            installationScript,
        );
        console.log(
            '    Customer W3Schools tab stays open for the whole run (never navigated away).',
        );

        // --- 4. Customer message #1 (creates the conversation row) ---
        activeAction.current = 'customer message #1';
        console.log('[5] Sending customer message #1 (customer tab)...');
        const first = await sendCustomerChatMessage(customerPage);
        console.log(`    message: ${first.customerMessage}`);

        // --- 5. Agent tab: open conversations and find the new row ---
        activeAction.current = 'agent conversation retrieval/polling';
        console.log(
            '[6] Opening agent conversations (agent tab) and locating the row...',
        );
        const conversationsUrl = await openAgentConversations(
            agentPage,
            tenantOrigin,
        );
        console.log(`    conversations page: ${conversationsUrl}`);
        await findAndOpenConversationByMessage(
            agentPage,
            first.customerMessage,
        );

        // --- 6. Agent tab: reply #1 ---
        activeAction.current = 'agent reply #1';
        console.log('[7] Sending agent reply (agent tab)...');
        const reply = uniqueAgentReply();
        await sendAgentReply(agentPage, reply);

        // --- 7. Customer tab: the reply must appear in the open widget ---
        activeAction.current = 'customer receiving agent reply';
        console.log(
            '[8] Switching back to the customer tab and waiting for the reply in the widget...',
        );
        await waitForWidgetMessage(customerPage, reply, 60_000);
        console.log(`    ✓ Customer widget received the reply: "${reply}"`);

        // --- 8. Customer tab: message #2 in the same conversation ---
        activeAction.current = 'customer message #2';
        console.log('[9] Sending customer message #2 (customer tab)...');
        const second = await sendCustomerChatMessage(customerPage);
        console.log(`    message: ${second.customerMessage}`);

        // --- 9. Agent tab: verify customer message #2 ---
        activeAction.current = 'agent receiving customer message #2';
        console.log('[10] Agent waiting for customer message #2...');
        await waitForAgentMessage(agentPage, second.customerMessage, 60_000);
        console.log(
            `    ✓ Agent verified customer message #2: "${second.customerMessage}"`,
        );
    } catch (error) {
        console.error(
            'Probe flow failed (investigation continues):',
            error instanceof Error ? error.message : error,
        );
    } finally {
        // Dedup final table.
        console.log('\n=== NETWORK REQUEST LOG (deduped, redacted) ===');
        const seen = new Set<string>();
        const deduped: Array<RecordedRequest> = [];
        for (const record of records) {
            const key = `${record.action}|${record.method}|${record.url}`;
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(record);
        }

        for (const record of deduped) {
            const purpose = record.purpose ?? '?';
            const essential = record.essential === true ? 'YES' : 'no';
            const status = record.status ?? '?';
            console.log(
                `[${record.action}] ${record.method} ${record.status ?? '?'} ${record.url} | type=${record.resourceType} | status=${status} | purpose=${purpose} | auth=${record.requiresAuth ?? '?'} | essential=${essential}`,
            );
        }

        await writeFile(
            path.join(outputDirectory, 'network.json'),
            JSON.stringify(deduped, null, 2),
            'utf8',
        );
        console.log(
            `\nFull redacted log: ${path.join(outputDirectory, 'network.json')}`,
        );

        await customerContext.close();
        await agentContext.close();
        await browser.close();
    }
}

void main();