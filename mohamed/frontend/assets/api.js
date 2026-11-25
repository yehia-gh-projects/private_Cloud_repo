/**
 * The only place that talks HTTP.
 *
 * Two decisions are worth knowing before reading the code:
 *
 * 1. **The access token lives in memory, not in `localStorage`.** Any script that
 *    runs on this origin can read `localStorage`, so storing a bearer token there
 *    turns every XSS into a stolen session that survives a refresh. Memory means
 *    a reload costs one call to `/api/auth/refresh`, which the `HttpOnly` cookie
 *    authorises. The cookie itself cannot be read by JavaScript at all.
 *
 * 2. **A 401 triggers exactly one silent refresh and one retry.** That is what
 *    makes a 2-hour access token feel like a normal session, and doing it here
 *    means no page has to think about expiry. If the refresh also fails the
 *    session is really over and the caller is sent back to the sign-in page.
 */

export class ApiError extends Error {
  constructor({ status, code, message, details, requestId }) {
    super(message ?? 'Request failed.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

const SESSION_TOKEN_KEY = 'tt_access_token';
const SESSION_USER_KEY = 'tt_auth_user';

let accessToken = sessionStorage.getItem(SESSION_TOKEN_KEY) || null;

export function setAccessToken(token) {
  accessToken = token ?? null;
  if (accessToken) {
    sessionStorage.setItem(SESSION_TOKEN_KEY, accessToken);
  } else {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_USER_KEY);
  }
}

export function getAccessToken() {
  return accessToken;
}

function parseBody(response, text) {
  if (!text) return null;
  const isJson = response.headers.get('content-type')?.includes('application/json');
  if (!isJson) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One request, no retry. Errors are normalised into `ApiError`. */
async function raw(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;

  let payload;
  if (form) {
    // Never set content-type by hand for a FormData body: the browser has to add
    // the multipart boundary itself.
    payload = form;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError({ status: 0, code: 'NETWORK', message: 'Cannot reach the service. Is it running?' });
  }

  if (response.status === 204) return null;

  const text = await response.text();
  const parsed = parseBody(response, text);

  if (!response.ok) {
    const error = parsed?.error ?? {};
    throw new ApiError({
      status: response.status,
      code: error.code ?? 'HTTP_ERROR',
      message: error.message ?? `Request failed (${response.status}).`,
      details: error.details,
      requestId: error.requestId ?? response.headers.get('x-request-id'),
    });
  }

  return parsed;
}

// Single-flight: several tables can load at once, and each would otherwise start
// its own refresh - with rotation, the losers would look like token reuse.
let refreshing = null;

export function refreshSession() {
  if (refreshing) return refreshing;

  refreshing = raw('/api/auth/refresh', { method: 'POST' })
    .then((payload) => {
      setAccessToken(payload?.accessToken ?? null);
      return Boolean(accessToken);
    })
    .catch(() => {
      setAccessToken(null);
      return false;
    })
    .finally(() => {
      refreshing = null;
    });

  return refreshing;
}

/**
 * An authenticated request: refresh once on 401, retry once, then give up.
 *
 * The second failure is thrown, so a page can distinguish "session over" from
 * "this particular call was rejected" by checking `error.status === 401`.
 */
async function request(path, options = {}) {
  try {
    return await raw(path, options);
  } catch (error) {
    if (error.status !== 401) throw error;
    const renewed = await refreshSession();
    if (!renewed) throw error;
    return raw(path, options);
  }
}

function withQuery(path, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export const api = {
  // --- session ------------------------------------------------------------
  login: (email, password, turnstileToken) =>
    raw('/api/auth/login', { method: 'POST', body: { email, password, turnstileToken } }),
  logout: () => raw('/api/auth/logout', { method: 'POST' }),
  me: () => request('/api/auth/me'),
  register: (email, password, turnstileToken) =>
    raw('/api/auth/register', { method: 'POST', body: { email, password, turnstileToken } }),
  // The token travels in the body, not in a query string of this call: the link
  // itself carries it once, and this is the last hop.
  verifyEmail: (token) => raw('/api/auth/verify-email', { method: 'POST', body: { token } }),
  resendVerification: (email, turnstileToken) =>
    raw('/api/auth/verify-email/resend', {
      method: 'POST',
      body: { email, turnstileToken },
    }),
  requestPasswordReset: (email, turnstileToken) =>
    raw('/api/auth/password-reset/request', { method: 'POST', body: { email, turnstileToken } }),
  confirmPasswordReset: (token, newPassword) =>
    raw('/api/auth/password-reset/confirm', { method: 'POST', body: { token, newPassword } }),

  // --- administration -----------------------------------------------------
  listUsers: (params) => request(withQuery('/api/admin/users', params)),
  setUserRole: (id, role) => request(`/api/admin/users/${id}/role`, { method: 'PATCH', body: { role } }),

  // --- courses ------------------------------------------------------------
  listCourses: (params) => request(withQuery('/api/courses', params)),
  createCourse: (body) => request('/api/courses', { method: 'POST', body }),
  updateCourse: (id, body) => request(`/api/courses/${id}`, { method: 'PATCH', body }),
  archiveCourse: (id) => request(`/api/courses/${id}`, { method: 'DELETE' }),

  // --- sections -----------------------------------------------------------
  listSections: (params) => request(withQuery('/api/sections', params)),
  createSection: (body) => request('/api/sections', { method: 'POST', body }),
  updateSection: (id, body) => request(`/api/sections/${id}`, { method: 'PATCH', body }),
  archiveSection: (id) => request(`/api/sections/${id}`, { method: 'DELETE' }),

  // --- imports ------------------------------------------------------------
  uploadImport: (file, { dryRun = false } = {}) => {
    const form = new FormData();
    form.set('file', file);
    return request(withQuery('/api/imports', dryRun ? { dryRun: 'true' } : {}), { method: 'POST', form });
  },
  listImports: (params) => request(withQuery('/api/imports', params)),
  getImport: (id) => request(`/api/imports/${id}`),
};
