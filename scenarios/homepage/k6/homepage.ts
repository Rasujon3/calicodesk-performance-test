import http from 'k6/http';
import { check } from 'k6';

const profile = __ENV.K6_PROFILE ?? 'smoke';

const profiles: Record<string, Record<string, unknown>> = {
  smoke: {
    vus: 1,
    duration: '30s',
  },

  load: {
    stages: [
      { duration: '30s', target: 10 },
      { duration: '1m', target: 25 },
      { duration: '2m', target: 25 },
      { duration: '30s', target: 0 },
    ],
  },

  stress: {
    stages: [
      { duration: '30s', target: 25 },
      { duration: '1m', target: 50 },
      { duration: '1m', target: 100 },
      { duration: '1m', target: 150 },
      { duration: '30s', target: 0 },
    ],
  },

  spike: {
    stages: [
      { duration: '30s', target: 10 },
      { duration: '10s', target: 100 },
      { duration: '1m', target: 100 },
      { duration: '10s', target: 10 },
      { duration: '30s', target: 0 },
    ],
  },

  soak: {
    stages: [
      { duration: '1m', target: 25 },
      { duration: '10m', target: 25 },
      { duration: '1m', target: 0 },
    ],
  },

  rps: {
    scenarios: {
      default: {
        executor: 'constant-arrival-rate',

        rate: 10,
        timeUnit: '1s',

        duration: '1m',

        preAllocatedVUs: 5,
        maxVUs: 20,
      },
    },
  },
};

export const options =
  profiles[profile] ?? profiles.smoke;

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