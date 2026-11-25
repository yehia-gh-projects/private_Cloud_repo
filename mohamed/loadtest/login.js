// The expensive request: a login costs one Argon2id verification against the
// stored hash, so it is the closest thing this service has to a CPU benchmark.

import { check, sleep } from 'k6';
import { BASE_URL, login, common, summary } from './lib.js';

export const options = {
  ...common,
  scenarios: {
    logins: {
      executor: 'constant-vus',
      vus: 5,
      duration: '60s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:POST /api/auth/login}': ['p(95)<5000'],
  },
};

export default function () {
  const res = login();
  check(res, {
    'login is 200': (r) => r.status === 200,
    'login returns a token': (r) => String(r.json('accessToken') || '').length > 100,
  });
  sleep(1);
}

export const handleSummary = summary('login');
