# Timetable Service - Yehia Mohamed (248678)

## 1. Status today
* **Deployed:** Yes — deployed to the local Floci AWS emulator (`:4566`) as two Lambda functions + API Gateway HTTP API v2.0 + DynamoDB + SQS + EventBridge + S3 static frontend, and also runnable as a standalone Express server (`:3002`) or non-root Docker container (`class-tt/timetable:dev`).
* **Test URLs:**
  * Floci API Gateway: `http://56740348ff.execute-api.localhost.floci.io:4566`
  * Floci S3 Static Frontend: `http://localhost:4566/timetable-frontend/index.html`
  * Local Express (`npm start`): `http://localhost:3002` (local frontend via `npx http-server frontend -p 8080 -c-1`)
* **Redeploy commands (from `yehia/`):**
  ```bash
  node scripts/setup-aws.js
  bash infra/deploy-floci.sh
  export API_URL="http://<printed-id>.execute-api.localhost.floci.io:4566"
  bash infra/deploy-frontend-floci.sh
  ```

## 2. AWS services used
* **Amazon API Gateway (HTTP API v2.0):** Exposes `/api/health` and `/api/timetables/*` and routes requests to Lambda, avoiding managing a reverse proxy or manual TLS/routing server.
* **AWS Lambda (`nodejs24.x`):** Runs both the stateless Express API (`src/lambda.js` via `serverless-http`) and the asynchronous SQS consumer (`src/consumer.js`) on demand, avoiding paying for an idle EC2 instance during spiky registration-week traffic.
* **Amazon DynamoDB:** Stores user-owned saved timetables (`timetables`) and the reverse lookup index (`section_timetables`) with single-digit-millisecond key lookups, avoiding cross-service coupling to Service 1's PostgreSQL database.
* **Amazon EventBridge:** Routes `catalogue-section-changed` events from Service 1 to the Timetable Service queue, decoupling catalogue edits from timetable invalidation.
* **Amazon SQS:** Buffers section-change events in `timetable-section-events` and triggers `timetable-section-consumer` with built-in retry semantics, preventing lost invalidations during bursts.
* **Amazon S3:** Hosts the CSP-safe vanilla HTML/CSS/JS frontend (`timetable-frontend`) with explicit MIME types, avoiding running a dedicated web server for static assets.
* **AWS IAM:** Enforces least-privilege execution permissions (`infra/iam/timetable-policy.json`) so the Lambdas can only access their own DynamoDB tables, SQS queue, and CloudWatch log group.
* **Amazon CloudWatch Logs:** Collects structured JSON security and application logs under `/timetable-service/app`, preserving audit trails after ephemeral Lambda containers terminate.

## 3. Functions delivered
1. **Clash Detection:** Checks a set of section IDs against wall-clock meeting times (`src/domain/clash.js`) and returns all overlapping pairs — proven by `POST /api/timetables/check`.
2. **Conflict-Free Timetable Generation:** Fetches paginated active sections per `courseId` in parallel (`src/clients/sectionsClient.js`) and runs a backtracking search (`src/domain/generator.js`) to return valid clash-free timetables, or `422` with `conflictingCourseIds` and `conflictingPairs` — proven by `POST /api/timetables/generate`.
3. **Saved Timetable CRUD & Ownership Isolation:** Saves, lists, hydrates, and deletes user timetables in DynamoDB (`src/db/timetablesRepo.js`), enforcing owner-only access via JWT `sub` — proven by `POST /api/timetables`, `GET /api/timetables`, `GET /api/timetables/{id}`, and `DELETE /api/timetables/{id}`.
4. **Asynchronous Stale-Schedule Tracking:** Consumes `catalogue-section-changed` events via EventBridge → SQS → `src/consumer.js`, queries `section_timetables`, and flags affected saved timetables `stale: true` without a full-table scan — proven by security test `S12` and `aws events put-events`.
5. **RFC 5545 iCalendar Export:** Generates a downloadable `.ics` file with `Africa/Cairo` timezone rules (`src/domain/ics.js`) — proven by `GET /api/timetables/{id}/calendar.ics`.

## 4. Endpoints
| Method | Path | Auth | Role | Success | Errors |
|---|---|---|---|---|---|
| `GET` | `/api/health` | Bearer JWT (RS256) | Admin only | `200` | `401, 403, 429` |
| `POST` | `/api/timetables/check` | Bearer JWT (RS256) | Student, Admin | `200` | `400, 401, 404, 413, 415, 429` |
| `POST` | `/api/timetables/generate` | Bearer JWT (RS256) | Student, Admin | `200` | `400, 401, 404, 413, 415, 422, 429` |
| `POST` | `/api/timetables` | Bearer JWT (RS256) | Student, Admin | `201` | `400, 401, 404, 413, 415, 422, 429` |
| `GET` | `/api/timetables` | Bearer JWT (RS256) | Student, Admin (own) | `200` | `401, 429` |
| `GET` | `/api/timetables/{id}` | Bearer JWT (RS256) | Owner only | `200` | `401, 404, 429` |
| `GET` | `/api/timetables/{id}/calendar.ics` | Bearer JWT (RS256) | Owner only | `200` | `401, 404, 429` |
| `DELETE` | `/api/timetables/{id}` | Bearer JWT (RS256) | Owner only | `204` | `401, 404, 429` |

## 5. Data model
Provisioned by `scripts/setup-aws.js` in DynamoDB (`us-east-1`, Floci `:4566`):
* **`timetables`:**
  * Partition key: `userId` (`S`)
  * Sort key: `timetableId` (`S`)
  * Indexes: None required (all user reads/writes are scoped directly by `userId`).
* **`section_timetables` (reverse lookup index table):**
  * Partition key: `sectionId` (`S`)
  * Sort key: `userTimetableKey` (`S`, composite `<userId>#<timetableId>`)
  * Purpose: Allows `src/consumer.js` to query only timetables referencing a modified `sectionId` and mark them `stale: true` without scanning `timetables`.
* **Example row (`timetables`):**
  ```json
  {
    "userId": "student-1",
    "timetableId": "tt-8f3a9c12",
    "name": "Fall Plan A",
    "sectionIds": ["101", "201", "301"],
    "stale": false,
    "createdAt": "2026-11-24T18:00:00.000Z",
    "updatedAt": "2026-11-24T18:00:00.000Z"
  }
  ```

## 6. Roles and ownership
* **Authentication & Role check:**
  * File & functions: `src/middleware/auth.js` — `requireAuth(req, res, next)` verifies the RS256 Bearer JWT, checks allowed roles (`JWT_ALLOWED_ROLES`, default `student,admin`), and populates `req.user = { id: payload.sub, role: normalizedRole }`; `requireAdmin(req, res, next)` enforces `req.user.role === "admin"` on `GET /api/health` (returning `403 FORBIDDEN` for non-admin callers).
* **Ownership check (IDOR prevention):**
  * File & functions: `src/controllers/timetables.js` (`getTimetableById`, `downloadIcs`, `deleteTimetable`) always passes `req.user.id` (from JWT `sub`) into `src/db/timetablesRepo.js` (`getTimetable(userId, timetableId)` / `deleteTimetable`). Because `userId` is the DynamoDB partition key, another user's timetable cannot be read, exported, or deleted and returns `404 TIMETABLE_NOT_FOUND` (preventing ID enumeration; verified by test `S10`). `GET /api/timetables/{id}` also returns `ownerId` in the response payload.

## 7. External integration
* **JWT Verification (Service 1 — Catalogue & Accounts):**
  * **JWKS URL:** `CATALOGUE_JWKS_URL` or `CATALOGUE_PUBLIC_KEY_URL`, defaulting to `${CATALOGUE_URL}/.well-known/jwks.json`. In `DEP_MODE=mock`, falls back to local `local-public.pem`.
  * **`kid` handling:** `src/middleware/auth.js` (`getPublicKey(kid)`) decodes the JWT header for `kid`, caches JWKS keys in a `Map` with a refresh cooldown (`JWKS_REFRESH_COOLDOWN_MS`, default `30000` ms), converts matching RSA JWKs via Node's native `crypto.createPublicKey({ key: jwk, format: "jwk" })`, and verifies with `{ algorithms: ["RS256"] }` only.
  * **`iss` and `aud`:** Supports `JWT_ISSUER`, `JWT_AUDIENCE`, and `JWT_CLOCK_TOLERANCE_SECONDS` (default `60`), defaulting both `issuer` and `audience` to `"class-tt"` when `DEP_MODE=live`.
* **Live Catalogue Data Consumption:**
  * `src/clients/sectionsClient.js` queries `GET /api/sections?courseId=<id>&limit=100` (paginating via cursor or page up to 20 pages) in parallel (`Promise.all`) for generation and filters out archived sections (`archivedAt`, `archived`, `isArchived`, or `status === "ARCHIVED"`). For lookup by IDs (`getSectionsByIds`), it calls `GET /api/sections?ids=<csv>` **without** `page` or `limit` parameters, reading `data.items` (with fallback to `data.sections`) and forwarding the caller's `Authorization` header.

## 8. IAM
Defined in `infra/iam/timetable-policy.json` (assumed by Lambda via `infra/iam/trust-policy.json`):
* **DynamoDB:** `dynamodb:PutItem`, `GetItem`, `Query`, `UpdateItem`, `DeleteItem` on `arn:aws:dynamodb:us-east-1:000000000000:table/timetables` and `arn:aws:dynamodb:us-east-1:000000000000:table/section_timetables`.
* **SQS:** `sqs:ReceiveMessage`, `DeleteMessage`, `GetQueueAttributes` on `arn:aws:sqs:us-east-1:000000000000:timetable-section-events`.
* **CloudWatch Logs:** `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` on `/aws/lambda/timetable-api:*`, `/aws/lambda/timetable-section-consumer:*`, and `/timetable-service/app:*` (the log-stream wildcards required because Lambda dynamically creates streams inside each log group).

## 9. Logging and monitoring
* **Log format:** Structured single-line JSON emitted by `src/middleware/logger.js` (`logEvent`), recording `timestamp`, `level`, `event`, `path`, `statusCode`, and `userId`/`reason` — never logging Authorization headers, JWTs, or request bodies.
* **Destination:** CloudWatch Logs group `/timetable-service/app` (provisioned by `scripts/setup-aws.js`).
* **Retention & Alarms:** Configured for 14-day retention in production AWS; security events (`AUTH_MISSING_TOKEN`, `AUTH_INVALID_TOKEN`, `AUTH_FORBIDDEN`, `AUTH_ROLE_NOT_ALLOWED`) are structured for CloudWatch Logs Insights queries and metric filters.
* **Sample log line observed:**
  ```json
  {"timestamp":"2026-11-24T18:12:04.312Z","level":"warn","event":"AUTH_FORBIDDEN","path":"/api/health","statusCode":403,"userId":"student-1"}
  ```

## 10. Tests
* **Count & files:** **24 passing tests** (`24` pass, `0` fail) across unit and security test suites in `tests/` (including `tests/unit/domain.test.js` and `tests/security/security.test.js` covering clash detection, pagination & archived-section filtering, backtracking generation, `.ics` export, `class-tt` issuer/audience/role validation, IDOR protection, rate limiting, and SQS stale consumer). Auto-generates ephemeral RS256 keys on fresh clones when `.pem` files are absent.
* **How to run:**
  ```bash
  cd yehia && npm test
  ```
* **Verbatim runner output (last lines):**
  ```text
  ℹ tests 24
  ℹ suites 0
  ℹ pass 24
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 1229.7325
  ```

## 11. Cost on real AWS
Assuming **500 active students** and **50,000 API requests/month** (Lambda: 256 MB RAM, 150 ms avg; DynamoDB on-demand: 40,000 reads, 10,000 writes, < 0.5 GB storage; SQS/EventBridge: < 5,000 events/month; S3 + CloudWatch Logs: < 0.5 GB):
* **AWS Lambda:** 50,000 requests and 1,875 GB-s compute (Always-Free Tier: 1M requests, 400,000 GB-s → **$0.00**).
* **Amazon DynamoDB (On-Demand):** < 0.5 GB storage (Always-Free Tier: 25 GB → **$0.00**); requests: $40{,}000 \times \frac{\$0.125}{10^6} + 10{,}000 \times \frac{\$0.625}{10^6} \approx$ **$0.011/month**.
* **Amazon API Gateway (HTTP API):** 50,000 requests (12-month Free Tier: 1M/month → **$0.00**; post-Free Tier: $50{,}000 \times \frac{\$1.00}{10^6} =$ **$0.05/month**).
* **SQS, EventBridge, S3 & CloudWatch Logs:** Well within Always-Free Tier (1M SQS requests, 5 GB CloudWatch ingestion) → **$0.00**.
* **Total Estimated Monthly Cost:** **$0.00/month** during the 12-month AWS Free Tier, and **~$0.06/month** afterward.

## 12. Recovery and limitations
* **What breaks, what you do, and what is lost:**
  * **Floci / DynamoDB container loss:** Saved timetables in `timetables` and `section_timetables` are lost unless persisted in a Docker volume (on real AWS, enable DynamoDB Point-in-Time Recovery for near-zero RPO). Recovery on Floci: run `node scripts/setup-aws.js`, `bash infra/deploy-floci.sh`, and `bash infra/deploy-frontend-floci.sh`.
  * **Service 1 (Catalogue) outage:** `check`, `generate`, and live hydration fail with an upstream error (`502`/`503`) because catalogue data is not duplicated locally. Recovery is automatic once Service 1 returns.
  * **Archived or edited section in Service 1:** EventBridge → SQS → `src/consumer.js` flags affected saved timetables `stale: true`, and `GET /api/timetables/{id}` surfaces `missingSectionIds` so students are never shown silently broken schedules.
* **Deliberately not built:**
  * **No direct access to Service 1's PostgreSQL database** (enforces database-per-service isolation).
  * **No real course enrollment, seat-capacity locking, or waitlists** (out of scope for a timetable planner).
  * **No WebSocket push notifications** (stale state is surfaced asynchronously via SQS + next read).
