# API Contract - Catalogue & Accounts

**Owner:** Mohamed Ayman - 239236
**Callers:** Yehia (Timetable), Mohab (Compare & Share), my frontend
**Base URL:** `https://localhost:8443` on floci locally; the deployed URL goes out at hand-off
**Version:** **1.8, final**, agreed 24 Nov 2026 (1.8 makes the import list reject an unknown `status` with `422`; 1.7 listed `422 VALIDATION_FAILED` in the shared error table; 1.6 removed internal spaces from course codes; 1.5 amended the refresh grace wording). Supersedes 1.0–1.7 (changelog at the end).

This document says each endpoint's input and output. Nothing else.

**Coverage:** 27 endpoints in eight groups. Email verification and password reset are in.

---

# At a glance

Everything below this section is detail. This section is the shape of the thing.

**What it is.** One service that owns the *catalogue* (courses, sections, rooms, time blocks, CSV import) and the *identity* of the whole system (accounts, roles, tokens). It is the only service that can say who you are.

| Group | Endpoints | What it is for | Who may call it |
|---|---|---|---|
| 1. Auth and identity | 6 | register, log in, refresh, log out, "who am I", signing keys | public + any user |
| 2. Admin: users | 2 | list accounts, change a role | `admin` only |
| 3. Courses | 5 | the course catalogue, archived rather than deleted | any user reads, `admin` writes |
| 4. Sections and availability | 5 | sections, their weekly time blocks, room-conflict rejection, availability search | any user reads, `admin` writes |
| 5. Imports | 3 | one CSV in, one transaction, nothing stored | `admin` only |
| 6. Ops | 2 | `/healthz` and `/readyz` for the ALB and the container | **nobody** - no auth, by design |
| 7. Email verification | 2 | prove the address, and ask for the mail again | public |
| 8. Password reset | 2 | reset by email link, revoking every session | public |

**Three credentials, never confused:**

| credential | lives | lifetime | dies when |
|---|---|---|---|
| **access token** (JWT, RS256) | in a header | 2 hours | expiry - nothing to revoke |
| **refresh token** (opaque) | `__Secure-refresh` cookie | 7 days | logout, reuse, role change, password reset |
| **action token** (opaque) | in an email link | 24 h (verify) / 30 min (reset) | used once, or a newer one issued |

**The five rules that make this more than CRUD.** Each is a rejection enforced in the service against the database - a lock, a unique index or a transaction - not a button hidden in a form. Three of the five are also enforced by a constraint the database itself holds (the import hash, the live section code, the role values); the room rule cannot be, because the conflicting row does not exist yet, which is exactly why it takes an advisory lock.

1. **A room cannot be double-booked** - overlapping `[start, end)` blocks in the same room are `409 ROOM_CONFLICT`, enforced under an advisory lock inside the transaction.
2. **A CSV import is all or nothing** - 5,000 rows validated in memory, then one transaction; a single bad row imports nothing and returns every row error.
3. **The same file cannot be imported twice** - SHA-256 of the bytes, unique among committed imports, `409 ALREADY_IMPORTED`.
4. **Rooms and sections are archived, never deleted** - Yehia and Mohab store ids; a hard delete would silently blank their timetables.
5. **The last admin cannot be demoted, and nobody can change their own role** - a lock-out is unrecoverable without a database edit.

**A request's life, in five steps.**

1. Browser sends `Authorization: Bearer <jwt>` (or nothing, on the public routes).
2. Middleware verifies the signature against `/.well-known/jwks.json`, then `iss`, `aud`, `exp`.
3. For anything `admin`, the role is re-read from the database - a 2-hour-old claim is never trusted for authority.
4. The handler runs one transaction; the room lock is taken before any write.
5. Either `2xx` with camelCase JSON, or the shared error envelope with a stable `code` - never a bare string, never a `200` carrying an error.

**How to read the endpoint sections.** Each one is: *who may call it* → **Input** table → **Output** with a real body → **Errors** table listing only the codes beyond the four universal ones. If a section has no error table, it has none beyond `400`/`401`/`403`/`429`.

**What a caller can rely on.** `code` never changes without a version bump; `message` may. Ids are uuid strings. Timestamps are UTC; class times are Cairo wall-clock `"HH:MM"`. Lists paginate with `limit` + opaque `cursor`. Every **error** response carries a `requestId` that also appears in the server log - quote it in a bug report and it can be found.

---

# Conventions

**Transport.** JSON (`application/json`) everywhere except `POST /api/imports`, which takes `multipart/form-data`.

**Naming.** Wire fields are `camelCase`. Database columns are `snake_case`. The CSV file keeps its own `snake_case` headers. The boundary is the API, and it is crossed exactly once.

**Two kinds of time.** Timestamps (`createdAt`, `updatedAt`, `archivedAt`) are ISO-8601 UTC with a `Z`. Class times (`startTime`, `endTime`) are `"HH:MM"` 24-hour **Africa/Cairo wall-clock** strings, never datetimes - a weekly timetable is not an appointment.

**Auth.** `Authorization: Bearer <accessToken>` on every endpoint except where noted. The refresh token never appears in a body; it lives only in the `__Secure-refresh` cookie.

**Three kinds of credential, three lifetimes.** An **access token** is a 2-hour JWT, presented in a header, never stored. A **refresh token** is an opaque 7-day cookie, rotated on use, revocable. A **action token** is an opaque single-use secret that arrives by email (verification, password reset): 32 random bytes, stored only as a SHA-256 hash, short-lived, consumed on use. They are separate tables because they answer separate questions, and "revoke all sessions" must not be the same operation as "burn this reset link".

**Error envelope.** Every non-2xx response:

```json
{ "error": { "code": "SOME_CODE", "message": "human sentence", "requestId": "uuid", "details": {} } }
```

Clients branch on `code`. `message` may change between releases; `code` may not. `details` is optional and shape-specific. `requestId` is always present: echoed from the `x-request-id` header when the client sends one, generated otherwise. It is also the only field that appears in the server log for every error, which is what makes a user's screenshot traceable.

**Common errors - every endpoint can return these:**

| status | code | when |
|---|---|---|
| 400 | `VALIDATION_FAILED` | the request could not be read as the right shape: malformed JSON, wrong type, missing required field, bad path parameter |
| 422 | `VALIDATION_FAILED` | the body parsed, but a value breaks a rule (`credits` out of range, a code that is not a code, a password too short); `details.field` or `details.fields` names the offender |
| 401 | `UNAUTHENTICATED` | token missing, malformed, expired or unverifiable |
| 403 | `FORBIDDEN` | token valid, but the caller's role may not do this |
| 429 | `RATE_LIMITED` | 60 requests/min per IP (`/healthz` and `/readyz` exempt); `details.retryAfterSeconds` |

**The rate limit is per task, not per service.** Counters live in the process, so with four tasks the effective ceiling is 240/min. Stated here rather than hidden: a shared counter needs Redis, and adding Redis to fix a limit nobody is attacking is a worse trade than naming the number. The per-account login lockout is in Postgres, so that one is exact across tasks.

The tables under each endpoint list only its **additional** codes. An endpoint with no table has none beyond those four. Repeating four rows twenty-three times would bury the ones that matter.

**Pagination.** List endpoints take `limit` (default 25, max 100) and `cursor` (opaque, from `nextCursor`). Response: `{ "items": [...], "nextCursor": string|null }`. `nextCursor: null` means no more pages.

**Size limits.** JSON bodies 100 KB. The multipart import 2 MB. Both are enforced before parsing, not after.

**Cookies and CORS.** The refresh cookie is `HttpOnly; Secure; SameSite=Strict; Path=/api/auth`. `SameSite=Strict` means the browser will not send it cross-site, so **the frontend must be served from the same site as the API** - same host, port irrelevant (`localhost:3000` and `localhost:8443` are the same site). If it ever moves to a different site, the cookie must become `SameSite=None; Secure` and gain CSRF protection, which is a real change, not a flag. CORS: allow-list from `CORS_ORIGINS`, `credentials: true`, never `*`.

A `Secure` cookie on plain HTTP is normally dropped, with two exceptions that matter here: `http://localhost` counts as a secure context, so the cookie works during local development; and floci's ALB is HTTP, so the deployed demo also works **only because it is reached over `localhost` or a tunnel that terminates TLS**. Serve the demo from a bare `http://192.168.x.x` address and login will appear to succeed and then silently fail at the first refresh - the cookie was never stored. This is the same class of bug as the cross-site one, and it is written down for the same reason.

---

# Contents

[1 Auth and identity](#1-auth-and-identity) · [2 Admin: users](#2-admin-users) · [3 Courses](#3-courses) · [4 Sections and availability](#4-sections-and-availability) · [5 Imports](#5-imports) · [6 Ops](#6-ops) · [7 Email verification](#7-email-verification) · [8 Password reset](#8-password-reset) · [Not in this contract](#not-in-this-contract) · [Change log](#change-log)

All eight groups are **agreed and final** (v1.4). The endpoint counts per group are in "At a glance".

---

# 1. Auth and identity

## The access token

| Claim | Value |
|---|---|
| `alg` / `kid` | `RS256`; `kid` names the signing key |
| `iss`, `aud` | `class-tt` |
| `sub` | user uuid |
| `role` | `student` or `admin` |
| `iat`, `exp` | lifetime **2 hours** |
| `jti` | token uuid |
| **not** included | email, name |

Callers verify the signature against `/.well-known/jwks.json`, then `iss`, `aud` and `exp`, allowing ≤ 60 s skew. Cache the key set for 10 minutes; refetch on an unknown `kid`.

**Refresh tokens are opaque**, not JWTs: random strings, stored hashed in `sessions`, revocable, rotated on every use, **7-day** lifetime.

**Seeded accounts.** The seed script creates one admin and one student, both with `emailVerifiedAt` already set. Without that a fresh database could not be logged into at all: §7 gates login on verification, and only an admin can promote anyone. The first login of a demo therefore never depends on the mail path - the *newly registered* account does, which is the interesting part of the demo.

## POST `/api/auth/register`

Public; Turnstile required. Creates a **student** account - admins are only made by an admin (§2).

**Input**

| where | field | type | rules |
|---|---|---|---|
| body | `email` | string | valid, ≤ 254 chars, trimmed and lower-cased |
| body | `password` | string | 10–72 chars |
| body | `turnstileToken` | string | Cloudflare Turnstile token |

The 72 is not arbitrary: it is bcrypt's input limit, and bcrypt silently ignores everything past it. Passwords are hashed with **argon2id**, which has no such limit, but the contract keeps 72 as the ceiling so that a fallback to bcrypt cannot quietly make the 73rd character meaningless. Measured in characters, and every character counts - no trimming, no truncation, no "fixing" the user's password.

**Output - `202 Accepted`**

```json
{ "status": "accepted" }
```

Identical whether the account was created or the email already existed, so this endpoint cannot be used to discover which addresses are registered. No token: the client logs in next - and cannot until it verifies (§7). The handler hashes the password and attempts the insert either way, so a duplicate costs the same time as a new account.

A verification mail is queued **only when a row was actually inserted**. Re-registering an existing address sends nothing, otherwise the endpoint becomes a way to mail a stranger repeatedly, and the endpoint's uniform response would be hiding a very non-uniform side effect.

**Errors**

| status | code | when |
|---|---|---|
| 403 | `TURNSTILE_FAILED` | Turnstile rejected the token, or could not be reached (fails closed) |

## POST `/api/auth/login`

Public; Turnstile required, and checked **before** the password hash - so a bot that cannot solve a challenge cannot burn CPU on argon2id.

The order inside the handler is: Turnstile → normalise email → **verify password** → check the lock → check verification → issue tokens. Verifying the password before checking anything else is deliberate: if the lock or the verification state were checked first, an unknown email would always give `401` while a known-but-unverified or locked account would give a different code, which tells an attacker the account exists. Wrong password therefore always yields `401 INVALID_CREDENTIALS`, and only a **correct** password reveals `423 LOCKED` or `403 EMAIL_NOT_VERIFIED`. The cost is one hash per attempt on a locked account, which the per-IP rate limit bounds.

**Input**

| where | field | type | rules |
|---|---|---|---|
| body | `email` | string | normalised as at registration |
| body | `password` | string | compared to the stored hash |
| body | `turnstileToken` | string | verified first |

**Output - `200 OK`** and the refresh cookie

```json
{
  "user": { "id": "8f14e45f-…", "email": "student@example.edu", "role": "student", "createdAt": "2026-11-24T08:12:03Z" },
  "accessToken": "eyJhbGciOiJSUzI1NiIsImtpZCI6…",
  "tokenType": "Bearer",
  "expiresIn": 7200
}
```

The `user` object is a snapshot. `/api/auth/me` is the authority.

**Errors**

| status | code | when |
|---|---|---|
| 401 | `INVALID_CREDENTIALS` | wrong email or wrong password - one code, one message, one timing path |
| 403 | `TURNSTILE_FAILED` | as above |
| 403 | `EMAIL_NOT_VERIFIED` | password correct, but the address has never been verified (§7); `details.resendable` is `true` so the UI can offer a resend |
| 423 | `LOCKED` | 5 failures in 15 minutes, reached only with the **correct** password (see above); `details.retryAfterSeconds` - the counter is per account and lives in the database, not in memory |

## POST `/api/auth/refresh`

Public; authenticated by the cookie alone. No body.

**Input**

| where | field | rules |
|---|---|---|
| cookie | `__Secure-refresh` | required |

**Output - `200 OK`**, a new refresh cookie, and the presented one invalidated in the same transaction

```json
{ "accessToken": "eyJhbGciOiJSUzI1NiIs…", "tokenType": "Bearer", "expiresIn": 7200 }
```

**Errors**

| status | code | when |
|---|---|---|
| 401 | `INVALID_REFRESH` | absent, unknown or expired |
| 410 | `REFRESH_REUSED` | a token rotated **more than 30 s ago** presented again - every session in that family is revoked |

Detecting reuse matters more than it looks: a stolen token that gets used after the legitimate one has moved on is the only signal available, and revoking the family turns a silent compromise into a forced re-login.

**The 30-second grace window.** Two tabs both notice an expiring token and both call refresh; strictly-once rotation would answer the loser with `410`, revoke the family and log the user out of their own browser. So a token that was rotated within the last 30 seconds is accepted **once more**, and the response carries a fresh successor issued to that caller - a second child of the same parent, not a copy of the first. The browser ends up holding one valid token because the later response is written last. Past 30 seconds, or on a second attempt after the grace has already been used, reuse is either a bug or a thief, and both deserve `410`. This is a deliberate weakening of the rotation guarantee, bounded in time and in number, and recorded here rather than discovered later.

Why a second child rather than "the same token again": the server stores only a SHA-256 of each refresh token, so it cannot reproduce a plaintext it never kept. Returning the identical token would mean storing a live credential in readable form for thirty seconds, which is a worse trade than an extra row in the family.

## POST `/api/auth/logout`

Revokes the session row - not just the cookie - so the token family stops working server-side.

**Input**

| where | field | rules |
|---|---|---|
| cookie | `__Secure-refresh` | if present, its session is revoked |

**Output - `204 No Content`**, cookie expired.

Always `204`, whether a session was found or not: logout that reports state is a way to ask questions. It is the one state-changing endpoint that needs no access token, because a user with an expired token still has the right to end their session.

## GET `/api/auth/me`

Any authenticated user. Reports the caller's **current** role, read from the database.

**Input** - none beyond `Authorization`.

**Output - `200 OK`**

```json
{ "id": "8f14e45f-…", "email": "student@example.edu", "role": "student", "emailVerifiedAt": "2026-11-24T08:20:11Z", "createdAt": "2026-11-24T08:12:03Z" }
```

`emailVerifiedAt` is `null` for an unverified account - although such an account cannot reach this endpoint, since login is blocked until verification. It is here so the frontend has one object to render and does not have to infer state from which request failed.

The only endpoint whose answer is guaranteed fresher than the token, so the frontend asks it after a role change instead of trusting `role` for two hours.

## GET `/.well-known/jwks.json`

Public. What the other two services verify tokens against.

**Input** - none.

**Output - `200 OK`**, `Cache-Control: public, max-age=600`

```json
{ "keys": [ { "kid": "2026-11-24", "kty": "RSA", "use": "sig", "alg": "RS256", "n": "sXch…", "e": "AQAB" } ] }
```

During rotation the array holds both keys, newest first, for at least 2 hours, so a caller that refetches on an unknown `kid` never hits a gap. The route has no error response: if the key cannot be unsealed the task never passes readiness, so a failure here looks like "service down", never like "your token is forged".

---

# 2. Admin: users

Two endpoints. There is no admin "create user" (accounts self-register and are promoted) and no delete: disabling an account needs a `disabled_at` column plus a session sweep, and building half of it would be worse than not building it.

**How `admin` is enforced.** The token's `role` is up to two hours stale, so it is never trusted alone. The middleware verifies the JWT, then reads `users.role` from the database. A role change therefore takes effect on the caller's next request, and the change also revokes that user's refresh sessions so no new token can be minted carrying the old claim.

## GET `/api/admin/users`

Admin only. Lists accounts.

**Input**

| where | field | type | rules |
|---|---|---|---|
| query | `limit`, `cursor` | | as in Conventions |
| query | `role` | string | `student` or `admin`; omit for all |
| query | `q` | string | case-insensitive substring of email, ≤ 64 chars |

**Output - `200 OK`**

```json
{
  "items": [
    { "id": "8f14e45f-…", "email": "student@example.edu", "role": "student", "emailVerifiedAt": "2026-11-24T08:20:11Z", "createdAt": "2026-11-24T08:12:03Z", "lockedUntil": null }
  ],
  "nextCursor": null
}
```

No password hash, no failure counters, no session data. A listing endpoint is the easiest place to leak what the database happens to hold.

`cursor` is `base64url(createdAt + "|" + id)` - a keyset cursor over `(created_at, id)`. An offset would skip or repeat rows whenever an account is created mid-paging; a keyset cursor cannot. Opacity means the encoding can change without breaking a client.

## PATCH `/api/admin/users/{id}/role`

Admin only. Promotes or demotes an account.

**Input**

| where | field | type | rules |
|---|---|---|---|
| path | `id` | uuid | target user |
| body | `role` | string | `"student"` or `"admin"` |

```json
{ "role": "admin" }
```

**Output - `200 OK`**

```json
{ "id": "8f14e45f-…", "email": "student@example.edu", "role": "admin", "updatedAt": "2026-11-24T09:40:11Z" }
```

Side effect: every refresh session belonging to that user is revoked, and the change is logged with the acting admin's `sub`, the target, and both roles.

**Rules**

- An admin cannot change **their own** role, in either direction.
- The **last** remaining admin cannot be demoted. The same rule from the other side, in different code, so it is checked twice on purpose: a lock-out is unrecoverable without a database edit.
- A student can never promote themselves, even with a valid token - the database read is what decides.

**Errors**

| status | code | when |
|---|---|---|
| 400 | `VALIDATION_FAILED` | `role` missing or not one of the two values; `id` not a uuid |
| 403 | `SELF_ROLE_CHANGE` | caller is the target |
| 404 | `USER_NOT_FOUND` | no such user |
| 409 | `LAST_ADMIN` | the target is the only remaining admin |

---

# 3. Courses

A course is `{ id, code, title, credits }` and it can be **archived**. The `code` is what humans use and other systems quote - `CS101` on a printed timetable, inside an `.ics` file, in Mohab's comparison. Every rule below follows from that one fact.

**Course object**

| field | type | notes |
|---|---|---|
| `id` | uuid | stable forever; ids are never reused |
| `code` | string | unique, upper-case, **no spaces**, 2–20 chars, letters/digits/dash/underscore |
| `title` | string | 1–200 chars |
| `credits` | integer | 0–30 |
| `sectionCount` | integer | how many **active** sections reference it |
| `archivedAt` | string \| null | set when archived; `null` while the course is offered |
| `createdAt`, `updatedAt` | string | ISO-8601 UTC |

**Archiving, not deleting.** There is no hard delete anywhere in this API. The other two services keep copies of what they read here, so a vanished row becomes a dangling reference in somebody else's database. Archived rows stay readable, keep their ids, and drop out of normal listings.

Reads need any valid login; writes need `admin`.

## GET `/api/courses`

Any authenticated user. The course browser, and any service reading the catalogue.

**Input**

| where | field | type | rules |
|---|---|---|---|
| query | `q` | string | case-insensitive substring of `code` or `title`, ≤ 64 chars |
| query | `code` | string | exact, case-insensitive; combined with `q` as AND, not either/or |
| query | `includeArchived` | boolean | default `false`; **admin only** - a student sending `true` gets `403 FORBIDDEN`, not a silent `false` |
| query | `limit`, `cursor` | | as in Conventions |

**Output - `200 OK`**

```json
{
  "items": [
    { "id": "3b1c…", "code": "CS101", "title": "Introduction to Programming", "credits": 3, "sectionCount": 4, "archivedAt": null, "createdAt": "2026-11-20T10:00:00Z", "updatedAt": "2026-11-22T14:31:00Z" }
  ],
  "nextCursor": null
}
```

## GET `/api/courses/{id}`

Any authenticated user.

**Input** - path `id` (uuid).

**Output - `200 OK`** - one course object. An **archived** course is still returned, with `archivedAt` set: sections reference it, so a caller must be able to resolve a title after the course is withdrawn.

**Errors**

| status | code | when |
|---|---|---|
| 404 | `COURSE_NOT_FOUND` | no such course |

## POST `/api/courses`

Admin only.

**Input**

| where | field | type | rules |
|---|---|---|---|
| body | `code` | string | required; upper-cased and **internal spaces removed** before storing, so `CS 210` and `CS210` are the same course; 2–20 chars, letters/digits/dash/underscore |
| body | `title` | string | required; trimmed, 1–200 chars |
| body | `credits` | integer | required; 0–30 |

```json
{ "code": "CS101", "title": "Introduction to Programming", "credits": 3 }
```

**Output - `201 Created`** - the course object with `sectionCount: 0`.

**Errors**

| status | code | when |
|---|---|---|
| 409 | `DUPLICATE_CODE` | the normalised code already exists; `details.code` |

Unlike registration, this `409` is explicit. The caller is an authenticated admin editing the catalogue, `"this code already exists"` is exactly what they need to know, and admins can list every course anyway.

## PATCH `/api/courses/{id}`

Admin only. Partial update - send only what changes.

**Input**

| where | field | type | rules |
|---|---|---|---|
| path | `id` | uuid | |
| body | `code` | string | optional; same format; **only while no active sections exist** |
| body | `title` | string | optional |
| body | `credits` | integer | optional |
| body | `archived` | boolean | optional; `true` archives, `false` restores. Restoring a course does **not** restore its sections |

```json
{ "title": "Introduction to Programming (Revised)", "credits": 4 }
```

**Output - `200 OK`** - the updated object.

**Rules**

- A `code` change is refused while **active** sections reference the course. Archived sections do not block it: they are out of the catalogue, and a code printed on last term's timetable is a historical record, not a live reference.
- Sending the **same** code back is a no-op, even on a course with sections. Clients send whole objects; punishing that is a trap.

**Errors**

| status | code | when |
|---|---|---|
| 404 | `COURSE_NOT_FOUND` | no such course |
| 409 | `CODE_IN_USE` | changing `code` while active sections exist |
| 409 | `DUPLICATE_CODE` | changing `code` to one already taken |

## DELETE `/api/courses/{id}`

Admin only. **Archives** the course and, in the same transaction, its active sections - a course that is no longer offered must not leave live sections hanging off it.

**Input** - path `id` (uuid).

**Output - `200 OK`**

```json
{ "id": "3b1c…", "archivedAt": "2026-11-24T09:15:02Z", "archivedSections": 4 }
```

Idempotent: archiving an already-archived course returns `archivedSections: 0`.

`200` rather than `204` because the side effect is information the UI should show - "archived, along with 4 sections" is a different sentence from "archived".

**Errors**

| status | code | when |
|---|---|---|
| 404 | `COURSE_NOT_FOUND` | no such course |

No `409` here, and that is the point: withdrawing a discontinued course is a normal operation. The foreign key stays `on delete restrict`; nobody deletes these rows at all, which is what makes saved references safe.

---

# 4. Sections and availability

A section is one *offering* of a course - a lecture, a lab, a tutorial - in a room, with one to five time blocks.

**Section object**

| field | type | notes |
|---|---|---|
| `id` | uuid | stable forever |
| `course` | object | `{ id, code, title }` embedded |
| `sectionCode` | string | 1–10 chars, unique **among active sections of that course** (`CS101` / `L1`) |
| `type` | string | `lecture`, `lab`, `tutorial` |
| `room` | string | 1–32 chars, a label not an entity |
| `capacity` | integer | 1–500 |
| `times` | array | 1–5 blocks: `{ dayOfWeek, startTime, endTime }` |
| `archivedAt` | string \| null | set when withdrawn |
| `createdAt`, `updatedAt` | string | ISO-8601 UTC |

**Time blocks.** `dayOfWeek` is `0`–`6` with **0 = Sunday**, matching JavaScript's `Date.getDay()` and the CSV column, so no conversion exists anywhere to get wrong. Times are `"HH:MM"` Africa/Cairo wall-clock.

A block must start and end on the **same day**: `startTime` < `endTime`, always. An overnight class (`22:00–01:00`) is therefore not representable, which is a deliberate limit - a class that crosses midnight breaks every one-day-one-block mental model and none of these classes exist. Because times are wall-clock rather than instants, a DST change moves the clock but not the timetable: the 10:00 lecture is at 10:00 in both January and July, and no stored row has to be touched when the offset changes.

**One predicate, everywhere.** A block occupies the half-open interval `[start, end)`. Two blocks clash when they are on the same day and `a.start < b.end && b.start < a.end`. Half-open is what makes `10:00–11:00` and `11:00–12:00` legal: back-to-back classes are normal, and a closed-interval check would reject them. This exact predicate must be used by the room check, the CSV validator and Yehia's clash detector. If two implementations disagree, the demo produces a clash nobody can explain.

**One call, not two.** Every section carries its course's `id`, `code` and `title` inline. Yehia stores `sectionId`s and renders "CS101 - Introduction to Programming - L1"; without the embedded course he needs a second call per row, or his own copy of the catalogue. The embedding duplicates three fields so that one request answers the question, and it is a read model - never the source of truth.

## GET `/api/sections`

Any authenticated user. Two modes on one route.

**Mode A - availability search.** Filters optional and combinable.

| where | field | type | rules |
|---|---|---|---|
| query | `courseId` | uuid | sections of one course |
| query | `courseCode` | string | exact, case-insensitive |
| query | `dayOfWeek` | integer | 0–6; required if `from` or `to` is given |
| query | `from` | string | `"HH:MM"`; keeps sections whose block overlaps `[from, to)` |
| query | `to` | string | `"HH:MM"`; must be after `from` |
| query | `room` | string | exact, case-insensitive |
| query | `type` | string | `lecture` / `lab` / `tutorial` |
| query | `includeArchived` | boolean | admin only, default `false` |
| query | `limit`, `cursor` | | as in Conventions |

**Mode B - batch read by id.** `?ids=<uuid>,<uuid>,…`, max **100**. This is the frozen call the other services make. It ignores every filter above, including `limit` and `cursor` - the id list is the whole query and its 100-id cap is the only limit - and mixing `ids` with filters is a `400`.

**Output - `200 OK`**, both modes

```json
{
  "items": [
    {
      "id": "b2f7…", "sectionCode": "L1", "type": "lab", "room": "B-204", "capacity": 30,
      "course": { "id": "3b1c…", "code": "CS101", "title": "Introduction to Programming" },
      "times": [ { "dayOfWeek": 1, "startTime": "10:00", "endTime": "11:30" } ],
      "archivedAt": null, "createdAt": "2026-11-20T10:05:00Z", "updatedAt": "2026-11-20T10:05:00Z"
    }
  ],
  "nextCursor": null,
  "missingIds": []
}
```

`missingIds` appears **only** in batch mode. An id that no longer exists goes there and the response stays `200`, because the caller is rendering a list and one dead id must not blank the page; "this section is gone" is something it acts on per row. Archived sections **are** returned in batch mode with `archivedAt` set, so a saved timetable can say "no longer offered" instead of showing a hole.

**Errors**

| status | code | when |
|---|---|---|
| 400 | `VALIDATION_FAILED` | `dayOfWeek` outside 0–6, `from` after `to`, a time window without `dayOfWeek`, empty `ids`, more than 100 ids, `ids` mixed with filters |

## GET `/api/sections/{id}`

Any authenticated user. Single section, archived included.

**Input** - path `id` (uuid).

**Output - `200 OK`** - one section object.

**Errors**

| status | code | when |
|---|---|---|
| 404 | `SECTION_NOT_FOUND` | unknown id |

## POST `/api/sections`

Admin only.

**Input**

| where | field | type | rules |
|---|---|---|---|
| body | `courseId` | uuid | required; must exist and not be archived |
| body | `sectionCode` | string | required; 1–10 chars; unique among active sections of that course |
| body | `type` | string | required; `lecture`/`lab`/`tutorial` |
| body | `room` | string | required; 1–32 chars |
| body | `capacity` | integer | required; 1–500 |
| body | `times` | array | required; 1–5 blocks; `dayOfWeek` 0–6, `"HH:MM"`, `start < end` |

```json
{
  "courseId": "3b1c…", "sectionCode": "L1", "type": "lab", "room": "B-204", "capacity": 30,
  "times": [ { "dayOfWeek": 1, "startTime": "10:00", "endTime": "11:30" } ]
}
```

**Output - `201 Created`** - the created section object.

**Rules, one transaction:**

1. The request's own blocks must not clash with each other - two labs at the same time inside one section is nonsense, not a conflict, so `400`, not `409`.
2. Every block must find its room free: same `room`, same `dayOfWeek`, overlapping interval, not archived. A clash returns the conflicting section id and block, so the admin UI can say *"B-204 is booked by CS102-L2, Mon 10:00–11:30"* instead of "conflict".
3. The check and the insert share one transaction **and** an advisory lock per room (`pg_advisory_xact_lock`), because the row that would conflict does not exist yet and so cannot be locked. Two admins submitting the same slot at the same instant: one gets `201`, the other `409`. Writers on different rooms never wait on each other.
4. A double-click cannot create two sections: `sectionCode` is unique among a course's active sections, so the second request is a `409 SECTION_CODE_TAKEN` rather than a duplicate. There is no idempotency key here because the unique code already makes a retry safe.

**Errors**

| status | code | when |
|---|---|---|
| 404 | `COURSE_NOT_FOUND` | unknown `courseId` |
| 409 | `ROOM_CONFLICT` | the room is booked at an overlapping time; `details.conflictingSectionId`, `details.conflict` |
| 409 | `SECTION_CODE_TAKEN` | another active section of that course uses `sectionCode` |
| 409 | `COURSE_ARCHIVED` | cannot add a section to an archived course |

## PATCH `/api/sections/{id}`

Admin only. Partial update.

**Input**

| where | field | type | rules |
|---|---|---|---|
| path | `id` | uuid | |
| body | `sectionCode` | string | optional |
| body | `type` | string | optional |
| body | `room` | string | optional |
| body | `capacity` | integer | optional; 1–500 |
| body | `times` | array | optional; **replaces the whole set**, 1–5 blocks |
| body | `archived` | boolean | optional; `true` archives, `false` restores |

```json
{ "times": [ { "dayOfWeek": 3, "startTime": "14:00", "endTime": "15:30" } ] }
```

**Output - `200 OK`** - the updated section object.

**Rules**

- `times` is **replace, not merge**. Sending one block leaves exactly one block. Merging arrays produces "I changed the lab time and the old one is still there"; the client always sends the set it wants.
- The room check re-runs against the new times, excluding this section, under the same advisory lock.
- `courseId` is **immutable**. Moving an offering to a different course is a different offering, and a silent move would strand every timetable that already references it.
- Restoring an archived section whose `sectionCode` has since been taken returns `409 SECTION_CODE_TAKEN` - the archive freed the code, and reuse is legitimate.

**Errors**

| status | code | when |
|---|---|---|
| 404 | `SECTION_NOT_FOUND` | unknown id |
| 409 | `ROOM_CONFLICT` | the new times collide with another booking |
| 409 | `SECTION_CODE_TAKEN` | the code is used by another active section of that course |

## DELETE `/api/sections/{id}`

Admin only. **Archives** the section.

**Input** - path `id` (uuid).

**Output - `200 OK`**

```json
{ "id": "b2f7…", "archivedAt": "2026-11-24T09:32:44Z" }
```

Archived sections still resolve by id, still appear in batch reads with `archivedAt` set, and disappear from search. Idempotent.

**Errors**

| status | code | when |
|---|---|---|
| 404 | `SECTION_NOT_FOUND` | unknown id |

**Why there is no `SECTION_IN_USE`.** An earlier draft returned `409` when a timetable referenced a section, which requires asking Yehia's service before every delete: a synchronous dependency on another team member's uptime, and a check that fails open when his service is down. Archiving removes the question - the section stays, the reference keeps resolving, the UI shows the truth. Removing a section from the catalogue and removing it from someone's timetable are different operations with different owners.

## What `ROOM_CONFLICT` does not do

It checks **the catalogue against itself**: one room, one block at a time. It does not check any student's timetable.

- Two sections in *different* rooms at the same time are legal here. Whether *one student* can take both is Timetable's decision, using the `times` this API returns.
- A room conflict means the source data is wrong, so it is refused at write time. A personal clash is a choice, so it is refused by the service that holds the choice.

Both services apply the same predicate to their own data. Neither can do the other's job.

---

# 5. Imports

Bulk-loading a catalogue from a CSV. The file arrives in the request body, is validated in memory, and is written in **one transaction**. Nothing is stored, nothing is half-imported.

## The file format

`multipart/form-data`, one field named `file`, one file, **≤ 2 MB**, `text/csv` (also accepted when the browser sends `application/vnd.ms-excel` for a `.csv`).

Header row required. These columns, any order, each exactly once - an unknown or missing column is a `422`:

`course_code, course_title, credits, section_code, type, room, capacity, day_of_week, start_time, end_time`

| column | rules |
|---|---|
| `course_code` | as §3, upper-cased before use |
| `course_title` | 1–200 chars |
| `credits` | integer 0–30 |
| `section_code` | 1–10 chars |
| `type` | `lecture` / `lab` / `tutorial` |
| `room` | 1–32 chars |
| `capacity` | integer 1–500 |
| `day_of_week` | 0–6, **0 = Sunday** |
| `start_time`, `end_time` | `"HH:MM"`, `start < end` |

One row is one time block. Several rows may describe the same section (a lab meeting twice a week); they must agree on `type`, `room` and `capacity`.

**Row cap: 5,000.**

## POST `/api/imports`

Admin only.

**Input**

| where | field | type | rules |
|---|---|---|---|
| query | `dryRun` | boolean | optional, default `false` |
| form | `file` | file | required; one file; ≤ 2 MB; CSV |

**Output - `201 Created`**

```json
{ "importId": "c41d…", "status": "committed", "rowCount": 46, "imported": { "courses": 12, "sections": 34, "times": 41 } }
```

**Output - `200 OK`** for `dryRun=true` on a valid file

```json
{ "valid": true, "rowCount": 46, "errors": [] }
```

`importId` here is the same value as `id` on the two read endpoints below.

**All or nothing.** Courses are upserted by `code`, sections and times inserted, every room conflict checked - inside one transaction. One bad row and nothing is written. A fixed file re-sent afterwards is a fresh import, not a partial continuation.

**`dryRun` writes nothing at all** - no rows, no import history entry, no id. It runs the same code path and rolls back, so there is no second validation implementation to drift out of sync with the real one. On an invalid file it returns `422 IMPORT_INVALID` with the same report as a real attempt, **except that `details.importId` is absent** - there is no row, so there is no id to quote.

`dryRun` still honours `409 ALREADY_IMPORTED`: the question "would this file do anything?" has a useful answer when the answer is "no, it is already in", and saying so costs one index lookup.

**The checks run in a fixed order**, and the order is part of the contract: authentication → role → file present and size (`413`) → content type (`415`) → parse and validate (`422`) → commit. Size is checked before parsing, and both are checked after the role, so an unauthenticated caller cannot make the service read a 2 MB body or learn anything about the parser.

**Errors**

| status | code | when |
|---|---|---|
| 400 | `VALIDATION_FAILED` | no `file` field, wrong field name, more than one file |
| 409 | `ALREADY_IMPORTED` | this exact file was already committed; `details.importId` - applies to `dryRun` too |
| 413 | `FILE_TOO_LARGE` | over 2 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | not CSV |
| 422 | `IMPORT_INVALID` | header problems, more than 5,000 rows, or any row failed |

`422` body for a real attempt (for `dryRun`, drop the `importId` line):

```json
{
  "error": {
    "code": "IMPORT_INVALID",
    "message": "3 rows could not be imported",
    "requestId": "…",
    "details": {
      "importId": "c41d…",
      "totalErrors": 3,
      "truncated": false,
      "errors": [
        { "row": 14, "field": "room", "message": "B-204 is already booked on day 1, 10:00–11:30 (CS102-L2)" },
        { "row": 22, "field": "end_time", "message": "must be after start_time" },
        { "row": 31, "field": "day_of_week", "message": "must be 0–6" }
      ]
    }
  }
}
```

Row numbers are 1-based, with the header as row 1. Messages say *where* the problem is, never *what the row contained* - this report gets downloaded and mailed, and it must not become a copy of the data. Up to 100 errors are returned; `totalErrors` is the true count.

**Idempotency.** The file's SHA-256 is recorded on commit. Uploading identical bytes again returns `409 ALREADY_IMPORTED` with the original id instead of creating duplicates. Uniqueness applies only to **committed** imports, so retrying after a failure is allowed.

**Failed imports leave a record.** A rejected import still writes an `imports` row (`status: "failed"`, counts, report) in a separate transaction *after* the rollback - otherwise the evidence disappears along with the data that failed.

## GET `/api/imports`

Admin only. History, newest first.

**Input**

| where | field | type | rules |
|---|---|---|---|
| query | `status` | string | optional; `committed` or `failed` |
| query | `limit`, `cursor` | | as in Conventions |

**Output - `200 OK`**

```json
{
  "items": [
    { "id": "c41d…", "filename": "catalogue-2026-11.csv", "status": "committed", "rowCount": 46, "errorCount": 0,
      "uploadedBy": { "id": "8f14…", "email": "admin@example.edu" },
      "createdAt": "2026-11-24T09:40:00Z", "committedAt": "2026-11-24T09:40:02Z" }
  ],
  "nextCursor": null
}
```

**Errors**

| status | code | when |
|---|---|---|
| 422 | `VALIDATION_FAILED` | `status` is present but is not `committed` or `failed` (`details.field: "status"`) |

## GET `/api/imports/{id}`

Admin only. One import, including its report.

**Input** - path `id` (uuid).

**Output - `200 OK`**

```json
{
  "id": "c41d…", "filename": "catalogue-2026-11.csv", "status": "failed",
  "rowCount": 46, "errorCount": 3,
  "report": { "errors": [ { "row": 14, "field": "room", "message": "…" } ] },
  "uploadedBy": { "id": "8f14…", "email": "admin@example.edu" },
  "createdAt": "2026-11-24T09:40:00Z", "committedAt": null
}
```

`report.errors` is capped at 100 entries; `errorCount` is the true total.

**Errors**

| status | code | when |
|---|---|---|
| 404 | `IMPORT_NOT_FOUND` | unknown id |

---

# 6. Ops

Two probes, **unauthenticated by design**, mounted **before** the auth and rate-limit middleware. They are the only endpoints that do not use the error envelope, and they reveal nothing beyond the one bit each answers.

## GET `/healthz` - is this process alive?

**No input, no token. Output - `200 OK`:**

```json
{ "status": "ok" }
```

No database call, no dependency check, no version, no uptime. If the process can answer at all, the answer is `200`. This is the **container** health check: failing it gets the task **restarted**.

A liveness probe that touches the database converts a two-second dependency blip into every task being killed and restarted into the same blip. This one cannot fail for a reason outside the process, which is the entire point.

## GET `/readyz` - should this task receive traffic right now?

**No input, no token. Output - `200 OK`:**

```json
{ "status": "ready", "checks": { "database": "ok", "signer": "ok" } }
```

**Output - `503 Service Unavailable`:**

```json
{ "status": "not_ready", "checks": { "database": "fail", "signer": "ok" } }
```

Each check has a **1-second** timeout and they run in parallel:

| check | how | fails when |
|---|---|---|
| `database` | `SELECT 1` on a pooled connection | pool exhausted, refused, or timed out |
| `signer` | is the RSA private key unsealed in memory? | the boot-time KMS unseal never completed |

`503`, not `500`: "temporarily unable, try elsewhere" is the instruction to a load balancer, and `500` would claim the request was mishandled.

This is the **ALB target-group** health check: failing it takes the task **out of rotation** without restarting it. Liveness asks whether to restart; readiness asks whether to route. During a database outage the correct answer is "stay alive, stop routing" - `/healthz` stays `200`, `/readyz` goes `503`, and the task survives to serve again the moment the database returns.

No error strings, no exception text, no pool statistics: `"fail"` is the whole vocabulary. This endpoint is an open door, and it says *whether*, never *why*.

Both probes are exempt from rate limiting - a `429` to a load balancer is a self-inflicted outage - and from the authenticated request log.

## Why they are unauthenticated

The load balancer has no token, and neither does the container runtime. An authenticated health check is a contradiction: the prober receives `401`, calls the task unhealthy, and removes or restarts a healthy service.

This is not hypothetical. Phase 1's `/api/health` sat behind `requireAuth` plus an admin check, so it answered `401` to anything without a session - fine when a human clicks it, fatal when a probe calls it. Every task would fail its check, be replaced, and fail again, forever, while every manual test passed. The fix is these two routes, mounted first.

The trade is named and bounded: two paths leak one bit each - "the process is up" and "it can serve". Neither is a secret, both are already obvious to anyone who can open a TCP connection, and neither takes input that could be manipulated.

---

# 7. Email verification

Registration queues one mail. Until the address is verified the account cannot log in, cannot hold a session and appears to the rest of the system to not exist. Two endpoints.

## The action token

32 random bytes from `crypto.randomBytes`, base64url-encoded in the link. The server stores only `sha256(token)` in `auth_tokens` with `purpose = 'email_verify'`. **24 hours**, single use, and issuing a new one invalidates the previous one - otherwise "resend" accumulates working keys.

The link is `https://<frontend>/verify-email?token=<token>`, and the page posts the token back. The token is not sent to this API as a query string in the mail: a URL ends up in browser history, in `Referer` headers, and in any proxy access log on the way. The verify page sets `Referrer-Policy: no-referrer` for the same reason.

## POST `/api/auth/verify-email`

Public. Consumes the token.

**Input**

| where | field | type | rules |
|---|---|---|---|
| body | `token` | string | the value from the link, 43 chars base64url |

**Output - `200 OK`**

```json
{ "status": "verified", "emailVerifiedAt": "2026-11-24T08:20:11Z" }
```

Calling it twice with the same token returns the same `200`: the account is verified, the token is spent, and a user reloading the page after verifying should not be shown an error for having succeeded. Any other reused token is `400`.

**Errors**

| status | code | when |
|---|---|---|
| 400 | `INVALID_TOKEN` | unknown, expired, or issued for a different purpose. One code for all three: distinguishing them tells an attacker whether a guessed token ever existed |

## POST `/api/auth/verify-email/resend`

Public, because the account cannot authenticate yet - this is precisely the endpoint a user needs *before* they have a session. Turnstile required.

**Input**

| where | field | type | rules |
|---|---|---|---|
| body | `email` | string | required |
| body | `turnstileToken` | string | verified first |

**Output - `202 Accepted`**

```json
{ "status": "accepted" }
```

Always. A mail is queued only if the address belongs to an unverified account; an unknown address, an already-verified one, and a fresh registration all produce this same body. If the account exists, the previous token is invalidated first, so the link in the older mail stops working - which is the correct behaviour when someone clicks "resend" because the first mail has not arrived.

**Errors**

| status | code | when |
|---|---|---|
| 403 | `TURNSTILE_FAILED` | challenge rejected or unreachable (fails closed) |
| 429 | `RATE_LIMITED` | 3 per address per hour (`details.scope: "verification_resend"`); counted per submitted address, not per IP, so one attacker cannot lock a victim out of their own resend |

---

# 8. Password reset

Same shape as verification, with two differences: the token is **30 minutes**, not 24 hours, because it can take over an account that already exists; and a successful reset revokes every session, because the reason someone resets a password is usually that someone else has it.

## POST `/api/auth/password-reset/request`

Public; Turnstile required.

**Input**

| where | field | type | rules |
|---|---|---|---|
| body | `email` | string | required |
| body | `turnstileToken` | string | verified first |

**Output - `202 Accepted`**

```json
{ "status": "accepted" }
```

Always, whether or not the address is registered. A mail is queued only for an existing account, verified or not: control of the mailbox is exactly the proof a reset requires, so a reset on an unverified account also sets `emailVerifiedAt` and the user need not verify separately.

**Errors**

| status | code | when |
|---|---|---|
| 403 | `TURNSTILE_FAILED` | as above |
| 429 | `RATE_LIMITED` | 3 per address per hour (`details.scope: "password_reset"`) |

## POST `/api/auth/password-reset/confirm`

Public. Consumes the token, sets the new password.

**Input**

| where | field | type | rules |
|---|---|---|---|
| body | `token` | string | from the link |
| body | `newPassword` | string | 10–72 chars, same rule as registration |

**Output - `200 OK`**

```json
{ "status": "reset" }
```

No token is issued and no session is created: the client logs in with the new password. That keeps one path that mints credentials instead of two.

**Errors**

| status | code | when |
|---|---|---|
| 400 | `INVALID_TOKEN` | unknown, expired, already used, or wrong purpose - one code, as in §7 |
| 422 | `VALIDATION_FAILED` | password fails the rules; `details.fields` names it (the password is never echoed) |

**What a reset changes.** In one transaction: the password hash, `emailVerifiedAt` if it was null, `consumed_at` on the token, and every row in `sessions` for that user revoked - all families, on every device, including the one asking. A "your password was changed" mail is then queued through the same outbox, so the real owner learns about it even if the attacker initiated it. The lockout counter is not cleared: a reset is not proof of good behaviour, and clearing it would hand an attacker a way to wipe their attempts.

---

# Not in this contract

Named explicitly so that their absence is a decision rather than an oversight, and so nobody builds half of one.

**Promoted since v1.2:** email verification and password reset moved out of this table into §7 and §8.

| absent | why |
|---|---|
| SSO / OAuth login | a second identity provider inside a three-service coursework project, for a benefit the brief does not ask for. |
| hard delete of courses or sections | archiving preserves the ids Yehia and Mohab have already stored. A real delete would silently blank their saved timetables. |
| enrollment (who takes what) | that is Yehia's service. This one stores the catalogue, not the choices. |
| `.ics` / calendar export | also Yehia's - the export is of a *timetable*, and a timetable is a selection of sections, not the catalogue. |
| changing an email address | it needs its own verification dance (prove you hold the *old* mailbox, then the new one) and interacts with the login identity of every token already issued. Out of scope. |
| bulk delete / bulk update of courses | the CSV import is the only bulk path, and it is admin-only and audited. |
| an unlock endpoint | an admin who can clear a lockout by hand is an admin who can clear it for an attacker. The lockout expires on its own in 15 minutes. |

If one of these becomes necessary, it goes in as a new section with its own errors, not as a quiet extra route.

---

# Change log

The document is final as of v1.4. Anything after this is a new version with a row here - no silent edits, because Yehia and Mohab are writing clients against it.

| version | date | what changed |
|---|---|---|
| 1.0 | 23 Nov 2026 | first draft: auth, admin, courses, sections, imports, ops |
| 1.1 | 24 Nov 2026 | full audit - room rule moved to an advisory lock, ALB probe corrected to `/readyz`, `dryRun` stopped returning an unlookupable id, logout made cookie-only, `sectionCode` uniqueness scoped to active sections, one shared errors table |
| 1.2 | 24 Nov 2026 | lockout checked **after** the password (closes an enumeration leak), 30-second refresh grace window, import check order fixed, `Secure`-cookie pitfalls, "Not in this contract" table added |
| 1.3 | 24 Nov 2026 | **added §7 email verification and §8 password reset** (23 → 27 endpoints); resend made public; `INVALID_TOKEN` unified; seeded accounts pre-verified |
| **1.4** | **24 Nov 2026** | **FINAL.** Added the "At a glance" section and this log; eight groups marked agreed. No endpoint, field or status code changed from 1.3 |
| 1.5 | 24 Nov 2026 | the refresh grace window now says *a* successor rather than *the same* successor: the server keeps only a hash, so a second child of the same parent is issued. No request, response or status code changes - the client behaviour on the wire is identical |
| 1.6 | 24 Nov 2026 | course codes are stored with **internal spaces removed** (`CS 210` → `CS210`), so a spaced and an unspaced spelling are one course rather than two duplicates. Applies to `POST`/`PATCH /api/courses` and to the `course_code` column of the CSV import. No new status codes: a collision is still `409 DUPLICATE_CODE` |
| 1.8 | 24 Nov 2026 | `GET /api/imports` now documents its one filter error: an unknown `status` answers **`422 VALIDATION_FAILED`** with `details.field: "status"` (it answered 400 before, which the contract never mentioned). No other route, field or status code changes |
| 1.7 | 24 Nov 2026 | the shared error table now lists **`422 VALIDATION_FAILED`** for a body that parses but breaks a rule, alongside the existing `400` for one that cannot be read at all. The implementation already answered 422 (courses, password policy, imports); the contract simply never said so. No route, field or status code changes for any existing client |

**What 1.4 does not change.** No route, field, header or error code. It only rewords the document.
