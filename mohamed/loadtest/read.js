// The read path a signed-in user produces: list the catalogue, open one course,
// list its sections. One login happens in setup so the token is not part of the
// measurement.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, courseIds, coursesPage, login, common, summary } from './lib.js';

export const options = {
  ...common,
  scenarios: {
    readers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '2m', target: 20 },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{name:GET /api/courses}': ['p(95)<1500'],
  },
};

export function setup() {
  const res = login();
  check(res, { 'setup login succeeded': (r) => r.status === 200 });
  const token = res.json('accessToken');
  if (!token) {
    throw new Error(`login failed in setup: ${res.status} ${res.body}`);
  }

  const ids = courseIds(coursesPage(token));
  if (ids.length === 0) {
    throw new Error('the catalogue is empty, seed it before running the test');
  }

  return { token, ids };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.token}` };

  const list = coursesPage(data.token);
  check(list, {
    'course list is 200': (r) => r.status === 200,
    'course list has items': (r) => {
      const body = r.json();
      return Boolean(body && Array.isArray(body.items));
    },
  });

  const id = data.ids[Math.floor(Math.random() * data.ids.length)];
  const one = http.get(`${BASE_URL}/api/courses/${id}`, {
    headers,
    tags: { name: 'GET /api/courses/:id' },
  });
  check(one, { 'course detail is 200': (r) => r.status === 200 });

  const sections = http.get(`${BASE_URL}/api/sections?courseId=${id}&limit=20`, {
    headers,
    tags: { name: 'GET /api/sections' },
  });
  check(sections, { 'section list is 200': (r) => r.status === 200 });

  sleep(Number(__ENV.THINK || 0.5));
}

export const handleSummary = summary('read');
