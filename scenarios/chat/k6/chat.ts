import http from 'k6/http';
import { check, sleep } from 'k6';
import { getK6ProfileOptions } from '../../../config/load-profiles.js';

/*
 * k6 chat scenario: real two-actor chat conversation (visitor + agent)
 * reproduced against the captured CalicoDesk widget API contract.
 *
 * Proven API contract (captured 2026-09-07 from the two-actor Playwright
 * flow and re-verified with plain-HTTP probes):
 *
 * WIDGET (anonymous visitor / embed):
 *   GET  {tenant}/lc/widget?subdomain={sub}&embedParentOrigin={origin}
 *        -> 200 for browser-class User-Agents; sets widget cookies
 *           (XSRF-TOKEN, calicodesk-dev-session, lc_widget_customer)
 *   POST {tenant}/api/v1/lc/widget/visits
 *        {"url","title","session_id","started_at"}
 *   POST {tenant}/api/v1/lc/widget/chats?workspaceId={id} (text/event-stream)
 *        {"message":{"body","attachments":[],"uuid"},"startWithGreeting":true}
 *        -> SSE first frame: {"type":"conversationCreated",
 *           "data":{"conversation":{"id":<id>},...}}
 *   POST {tenant}/api/v1/lc/widget/chats/{id}/messages?workspaceId={id}
 *        {"message":{"body","attachments":[],"uuid"}}
 *   GET  {tenant}/api/v1/lc/widget/conversations/{id}?workspaceId={id}
 *   GET  {tenant}/api/v1/lc/widget/chats/{id}/messages?workspaceId={id}
 *        -> {"pagination":{"data":[{id,type,author,body,...}]}}
 *
 * Widget requests require the widget cookies plus:
 *   X-XSRF-TOKEN: <url-decoded XSRF-TOKEN cookie>
 *   X-Chat-Widget: true
 *   X-Embed-Parent-Origin: <embed origin>
 *   User-Agent: a browser-class UA (the /lc/widget doc 401s generic UAs)
 *
 * AGENT (authenticated helpdesk user):
 *   POST {sso}/api/v1/tenant/find-workspaces-by-email
 *   POST {tenant}/auth/login
 *        {"email","password","remember":false,"token_name":"web",
 *         "login_context":"default"} -> {"access_token","token_type":"Bearer"}
 *   GET  {tenant}/api/v1/helpdesk/agent/conversations/{id}?workspaceId={id}
 *   GET  {tenant}/api/v1/helpdesk/agent/conversations/{id}/messages?workspaceId={id}
 *   POST {tenant}/api/v1/helpdesk/agent/conversations/{id}/messages?workspaceId={id}
 *        {"status_id":null,"type":"message","attachments":[],"tags":[],
 *         "body":"<p>reply</p>","author":"agent","uuid"} -> 201
 *
 * Agent requests require only: Authorization: Bearer <access_token>.
 *
 * The agent session (workspace + Bearer token) is bootstrapped once in
 * setup() and shared by every VU. k6 embeds the setup() return value in
 * --summary-export; the k6 runner strips `setup_data` from the persisted
 * summary so the token never reaches the reports/results directories.
 */

const profile = __ENV.K6_PROFILE ?? 'smoke';

const overrideVusRaw = __ENV.K6_VUS?.trim();
const overrideVus =
  overrideVusRaw && /^\d+$/.test(overrideVusRaw)
    ? Number(overrideVusRaw)
    : undefined;

export const options = {
  ...getK6ProfileOptions(profile, overrideVus),

  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

// ---------------------------------------------------------------------------
// Small helpers (all plain JS; no Node built-ins at runtime)
// ---------------------------------------------------------------------------

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

function requireEnv(name: string): string {
  const value = __ENV[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is not configured. The k6 runner must inject it before the chat scenario runs.`
    );
  }

  return value;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function logRequest(
  url: string,
  response: { status: number; error: string; body?: unknown }
): void {
  console.log(
    `k6 request | URL: ${url} | Status: ${response.status} | ` +
      `Error: ${response.error ?? ''}`
  );
}

function randHex(length: number): string {
  const hex = '0123456789abcdef';
  let out = '';

  for (let i = 0; i < length; i += 1) {
    out += hex[Math.floor(Math.random() * 16)];
  }

  return out;
}

/** RFC-4122-ish random UUID (k6 has no crypto.randomUUID). */
function uuidv4(): string {
  return (
    randHex(8) +
    '-' +
    randHex(4) +
    '-4' +
    randHex(3) +
    '-a' +
    randHex(3) +
    '-' +
    randHex(12)
  );
}

/** Random client-generated message id (the server accepts arbitrary ids). */
function clientId(prefix: string): string {
  return `${prefix}${randHex(16)}`;
}

let messageCounter = 0;

function uniqueMessage(kind: 'visitor' | 'reply', nonce: number): string {
  messageCounter += 1;

  const base = `${Date.now()}-${messageCounter}-${nonce}-${randHex(3)}`;

  return kind === 'visitor'
    ? `CalicoDesk Chat Test ${base}`
    : `CalicoDesk Agent Reply ${base}`;
}

/**
 * The Set-Cookie value is stored URL-encoded (e.g. "%3D"); the SPA sends it
 * URL-decoded in the X-XSRF-TOKEN header.
 */
function percentDecode(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

/** Extract the conversation id from the chat-creation SSE stream. */
function extractConversationId(body: string): number {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed.startsWith('data:')) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed.slice(5).trim());

      if (
        parsed &&
        parsed.type === 'conversationCreated' &&
        parsed.data &&
        parsed.data.conversation &&
        typeof parsed.data.conversation.id === 'number'
      ) {
        return parsed.data.conversation.id;
      }
    } catch {
      // fall through to the next frame / regex
    }
  }

  const match = body.match(/"conversation":\{"id":(\d+)/);

  return match ? Number(match[1]) : 0;
}

/** Message bodies from {"pagination":{"data":[{body,...},...]}} responses. */
function messageBodies(json: unknown): string[] {
  try {
    const root = json as {
      pagination?: { data?: Array<{ body?: unknown }> };
      data?: Array<{ body?: unknown }>;
    };

    const items = root?.pagination?.data ?? root?.data ?? [];

    return items
      .map((item) => String(item?.body ?? ''))
      .filter((body) => body.length > 0);
  } catch {
    return [];
  }
}

/** Poll a messages endpoint until `predicate` matches; returns true on match. */
function pollFor(
  label: string,
  url: string,
  headers: Record<string, string>,
  predicate: (bodies: string[]) => boolean,
  maxAttempts: number
): boolean {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = http.get(url, { headers });

    if (response.status === 200) {
      const bodies = messageBodies(response.json());

      if (predicate(bodies)) {
        return true;
      }
    }

    if (attempt < maxAttempts - 1) {
      sleep(1);
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Agent session (one shared authenticated agent across all VU iterations)
// ---------------------------------------------------------------------------

interface AgentSession {
  tenantBaseUrl: string;
  workspaceId: number;
  accessToken: string;
}

export function setup(): AgentSession {
  const ssoBaseUrl = stripTrailingSlash(requireEnv('BASE_URL'));
  const email = requireEnv('TEST_USER_EMAIL');
  const password = requireEnv('TEST_USER_PASSWORD');

  const jsonHeaders = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  // --- Workspace lookup (SSO) ---------------------------------------------
  const lookupUrl = `${ssoBaseUrl}/api/v1/tenant/find-workspaces-by-email`;
  const lookupRes = http.post(
    lookupUrl,
    JSON.stringify({ email }),
    { headers: jsonHeaders }
  );

  logRequest(lookupUrl, lookupRes);

  let workspaceId = 0;
  let tenantBaseUrl = '';

  try {
    const lookupBody = lookupRes.json() as {
      workspaces?: Array<{
        id?: unknown;
        base_url?: unknown;
      }>;
    };

    const workspace = lookupBody?.workspaces?.[0];

    workspaceId = Number(workspace?.id ?? 0);
    tenantBaseUrl = stripTrailingSlash(
      String(workspace?.base_url ?? '')
    );
  } catch {
    workspaceId = 0;
    tenantBaseUrl = '';
  }

  check(lookupRes, {
    'chat setup: workspace lookup status is 200': (response) =>
      response.status === 200,
    'chat setup: workspace id and base url resolved': () =>
      workspaceId > 0 && tenantBaseUrl.length > 0,
  });

  if (!(workspaceId > 0) || !tenantBaseUrl) {
    throw new Error(
      'Chat setup failed: could not resolve the workspace from the lookup response.'
    );
  }

  // --- Agent login --------------------------------------------------------
  // Dev Fortify login limiter allows ~5 logins/min per email+IP, so retry
  // with spacing when the login is throttled (429) or otherwise fails.
  let accessToken = '';
  const loginUrl = `${tenantBaseUrl}/auth/login`;
  const loginPayload = JSON.stringify({
    email,
    password,
    remember: false,
    token_name: 'web',
    login_context: 'default',
  });

  for (let attempt = 0; attempt < 6 && !accessToken; attempt += 1) {
    const loginRes = http.post(
      loginUrl,
      loginPayload,
      { headers: jsonHeaders }
    );

    logRequest(loginUrl, loginRes);

    try {
      const loginBody = loginRes.json() as {
        access_token?: unknown;
        token_type?: unknown;
      };

      if (
        typeof loginBody.access_token === 'string' &&
        loginBody.access_token.length > 0 &&
        loginBody.token_type === 'Bearer'
      ) {
        accessToken = loginBody.access_token;
      }
    } catch {
      accessToken = '';
    }

    if (!accessToken) {
      check(loginRes, {
        'chat setup: agent login throttled before success': () => true,
      });

      if (attempt < 5) {
        sleep(12);
      }
    }
  }

  check(loginUrl, {
    'chat setup: agent login returns a Bearer access_token': () =>
      accessToken.length > 0,
  });

  if (!accessToken) {
    throw new Error('Chat setup failed: agent login did not return a token.');
  }

  return {
    tenantBaseUrl,
    workspaceId,
    accessToken,
  };
}

// ---------------------------------------------------------------------------
// Two-actor chat iteration (visitor + agent)
// ---------------------------------------------------------------------------

export default function (agent: AgentSession) {
  const tenant = stripTrailingSlash(agent.tenantBaseUrl);
  const workspaceId = agent.workspaceId;

  const tenantHost = tenant.replace(/^https?:\/\//, '').split('/')[0];
  const hostLabels = tenantHost.split('.').filter(Boolean);
  const subdomain = hostLabels.length > 2 ? hostLabels[0] : '';

  // Stable per-VU embed origin (analogous to the local fixture page).
  const embedOrigin = `https://k6-chat-${__VU}.example.com`;

  const agentHeaders: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${agent.accessToken}`,
  };

  // ===================== Side A: anonymous visitor =========================

  // 1. Widget document bootstrap -> sets the widget cookies on the parent
  //    domain. Requires a browser-class User-Agent.
  const widgetDocUrl =
    `${tenant}/lc/widget?subdomain=${encodeURIComponent(subdomain)}` +
    `&embedParentOrigin=${encodeURIComponent(embedOrigin)}`;

  const widgetDocRes = http.get(widgetDocUrl, {
    headers: {
      'User-Agent': CHROME_UA,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  logRequest(widgetDocUrl, widgetDocRes);

  check(widgetDocRes, {
    'widget: document loaded (HTTP 200)': (response) =>
      response.status === 200,
  });

  // 2. Derive the SPA XSRF header from the widget XSRF-TOKEN cookie.
  const xsrfCookie = http
    .cookieJar()
    .cookiesForURL(tenant)['XSRF-TOKEN'];

  const xsrfHeader = xsrfCookie ? percentDecode(String(xsrfCookie)) : '';

  check(null as unknown as { status: number }, {
    'widget: XSRF token cookie established': () => xsrfHeader.length > 0,
  });

  if (!xsrfHeader) {
    // The document returned 200 but no XSRF cookie arrived; cannot continue.
    return;
  }

  const widgetHeaders: Record<string, string> = {
    'User-Agent': CHROME_UA,
    Accept: 'application/json',
    'X-XSRF-TOKEN': xsrfHeader,
    'X-Chat-Widget': 'true',
    'X-Embed-Parent-Origin': embedOrigin,
  };

  const widgetPostHeaders: Record<string, string> = {
    ...widgetHeaders,
    'Content-Type': 'application/json',
  };

  // 3. Widget bootstrap endpoints (faithful sequence from the capture).
  http.get(
    `${tenant}/api/v1/lc/widget/campaigns?workspaceId=${workspaceId}`,
    { headers: widgetHeaders }
  );

  http.get(
    `${tenant}/api/v1/lc/widget/home-article-list?workspaceId=${workspaceId}`,
    { headers: widgetHeaders }
  );

  http.get(
    `${tenant}/api/v1/lc/widget/customer?workspaceId=${workspaceId}`,
    { headers: widgetHeaders }
  );

  // 4. Visit tracking.
  const visitsUrl = `${tenant}/api/v1/lc/widget/visits`;
  const visitsRes = http.post(
    visitsUrl,
    JSON.stringify({
      url: `${embedOrigin}/embed.html?loaderUrl=${encodeURIComponent(
        `${tenant}/livechat-loader.js`
      )}`,
      title: 'Example Website — CalicoDesk Live Chat Embed Fixture',
      session_id: uuidv4(),
      started_at: new Date().toISOString(),
    }),
    { headers: widgetPostHeaders }
  );

  logRequest(visitsUrl, visitsRes);

  check(visitsRes, {
    'widget: visit created (HTTP 200)': (response) =>
      response.status === 200,
  });

  // 5. Chat creation + visitor message #1 (SSE response).
  const chatCreateUrl =
    `${tenant}/api/v1/lc/widget/chats?workspaceId=${workspaceId}`;
  const message1 = uniqueMessage('visitor', 1);

  const chatCreateRes = http.post(
    chatCreateUrl,
    JSON.stringify({
      message: {
        body: message1,
        attachments: [],
        uuid: clientId('k6vis'),
      },
      startWithGreeting: true,
    }),
    {
      headers: {
        ...widgetPostHeaders,
        Accept: 'text/event-stream',
      },
    }
  );

  logRequest(chatCreateUrl, chatCreateRes);

  const sseBody = String(chatCreateRes.body ?? '');
  const conversationId = extractConversationId(sseBody);

  check(chatCreateRes, {
    'chat: creation SSE stream accepted': (response) =>
      response.status === 200,
    'chat: conversation id parsed from SSE stream': () =>
      conversationId > 0,
  });

  check(null as unknown as { status: number }, {
    'chat: message #1 persisted on create': () =>
      sseBody.includes(message1),
  });

  if (!(conversationId > 0)) {
    return;
  }

  // 6. Widget conversation detail + message list.
  const widgetConvRes = http.get(
    `${tenant}/api/v1/lc/widget/conversations/${conversationId}` +
      `?workspaceId=${workspaceId}`,
    { headers: widgetHeaders }
  );

  check(widgetConvRes, {
    'widget: conversation detail is HTTP 200': (response) =>
      response.status === 200,
  });

  // ===================== Side B: authenticated agent =======================

  // 7. Agent loads the conversation created by the visitor.
  const agentConvUrl =
    `${tenant}/api/v1/helpdesk/agent/conversations/${conversationId}` +
    `?workspaceId=${workspaceId}`;

  const agentConvRes = http.get(agentConvUrl, {
    headers: agentHeaders,
  });

  logRequest(agentConvUrl, agentConvRes);

  check(agentConvRes, {
    'agent: can load the conversation (HTTP 200)': (response) =>
      response.status === 200,
  });

  // 8. Agent sends the first reply.
  const agentReplyUrl =
    `${tenant}/api/v1/helpdesk/agent/conversations/${conversationId}` +
    `/messages?workspaceId=${workspaceId}`;
  const replyText = uniqueMessage('reply', 1);

  const agentReplyRes = http.post(
    agentReplyUrl,
    JSON.stringify({
      status_id: null,
      type: 'message',
      attachments: [],
      tags: [],
      body: `<p>${replyText}</p>`,
      author: 'agent',
      uuid: clientId('k6ag'),
    }),
    {
      headers: {
        ...agentHeaders,
        'Content-Type': 'application/json',
      },
    }
  );

  logRequest(agentReplyUrl, agentReplyRes);

  check(agentReplyRes, {
    'agent: reply accepted (HTTP 201)': (response) =>
      response.status === 201,
  });

  // 9. Visitor polls until the agent reply arrives.
  const widgetMessagesUrl =
    `${tenant}/api/v1/lc/widget/chats/${conversationId}` +
    `/messages?workspaceId=${workspaceId}`;

  const visitorSawReply = pollFor(
    'visitor receives agent reply',
    widgetMessagesUrl,
    widgetHeaders,
    (bodies) => bodies.some((body) => body.includes(replyText)),
    12
  );

  check(null as unknown as { status: number }, {
    'chat: visitor received the agent reply': () => visitorSawReply,
  });

  // 10. Visitor sends message #2 to the existing conversation.
  const message2 = uniqueMessage('visitor', 2);

  const msg2Res = http.post(
    widgetMessagesUrl,
    JSON.stringify({
      message: {
        body: message2,
        attachments: [],
        uuid: clientId('k6vis'),
      },
    }),
    { headers: widgetPostHeaders }
  );

  logRequest(widgetMessagesUrl, msg2Res);

  check(msg2Res, {
    'chat: visitor message #2 accepted': (response) =>
      response.status === 200 || response.status === 201,
  });

  // 11. Agent polls until customer message #2 arrives.
  const agentMessagesUrl =
    `${tenant}/api/v1/helpdesk/agent/conversations/${conversationId}` +
    `/messages?workspaceId=${workspaceId}`;

  const agentSawMsg2 = pollFor(
    'agent receives visitor message #2',
    agentMessagesUrl,
    agentHeaders,
    (bodies) => bodies.some((body) => body.includes(message2)),
    12
  );

  check(null as unknown as { status: number }, {
    'chat: agent received customer message #2': () => agentSawMsg2,
  });
}
