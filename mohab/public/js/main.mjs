// Starts the right page in the browser, based on <body data-page="...">.
import { appConfig } from './config.mjs';
import { createApiClient } from './apiClient.mjs';
import { createAuthSession, mountAccountControl } from './authSession.mjs';
import { createTimetableSource } from './timetableSource.mjs';
import { createComparePage } from './comparePage.mjs';
import { createSharePage } from './sharePage.mjs';
import { createSharedPage } from './sharedPage.mjs';

const byId = (id) => document.getElementById(id);
const THEME_KEY = 'tt_builder_theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = byId('theme-toggle-btn');
  if (btn) btn.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') {
    applyTheme(saved);
    return;
  }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(prefersDark ? 'dark' : 'light');
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

initTheme();
byId('theme-toggle-btn')?.addEventListener('click', toggleTheme);

function saveFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Restore the session from Mohamed's refresh cookie before the page decides
// whether the user is signed in. The access token stays in memory only.
const session = createAuthSession({
  refreshPath: appConfig.auth.refreshPath,
  logoutPath: appConfig.auth.logoutPath
});
await session.restore();

const userLabel = byId('user-label');
if (session.isSignedIn() && userLabel) {
  let cachedUser = null;
  try {
    const raw = sessionStorage.getItem('tt_auth_user');
    cachedUser = raw ? JSON.parse(raw) : null;
  } catch {}
  if (!cachedUser) {
    try {
      const meRes = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${session.getToken()}` }
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        cachedUser = (meData && (meData.user || meData)) || null;
        if (cachedUser) sessionStorage.setItem('tt_auth_user', JSON.stringify(cachedUser));
      }
    } catch {}
  }
  if (cachedUser && (cachedUser.email || cachedUser.name)) {
    userLabel.textContent = cachedUser.email || cachedUser.name;
    userLabel.hidden = false;
  }
  const topNav = document.querySelector('.topbar-nav');
  if (topNav && cachedUser && cachedUser.role === 'admin') {
    const importsLink = document.createElement('a');
    importsLink.href = '/imports.html';
    importsLink.textContent = 'Imports';
    importsLink.setAttribute('data-admin-link', '1');

    const accountsLink = document.createElement('a');
    accountsLink.href = '/admin.html';
    accountsLink.textContent = 'Accounts';
    accountsLink.setAttribute('data-admin-link', '1');

    topNav.append(importsLink, accountsLink);
  }
}

mountAccountControl({
  doc: document,
  nav: document.querySelector('.site-header .auth-bar') || document.querySelector('.site-header nav'),
  session,
  loginPageUrl: appConfig.auth.loginPageUrl,
  navigate: (url) => window.location.assign(url)
});

const api = createApiClient({
  baseUrl: appConfig.apiBaseUrl,
  getToken: session.getToken,
  refreshSession: session.refresh
});
const source = createTimetableSource({ api, listPath: appConfig.timetableListPath });
const page = document.body.getAttribute('data-page');

if (page === 'compare') {
  createComparePage({
    doc: document,
    api,
    source,
    elements: {
      form: byId('compare-form'),
      status: byId('compare-status'),
      picker: byId('timetable-picker'),
      manualField: byId('manual-field'),
      manualInput: byId('manual-ids'),
      selectionHint: byId('selection-hint'),
      criterion: byId('criterion'),
      compareButton: byId('compare-button'),
      results: byId('compare-results')
    }
  }).load();
} else if (page === 'share') {
  createSharePage({
    doc: document,
    api,
    source,
    // The folder these pages are served from (for example
    // "https://host/compare-share" behind a shared gateway), so share links
    // point at this service's shared.html and not at another service's root.
    origin: new URL('.', window.location.href).href.replace(/\/$/, ''),
    copyText: (text) => navigator.clipboard.writeText(text),
    confirmAction: (message) => window.confirm(message),
    elements: {
      form: byId('share-form'),
      createStatus: byId('create-status'),
      selectField: byId('select-field'),
      timetableSelect: byId('share-timetable'),
      manualField: byId('manual-field'),
      manualInput: byId('manual-id'),
      pickerNote: byId('picker-note'),
      expiryInput: byId('expiry-days'),
      createButton: byId('create-button'),
      newLink: byId('new-link'),
      listStatus: byId('list-status'),
      sharesList: byId('shares-list')
    }
  }).load();
} else if (page === 'shared') {
  createSharedPage({
    doc: document,
    api,
    hash: window.location.hash,
    saveFile,
    elements: {
      status: byId('shared-status'),
      details: byId('shared-details'),
      title: byId('shared-title'),
      meta: byId('shared-meta'),
      schedule: byId('shared-schedule'),
      downloadButton: byId('download-button'),
      downloadStatus: byId('download-status')
    }
  }).load();
}
