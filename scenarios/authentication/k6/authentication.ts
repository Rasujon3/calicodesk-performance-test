import http from 'k6/http';
import { check } from 'k6';

export default function () {
  const response = http.get(
    __ENV.BASE_URL
  );

  check(response, {
    'authentication endpoint is reachable': (res) =>
      res.status >= 200 && res.status < 300,
  });
}