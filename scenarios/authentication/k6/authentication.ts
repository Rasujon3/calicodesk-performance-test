import http from 'k6/http';
import { check } from 'k6';
import { getK6ProfileOptions } from '../../../config/load-profiles.js';

const profile = __ENV.K6_PROFILE ?? 'smoke';

export const options = {
  ...getK6ProfileOptions(profile),

  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
  },
};

/*
 * k6 cannot replay the real CalicoDesk login.
 *
 * Playwright shows a browser SPA:
 *   GET /login → Welcome back → Email + Continue
 *   → workspace host /login?step=password
 *   → Password + Sign in → /dashboard
 *
 * The email/password UI is rendered by JavaScript.
 * Those strings are not in the HTTP HTML. Continue
 * navigates to a workspace host that is not configured
 * here. Sign in is blocked by Google reCAPTCHA.
 * There is no documented login API for k6 to POST.
 *
 * This scenario therefore validates the login document
 * over HTTP. Credential POST is intentionally omitted.
 */
export default function () {
  const baseUrl = __ENV.BASE_URL;

  if (!baseUrl) {
    throw new Error('BASE_URL is not configured.');
  }

  const url = `${baseUrl}/login`;

  const response = http.get(url);

  const body =
    typeof response.body === 'string'
      ? response.body
      : '';

  const contentType = String(
    response.headers['Content-Type'] ??
      response.headers['content-type'] ??
      ''
  );

  console.log(
    `k6 request | URL: ${url} | Status: ${response.status} | Error: ${response.error ?? ''}`
  );

  check(response, {
    'login page status is 200': (res) => res.status === 200,
    'login page is HTML': () => contentType.includes('text/html'),
    'login page is a substantial document': () =>
      body.length > 10_000 && body.toLowerCase().includes('login'),
  });
}
