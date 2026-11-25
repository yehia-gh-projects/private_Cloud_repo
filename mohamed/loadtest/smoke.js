// One user, eleven requests. Answers "is it up and are the three responses the
// deployment promises still the right ones" before any load is applied.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, common, summary } from './lib.js';

// 401 and 404 are the correct answers here, so they must not be counted as
// failed requests.
http.setResponseCallback(http.expectedStatuses(200, 401, 404));

export const options = {
  ...common,
  vus: 1,
  iterations: 12,
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

export default function () {
  const landing = http.get(`${BASE_URL}/`, { tags: { name: 'GET /' } });
  check(landing, {
    'landing page is served': (r) => r.status === 200,
    'landing page declares the CSP': (r) => String(r.headers['Content-Security-Policy'] || '').includes("default-src 'self'"),
  });

  const courses = http.get(`${BASE_URL}/api/courses`, { tags: { name: 'GET /api/courses' } });
  check(courses, {
    'anonymous catalogue read is refused': (r) => r.status === 401,
  });

  const probe = http.get(`${BASE_URL}/readyz`, { tags: { name: 'GET /readyz' } });
  check(probe, {
    'readiness probe is hidden from the internet': (r) => r.status === 404,
  });

  sleep(0.2);
}

export const handleSummary = summary('smoke');
