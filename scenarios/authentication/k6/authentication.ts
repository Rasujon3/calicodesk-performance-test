import http from 'k6/http';
import { check, sleep } from 'k6';
import { getK6ProfileOptions } from '../../../config/load-profiles.js';

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

interface WorkspaceSummary {
  id?: number;
  name?: string;
  domain?: string | null;
  company_name?: string | null;
  base_url?: string | null;
}

interface WorkspaceLookupBody {
  email?: string;
  workspaces?: WorkspaceSummary[];
  status?: string;
}

interface LoginBody {
  status?: string;
  bootstrapData?: string;
  two_factor?: boolean;
  access_token?: string | null;
  token_type?: string;
  base_url?: string;
}

interface LogoutBody {
  status?: string;
  bootstrapData?: string;
}

const jsonHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

function requireEnv(name: string): string {
  const value = __ENV[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} is not configured. The k6 runner must inject it before the authentication scenario runs.`
    );
  }

  return value;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function logRequest(url: string, response: { status: number; error: string }): void {
  console.log(
    `k6 request | URL: ${url} | Status: ${response.status} | Error: ${response.error ?? ''}`
  );
}

/*
 * Authenticated lifecycle (verified against CalicoDesk source):
 *   GET  {BASE_URL}/login
 *   POST {BASE_URL}/api/v1/tenant/find-workspaces-by-email
 *   POST {workspace.base_url}/auth/login
 *   GET  {workspace}/api/v1/bootstrap-data  (Bearer)
 *   POST {workspace}/api/v1/auth/logout    (Bearer)
 *   GET  {workspace}/api/v1/bootstrap-data  (same Bearer → 401)
 *
 * Credentials: TEST_USER_EMAIL / TEST_USER_PASSWORD (injected by runner).
 * Never log passwords, tokens, cookies, or Authorization headers.
 */
export default function () {
  const baseUrl = stripTrailingSlash(requireEnv('BASE_URL'));
  const email = requireEnv('TEST_USER_EMAIL');
  const password = requireEnv('TEST_USER_PASSWORD');

  // --- Existing login document check (preserved) ---
  const loginPageUrl = `${baseUrl}/login`;
  const loginPageResponse = http.get(loginPageUrl);

  const loginPageBody =
    typeof loginPageResponse.body === 'string'
      ? loginPageResponse.body
      : '';

  const loginPageContentType = String(
    loginPageResponse.headers['Content-Type'] ??
      loginPageResponse.headers['content-type'] ??
      ''
  );

  logRequest(loginPageUrl, loginPageResponse);

  check(loginPageResponse, {
    'login page status is 200': (res) => res.status === 200,
    'login page is HTML': () =>
      loginPageContentType.includes('text/html'),
    // SPA shell HTML no longer embeds the word "login"; keep a substantial-document gate.
    'login page is a substantial document': () =>
      loginPageBody.length > 10_000 &&
      loginPageBody.toLowerCase().includes('<!doctype html'),
  });

  // --- Workspace lookup (email Continue equivalent) ---
  const lookupUrl = `${baseUrl}/api/v1/tenant/find-workspaces-by-email`;
  const lookupResponse = http.post(
    lookupUrl,
    JSON.stringify({ email }),
    { headers: jsonHeaders }
  );

  logRequest(lookupUrl, lookupResponse);

  let workspaceBaseUrl = '';

  try {
    const lookupBody = lookupResponse.json() as WorkspaceLookupBody;
    const firstWorkspace = lookupBody.workspaces?.[0];
    const rawBaseUrl = firstWorkspace?.base_url?.trim();

    if (rawBaseUrl) {
      workspaceBaseUrl = stripTrailingSlash(rawBaseUrl);
    }
  } catch {
    workspaceBaseUrl = '';
  }

  check(lookupResponse, {
    'workspace lookup status is 200': (res) => res.status === 200,
    'workspace lookup returns a workspace base_url': () =>
      workspaceBaseUrl.length > 0,
  });

  if (!workspaceBaseUrl) {
    sleep(8);
    return;
  }

  // --- Login (SPA path: POST /auth/login on workspace host) ---
  const loginUrl = `${workspaceBaseUrl}/auth/login`;
  const loginResponse = http.post(
    loginUrl,
    JSON.stringify({
      email,
      password,
      remember: false,
      token_name: 'web',
      login_context: 'default',
    }),
    { headers: jsonHeaders }
  );

  logRequest(loginUrl, loginResponse);

  let accessToken = '';

  try {
    const loginBody = loginResponse.json() as LoginBody;

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

  check(loginResponse, {
    'login status is 200': (res) => res.status === 200,
    'login returns a Bearer access_token': () => accessToken.length > 0,
  });

  if (!accessToken) {
    sleep(8);
    return;
  }

  const authHeaders = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  };

  // --- Authenticated action ---
  const bootstrapUrl = `${workspaceBaseUrl}/api/v1/bootstrap-data`;
  const authenticatedBootstrap = http.get(bootstrapUrl, {
    headers: authHeaders,
  });

  logRequest(bootstrapUrl, authenticatedBootstrap);

  check(authenticatedBootstrap, {
    'authenticated bootstrap-data status is 200': (res) =>
      res.status === 200,
  });

  // --- Logout ---
  const logoutUrl = `${workspaceBaseUrl}/api/v1/auth/logout`;
  const logoutResponse = http.post(logoutUrl, null, {
    headers: authHeaders,
  });

  logRequest(logoutUrl, logoutResponse);

  let logoutStatusField = '';

  try {
    const logoutBody = logoutResponse.json() as LogoutBody;
    logoutStatusField = logoutBody.status ?? '';
  } catch {
    logoutStatusField = '';
  }

  check(logoutResponse, {
    'logout status is 200': (res) => res.status === 200,
    'logout response status is success': () =>
      logoutStatusField === 'success',
  });

  // --- Post-logout: same token must be rejected (app feature-test behavior) ---
  const postLogoutBootstrap = http.get(bootstrapUrl, {
    headers: authHeaders,
    // 401 is the expected authenticated-state invalidation signal.
    responseCallback: http.expectedStatuses(401),
  });

  logRequest(bootstrapUrl, postLogoutBootstrap);

  check(postLogoutBootstrap, {
    'post-logout bootstrap-data status is 401': (res) =>
      res.status === 401,
  });

  // Fortify login limiter is 5/minute per email+IP. Pace iterations so smoke
  // (30s loop) does not trip HTTP 429 and fail otherwise-valid lifecycle checks.
  sleep(8);
}
