# Catalogue & Accounts (Mohamed Ayman, 239236)

My part of the Class Timetable Builder. This service owns the course catalogue
and the system's identity: it is the only service that decides who a caller is,
and the only one that issues tokens.

- API contract: [`docs/api-contract.md`](docs/api-contract.md), 27 endpoints.
  Yehia and Mohab write their clients against it.
- Run it from source with `npm run dev`, or deploy it to floci with the
  Terraform in [`infra/`](infra/README.md).

## What works

Everything below is covered by `tests/` and was exercised against a running
server.

- **Courses**: create, edit, archive, restore, search, paged listing. Archiving
  is the only delete, so a course keeps its history and its sections are
  archived with it.
- **Sections**: one to five time blocks each, and a room cannot be booked twice
  at the same time. The check runs inside the transaction that inserts, under a
  lock on the room, so two requests cannot both see the room as free.
- **CSV import**: one request, validated in memory, written in one transaction.
  Nothing is stored on disk, a dry run writes nothing, and the same file cannot
  be imported twice because the file is hashed.
- **Identity**: register, verify by email, log in, refresh, log out, reset a
  forgotten password. Passwords are Argon2id, access tokens are RS256 with a
  `kid`, refresh tokens are opaque and rotate, and the signing key is sealed
  with KMS.
- **Frontend**: sign in, courses, sections, imports, accounts admin, and the
  verification and reset pages. Plain HTML, CSS and ES modules, no build step.

## Layout

```
src/
  app.js        middleware, routes, static files, error handling
  server.js     unseals the key, listens, starts the mailer, shuts down cleanly
  config.js     reads the environment once, fails fast if something is missing
  logger.js     one JSON object per line
  db.js         pg pool, readiness ping, transaction helper
  errors.js     ApiError and the one error shape
  auth/         passwords, keystore, tokens, sessions, middleware, Turnstile
  email/        templates, SES sender, the outbox worker
  http/         cookies, pagination, upload, CORS, security headers, rate limit
  imports/      the CSV parser (pure functions)
  routes/       the URL table
  controllers/  HTTP in and out
  services/     the rules: overlap check, import, login flows
  models/       SQL and row shapes
frontend/       the pages and their modules
tests/          node:test, real HTTP against a real database
db/             schema.sql and the invariant checks
infra/          Terraform: cluster, network, IAM, task, load balancer
mailbox/        a local inbox for reading the mail floci captures
```

Layers only go one way: `routes -> controllers -> services -> models -> pg`.
A service never sees `req`, and a model never decides a status code. That is how
the room rule lives in one place instead of inside a request handler.

## Data model

`db/schema.sql` creates eight tables: `users`, `sessions`, `auth_tokens`,
`email_outbox`, `courses`, `sections`, `section_times`, `imports`.

Two ideas run through them. **Archive, never delete**: every "is this code
taken?" rule filters to live rows, so archiving frees the code and keeps the
history. **Time is wall-clock**: `section_times` stores `time`, not a timestamp,
because a 09:00 class should stay at 09:00 when the clocks change.

The one rule SQL cannot express is two sections in the same room at the same
time. `db/verify_invariants.sql` tries to break every constraint, reports PASS
or FAIL for each check, then rolls everything back:

```bash
docker exec -i class-tt-postgres psql -U class_tt -d catalogue \
  -v ON_ERROR_STOP=1 < db/verify_invariants.sql
```

## Running it

The database and the emulator come from the compose file in the parent folder
(floci on :4566, its console on :4500, Postgres on :5433).

```bash
cp .env.example .env      # once
npm install
npm run dev               # http://localhost:3000
npm test                  # needs DATABASE_URL and the Postgres container
```

To deploy the container instead of running it from source:

```bash
./deploy/deploy.sh
```

That builds the image, applies the Terraform and checks the four responses.
`--plan` stops after the plan, `--no-build` reuses the image, `--destroy` removes
the stack. The app ends up on <https://localhost:8443>; there is no HTTP
listener, and the certificate is self-signed, so the browser warns once.
[`infra/README.md`](infra/README.md) has the rest, including how the certificate
is made and where floci differs from real AWS.

## Health endpoints

`GET /healthz` answers whether the process is alive, and `GET /readyz` answers
whether this task can serve traffic (it pings the database).

They differ on purpose. When the database goes away, `/readyz` turns 503 while
`/healthz` stays 200, so the platform takes the task out of the load balancer
instead of restarting it again and again. On the deployed service, with Postgres
stopped, `/readyz` returned `{"status":"not_ready","db":"unreachable"}` and
`/healthz` still returned `{"status":"ok"}`.

Both are hidden from the internet: the load balancer answers 404 for them, and
so does the app if a request reaches it from outside the private range.

## Things the service always does

- Every error is `{"error":{"code","message","requestId"}}`. Clients branch on
  `code`; the message can change.
- Every response carries `x-request-id`. An incoming one is only kept if it looks
  like an id, so a header cannot inject a fake line into the logs.
- Request logs have method, path, status and duration. Never a body, never a
  header, never a token.
- JSON bodies are capped at 100 KB, and broken JSON is refused before any handler
  runs.
- Admin checks read the role from the database, not from the token, because a
  token can be two hours old.

## Known gaps

The `section.changed` event that would let Timetable skip a refresh is not emitted.
The report artefacts (threat table, security-test evidence, demo video) are
written separately.
