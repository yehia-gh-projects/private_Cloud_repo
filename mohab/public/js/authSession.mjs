// The signed-in session, following Mohamed's refresh-cookie flow.
//
// - The access token (a JWT) lives only in this module's memory. It is never
//   written to localStorage or sessionStorage, so a script injected into the
//   page cannot read a stored copy, and closing the tab ends it.
// - The refresh token is an HttpOnly cookie that JavaScript cannot read at all.
//   The browser sends it to /api/auth/refresh by itself (same origin).
// - Refresh is "single-flight": if several requests need a new token at the
//   same moment they share ONE refresh call. Mohamed's refresh tokens rotate on
//   every use, so parallel refresh calls could look like token reuse and end
//   the session.

const SESSION_TOKEN_KEY = 'tt_access_token';
const SESSION_USER_KEY = 'tt_auth_user';

function getStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

export function createAuthSession({ refreshPath, logoutPath, fetchFn = (...args) => globalThis.fetch(...args) }) {
  const storage = getStorage();
  let accessToken = (storage && storage.getItem(SESSION_TOKEN_KEY)) || null;
  let refreshing = null;

  function setToken(token) {
    accessToken = token || null;
    if (!storage) return;
    if (accessToken) {
      storage.setItem(SESSION_TOKEN_KEY, accessToken);
    } else {
      storage.removeItem(SESSION_TOKEN_KEY);
      storage.removeItem(SESSION_USER_KEY);
    }
  }

  async function doRefresh() {
    try {
      const response = await fetchFn(refreshPath, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin'
      });
      if (!response.ok) {
        setToken(null);
        return false;
      }
      const body = await response.json();
      const token = body && typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
      setToken(token !== '' ? token : null);
      return accessToken !== null;
    } catch {
      // Network problem or a body that is not JSON: treat as signed out.
      setToken(null);
      return false;
    }
  }

  // Reuse cached sessionStorage token first; only call /api/auth/refresh if missing.
  function restore() {
    if (accessToken) {
      return Promise.resolve(true);
    }
    return refresh();
  }

  // Resolves to true when a fresh access token is available.
  function refresh() {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  // Ends the session on the server (the refresh cookie is revoked there) and
  // forgets the access token here, even if the server cannot be reached.
  async function signOut() {
    try {
      await fetchFn(logoutPath, { method: 'POST', credentials: 'same-origin' });
    } catch {
      // Nothing else to do: the local token is cleared below either way.
    } finally {
      setToken(null);
    }
  }

  return {
    getToken: () => accessToken,
    isSignedIn: () => accessToken !== null,
    restore,
    refresh,
    signOut
  };
}

// Adds "Sign in" or "Sign out" to the existing page navigation.
// Signing in always happens on Mohamed's login page.
export function mountAccountControl({ doc, nav, session, loginPageUrl, navigate }) {
  if (!nav) {
    return null;
  }
  let control;
  if (session.isSignedIn()) {
    control = doc.createElement('button');
    control.type = 'button';
    control.className = 'btn btn-ghost btn-sm nav-button';
    control.textContent = 'Sign Out';
    control.addEventListener('click', async () => {
      control.disabled = true;
      await session.signOut();
      navigate(loginPageUrl);
    });
  } else {
    control = doc.createElement('a');
    control.href = loginPageUrl;
    control.textContent = 'Sign In';
  }
  nav.append(control);
  return control;
}
