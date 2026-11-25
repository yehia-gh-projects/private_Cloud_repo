/**
 * Sign-in and registration.
 *
 * The page holds no session of its own: `signIn` stores the access token in
 * memory and the refresh cookie arrives as an `HttpOnly` `Set-Cookie`, so the
 * next page starts by refreshing rather than reading anything from storage.
 */

import { api } from './api.js';
import { restore, signIn, initTheme, toggleTheme } from './session.js';
import { h, fill, showAlert, hideAlert } from './dom.js';

initTheme();
document.getElementById('theme-toggle-btn')?.addEventListener('click', toggleTheme);

const SITE_KEY = '1x00000000000000000000AA'; // Cloudflare's "always passes" test key.

const form = document.querySelector('[data-form]');
const emailInput = document.querySelector('#email');
const passwordInput = document.querySelector('#password');
const submit = document.querySelector('[data-submit]');
const alertBox = document.querySelector('[data-alert]');
const noteBox = document.querySelector('[data-note]');
const hint = document.querySelector('[data-hint]');
const tabs = [...document.querySelectorAll('[data-mode]')];
const turnstileHost = document.querySelector('[data-turnstile]');

let mode = 'signin';
let turnstileToken = '';
let widgetId = null;

/** Turnstile solved → keep the token; expired → drop it, so a stale one is never sent. */
function mountTurnstile() {
  if (!window.turnstile) return false;

  widgetId = window.turnstile.render(turnstileHost, {
    sitekey: SITE_KEY,
    callback: (token) => {
      turnstileToken = token;
    },
    'expired-callback': () => {
      turnstileToken = '';
    },
    'error-callback': () => {
      turnstileToken = '';
    },
  });

  return true;
}

function setMode(next) {
  mode = next;

  for (const tab of tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.mode === next));
  }

  const registering = next === 'register';
  submit.textContent = registering ? 'Create account' : 'Sign in';
  passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
  hint.textContent = registering
    ? 'At least 10 characters. You will receive an email to verify the address before the first sign-in.'
    : '';

  hideAlert(alertBox);
  hideAlert(noteBox);
}

/** Turn a server error into the one sentence a person can act on. */
function explain(error) {
  const { code, details, message } = error;

  if (code === 'INVALID_CREDENTIALS') return 'Email or password is incorrect.';
  if (code === 'LOCKED') {
    const seconds = details?.retryAfterSeconds;
    return seconds
      ? `Too many failed attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`
      : 'Too many failed attempts. Try again later.';
  }
  if (code === 'EMAIL_NOT_VERIFIED') return 'This address is not verified yet. Check your email for the link.';
  if (code === 'TURNSTILE_FAILED') return 'The verification check failed. Reload the page and try again.';
  if (code === 'RATE_LIMITED') return 'Too many requests. Give it a minute.';
  if (code === 'VALIDATION_FAILED') {
    return details?.field ? `${message} (${details.field})` : message;
  }
  return message ?? 'Something went wrong.';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideAlert(alertBox);
  hideAlert(noteBox);

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    showAlert(alertBox, 'error', 'Email and password are both required.');
    return;
  }

  if (!turnstileToken) {
    showAlert(alertBox, 'error', 'Complete the verification check first.');
    return;
  }

  submit.disabled = true;
  submit.textContent = mode === 'register' ? 'Creating…' : 'Signing in…';

  try {
    if (mode === 'register') {
      // The server answers 202 with the same body whether or not the address
      // existed - registration must not be a way to discover who has an account.
      await api.register(email, password, turnstileToken);
      // Switch tabs *before* showing the message: setMode clears the note area,
      // so showing it first would leave the user staring at a blank form.
      setMode('signin');
      passwordInput.value = ''; // the password is the server's business now
      showAlert(
        noteBox,
        'info',
        'If that address can be registered, a verification email is on its way. Verify it, then sign in.',
      );
    } else {
      await signIn(email, password, turnstileToken);
      location.replace('courses.html');
      return;
    }
  } catch (error) {
    showAlert(alertBox, 'error', explain(error));

    // A correct password on an unverified account is the one case where the user
    // needs an action, not an explanation: give them the button instead of making
    // them re-register (which would answer 202 and send nothing).
    if (error.code === 'EMAIL_NOT_VERIFIED') offerResend(email);

    if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
    turnstileToken = '';
  } finally {
    submit.disabled = false;
    submit.textContent = mode === 'register' ? 'Create account' : 'Sign in';
  }
});

/**
 * Offer a fresh verification link. The server answers 202 whether or not the
 * address has an unverified account, so the message is conditional:
 * no click here can reveal who has an account.
 */
function offerResend(address) {
  const button = h(
    'button',
    {
      type: 'button',
      class: 'btn secondary small',
      onclick: async () => {
        // A Turnstile token is consumed by the call that used it, and the failed
        // login above spent one. Ask for a fresh challenge instead of sending an
        // empty token, which the server would refuse anyway.
        if (!turnstileToken) {
          showAlert(noteBox, 'info', 'Complete the verification check above, then press the button again.');
          return;
        }

        button.disabled = true;
        try {
          await api.resendVerification(address, turnstileToken);
          showAlert(noteBox, 'info', 'If this address still needs verifying, a new link is on its way.');
        } catch (error) {
          showAlert(noteBox, 'error', explain(error));
        } finally {
          button.disabled = false;
        }
      },
    },
    'Send a new link',
  );

  // The note area is hidden until something needs saying, and `fill` does not
  // un-hide it: setting the class and `hidden` is what makes the button visible.
  noteBox.className = 'alert info';
  noteBox.hidden = false;
  fill(noteBox, "Didn't get the email? ", button);
}

for (const tab of tabs) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
}

// Someone who already has a session should not be asked to sign in again.
const existing = await restore();
if (existing) {
  location.replace('courses.html');
} else {
  const authMain = document.querySelector('main.auth');
  if (authMain) authMain.hidden = false;
  setMode('signin');

  // The widget is a third-party script. If it never arrives (blocked, offline),
  // say so plainly instead of letting the submit button fail with a 403 later.
  const started = Date.now();
  const wait = setInterval(() => {
    if (mountTurnstile()) {
      clearInterval(wait);
    } else if (Date.now() - started > 8000) {
      clearInterval(wait);
      showAlert(alertBox, 'error', 'The verification widget could not load. Check your connection and reload.');
      submit.disabled = true;
    }
  }, 200);
}
