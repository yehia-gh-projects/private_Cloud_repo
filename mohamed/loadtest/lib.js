// Shared settings for the load tests.
//
// The service is reached over HTTPS with a self-signed certificate, so every
// script sets `insecureSkipTLSVerify`. That is the only transport concession:
// the requests, the headers and the token handling are the same as a browser.

import http from 'k6/http';

export const BASE_URL = __ENV.BASE_URL || 'https://localhost:8443';

// The deployed task verifies Turnstile against Cloudflare with the test secret,
// which accepts any token. A load generator cannot solve a challenge, so it
// sends the same placeholder the test widget produces.
export const TURNSTILE = __ENV.TURNSTILE || 'XXXX.DUMMY.TOKEN.XXXX';

export const EMAIL = __ENV.LOAD_EMAIL || 'loadtest@class-tt.local';
export const PASSWORD = __ENV.LOAD_PASSWORD || 'LoadTestPass12345';

export const common = {
  insecureSkipTLSVerify: true,
};

export function login(email = EMAIL, password = PASSWORD) {
  return http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email, password, turnstileToken: TURNSTILE }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST /api/auth/login' },
    },
  );
}

// GET /api/courses answers `{ items: [...], nextCursor }`, so setup reads the
// array and never assumes the body is one.
export function coursesPage(token, limit = 20) {
  return http.get(`${BASE_URL}/api/courses?limit=${limit}`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { name: 'GET /api/courses' },
  });
}

export function courseIds(response) {
  const body = response.json();
  if (Array.isArray(body)) {
    return body.map((course) => course.id);
  }
  return (body.items || []).map((course) => course.id);
}

// k6 calls this once at the end. It writes the machine-readable summary next to
// the scripts and prints the handful of numbers worth quoting in a report.
export function summary(name) {
  return function (data) {
    const m = data.metrics;
    const rps = m.http_reqs ? m.http_reqs.values.rate : 0;
    const failed = m.http_req_failed ? m.http_req_failed.values.rate : 0;
    const dur = m.http_req_duration ? m.http_req_duration.values : {};
    const checks = m.checks ? m.checks.values.rate : 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    const lines = [
      '',
      `result   ${name}`,
      `requests ${m.http_reqs ? m.http_reqs.values.count : 0}`,
      `rps      ${rps.toFixed(1)}`,
      `failed   ${(failed * 100).toFixed(2)}%`,
      `checks   ${(checks * 100).toFixed(2)}%`,
      `median   ${(dur.med || 0).toFixed(0)} ms`,
      `p90      ${(dur['p(90)'] || 0).toFixed(0)} ms`,
      `p95      ${(dur['p(95)'] || 0).toFixed(0)} ms`,
      `max      ${(dur.max || 0).toFixed(0)} ms`,
    ];

    const file = `results/${name}-${stamp}.json`;
    return {
      stdout: `${lines.join('\n')}\n`,
      [file]: JSON.stringify(data, null, 2),
    };
  };
}
