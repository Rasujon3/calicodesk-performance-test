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

export default function () {
  const baseUrl = __ENV.BASE_URL;

  if (!baseUrl) {
    throw new Error('BASE_URL is not configured.');
  }

  const url = `${baseUrl}/login`;

  const response = http.get(url);

  console.log(
    `k6 request | URL: ${url} | Status: ${response.status} | Error: ${response.error ?? ''}`
  );

  check(response, {
    'login page status is 200': (res) => res.status === 200,
  });
}
