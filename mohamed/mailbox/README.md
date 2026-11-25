# mailbox

A small read-only inbox for looking at the mail the service sends.

On floci, SES keeps every message instead of delivering it. This reads that store
and shows the messages the way a mail client would, so the verification and
password reset links can be clicked instead of copied out of JSON.

```bash
node mailbox/server.mjs
```

Then open `http://127.0.0.1:4545`.

What it is:

- `server.mjs` serves the page and forwards its fetch to
  `http://127.0.0.1:4566/_aws/ses`, because the emulator sends no CORS headers
  and a plain HTML file could not read the store.
- `index.html` lists the messages, renders the selected one in a frame, filters
  by recipient or subject, and refreshes every two seconds.

It reads only. It stores nothing, sends nothing and has no login. It is a
development tool, not part of the deployed service, and on real AWS the same
messages arrive in a real mailbox instead.
