import http from 'k6/http';
import { check } from 'k6';
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

export default function () {
  const baseUrl = __ENV.BASE_URL;

  if (!baseUrl) {
    throw new Error('BASE_URL is not configured.');
  }

  const url = `${baseUrl}/`;

  const response = http.get(url);

  console.log(
    `k6 request | URL: ${url} | Status: ${response.status} | Error: ${response.error ?? ''}`
  );

  check(response, {
    'status is 200': (res) => res.status === 200,
  });
}
