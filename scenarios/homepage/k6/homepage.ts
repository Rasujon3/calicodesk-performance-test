import http from 'k6/http';
import { check } from 'k6';

const profile = __ENV.K6_PROFILE ?? 'smoke';

const response = http.get(`${__ENV.BASE_URL}/`);

console.log(`URL: ${`${__ENV.BASE_URL}/`}`);
console.log(`Status: ${response.status}`);
console.log(`Error: ${response.error}`);

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
};

export const options = profiles[profile] ?? profiles.smoke;

export default function () {
  const response = http.get(`${__ENV.BASE_URL}/`);

  check(response, {
    'status is 200': (res) => res.status === 200,
  });
}