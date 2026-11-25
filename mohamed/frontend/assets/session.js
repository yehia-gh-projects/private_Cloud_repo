/**
 * Session state and the shared shell.
 *
 * A page boots by calling `boot()`, which tries the refresh cookie, loads `/me`,
 * draws the top bar and - if the page asked for it - refuses to render for a
 * non-admin. The refusal here is **cosmetic**: every route checks the role on the
 * server. Hiding a button is not access control; the API is what decides.
 */

import { api, getAccessToken, setAccessToken, refreshSession, ApiError } from './api.js';
import { h, fill } from './dom.js';

const THEME_KEY = 'tt_builder_theme';
const SESSION_USER_KEY = 'tt_auth_user';

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
}

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') {
    applyTheme(saved);
    return;
  }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(prefersDark ? 'dark' : 'light');
}

export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

initTheme();

window.addEventListener('pagehide', () => {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
});

let user = null;

export function currentUser() {
  return user;
}

export function isAdmin() {
  return user?.role === 'admin';
}

function readCachedUser() {
  try {
    const raw = sessionStorage.getItem(SESSION_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCachedUser(u) {
  if (u) {
    sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(u));
  } else {
    sessionStorage.removeItem(SESSION_USER_KEY);
  }
}

/** Reuse sessionStorage token first; only call /api/auth/refresh if missing. */
export async function restore() {
  const cachedToken = getAccessToken();
  const cachedUser = readCachedUser();
  if (cachedToken && cachedUser) {
    user = cachedUser;
    return user;
  }

  if (!cachedToken) {
    const ok = await refreshSession();
    if (!ok) return null;
  }

  try {
    user = await api.me();
    writeCachedUser(user);
    return user;
  } catch {
    setAccessToken(null);
    user = null;
    return null;
  }
}

export async function signIn(email, password, turnstileToken) {
  const payload = await api.login(email, password, turnstileToken);
  setAccessToken(payload.accessToken);
  user = payload.user;
  writeCachedUser(user);
  return user;
}

export async function signOut() {
  try {
    await api.logout();
  } catch {
    // The cookie may already be gone; the local state still has to be cleared.
  } finally {
    setAccessToken(null);
    user = null;
    location.replace('/');
  }
}

function mountTopbar(active) {
  const host = document.querySelector('[data-topbar]');
  if (!host) return;

  const serviceLinks = [
    { href: '/', label: 'Catalogue', key: 'catalogue' },
    { href: '/timetable/', label: 'Timetable Builder', key: 'timetable' },
    { href: '/compare', label: 'Compare & Share', key: 'compare' },
  ];

  const subLinks = [
    ...(isAdmin() ? [{ href: '/imports.html', label: 'Imports', key: 'imports' }] : []),
    ...(isAdmin() ? [{ href: '/admin.html', label: 'Accounts', key: 'admin' }] : []),
  ];

  const currentTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const catalogueActive = !active || active === 'courses';

  fill(
    host,
    h(
      'header',
      { class: 'topbar site-header' },

      h(
        'div',
        { class: 'topbar-brand' },
        h('a', { class: 'brand', href: '/courses.html' }, 'Class Timetable Builder'),
      ),

      h(
        'nav',
        { class: 'topbar-nav', 'aria-label': 'Services' },
        ...serviceLinks.map((link) =>
          h(
            'a',
            {
              href: link.href,
              ...(link.key === 'catalogue' && catalogueActive ? { 'aria-current': 'page' } : {}),
            },
            link.label,
          ),
        ),
        ...subLinks.map((link) =>
          h('a', { href: link.href, ...(link.key === active ? { 'aria-current': 'page' } : {}) }, link.label),
        ),
      ),

      h(
        'div',
        { class: 'auth-bar' },
        h(
          'button',
          {
            id: 'theme-toggle-btn',
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            'aria-label': 'Toggle dark mode',
            onclick: () => toggleTheme(),
          },
          currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode',
        ),
        h('span', { id: 'user-label', class: 'topbar-user' }, user.email),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => void signOut() }, 'Sign Out'),
      ),
    ),
  );
}

/** Full-page message for the one case a redirect would be rude: signed in, wrong role. */
function renderForbidden() {
  const main = document.querySelector('main');
  if (!main) return;
  fill(
    main,
    h(
      'div',
      { class: 'card' },
      h('h1', {}, 'Admins only'),
      h('p', { class: 'muted' }, 'This page manages the catalogue. Your account can browse courses instead.'),
      h('p', {}, h('a', { href: 'courses.html' }, 'Back to courses')),
    ),
  );
}

/**
 * Resolve the session, then either draw the page or redirect to sign-in.
 *
 * Returns the user, or null when the caller should stop.
 */
export async function boot({ active = '', admin = false } = {}) {
  const me = await restore();

  if (!me) {
    location.replace('index.html');
    return null;
  }

  mountTopbar(active);

  if (admin && me.role !== 'admin') {
    renderForbidden();
    return null;
  }

  return me;
}

/** Re-exported so pages do not import two modules to catch one error type. */
export { ApiError };
