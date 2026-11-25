# Load tests

Three k6 scripts that measure the deployed task over HTTPS. They answer two
different questions: is the service correct under a little traffic (`smoke.js`),
and how much traffic it can serve before it slows down or starts refusing
(`read.js`, `login.js`).

k6 is not a Node package, so nothing here is installed by `npm install`. On
Windows it comes from `winget install GrafanaLabs.k6` and lands in
`C:\Program Files\k6\k6.exe`.

## Before the first run

The stack has to be up (`../../deploy/deploy.sh`) and the catalogue has to hold
at least one course, because `read.js` picks an existing id instead of creating
one.

The scripts log in as a dedicated account:

| field | value |
| --- | --- |
| email | `loadtest@class-tt.local` |
| password | `LoadTestPass12345` |

It was created through the public API, the same way a person would: `POST
/api/auth/register`, then read the confirmation mail from floci
(`http://127.0.0.1:4566/_aws/ses?email=loadtest@class-tt.local`), then `POST
/api/auth/verify-email`. Both can be overridden with `LOAD_EMAIL` and
`LOAD_PASSWORD`.

Turnstile is satisfied with the placeholder token the test widget produces
(`XXXX.DUMMY.TOKEN.XXXX`), because the deployment verifies against Cloudflare
with the test secret, which accepts any token. A real secret would reject the
load generator, which is the correct behaviour.

## Running

```bash
cd mohamed/loadtest
"/c/Program Files/k6/k6.exe" run smoke.js     # 12 requests, one user
"/c/Program Files/k6/k6.exe" run read.js      # 20 users ramping, about 3 minutes
"/c/Program Files/k6/k6.exe" run login.js     # 5 users logging in, 1 minute
```

`BASE_URL` defaults to `https://localhost:8443`, and `THINK` (seconds between
iterations in `read.js`) defaults to `0.5`. Set `THINK=0` to measure throughput
without the pause:

```bash
THINK=0 "/c/Program Files/k6/k6.exe" run read.js
```

Every run writes `results/<name>-<timestamp>.json` and prints a short block:

```
result   read
requests 3233
rps      19.2
failed   0.00%
checks   100.00%
median   671 ms
p90      1305 ms
p95      1453 ms
max      2242 ms
```

`failed` counts responses outside 200-399 (a 500 is a failure, a 401 in the
smoke test is not: that script declares 401 and 404 as expected). `checks` is
the share of assertions that held, so it catches a 200 with the wrong shape.

## Measuring capacity instead of the limiter

The deployed task carries `RATE_LIMIT_MAX=60`, which is one request per second
per task. That number is a security control, so it is what a normal run should
see: a burst fast enough to exceed it gets mostly `429`s and that is the correct
answer, not a fault.

To measure what the service can do behind the limiter, raise it for the run and
put it back afterwards:

```bash
cd mohamed/infra
export TF_VAR_database_url="postgresql://..."        # from mohamed/.env.neon
export TF_VAR_image="$(terraform output -raw repository_url):deploy"
TF_VAR_rate_limit_max=100000 terraform apply -auto-approve
# ... run the load tests ...
terraform apply -auto-approve                        # back to 60
```

The task definition changes, so ECS replaces the task; wait for `/api/courses`
to answer `401` again before starting the test.

## What the numbers mean

Measured on 25 November 2026, one task at 0.25 vCPU and 0.5 GB, database in
`us-east-1` and the load generator in Cairo:

| script | users | requests | rps | median | p95 | failed |
| --- | --- | --- | --- | --- | --- | --- |
| `smoke.js` | 1 | 36 | 13.2 | 0 ms | 25 ms | 0% |
| `read.js` | 20 | 3,233 | 19.2 | 671 ms | 1,453 ms | 0% |
| `read.js` | 60 | 1,112 | 21.7 | 2,006 ms | 3,941 ms | 6.0% |
| `login.js` | 5 | 117 | 1.9 | 1,522 ms | 2,139 ms | 0% |
| `read.js`, limit at 60 | 10 | 563 | 38.4 offered | 8 ms | 333 ms | 89.5% (429) |

Reading them:

- A single request costs about 180 ms when the database is warm, and most of it
  is the round trip to Neon, not application code. The static landing page is
  25 to 44 ms, which is the cost of the network path with no database in it.
- 20 users is comfortable: the task holds 19 requests per second with no errors.
- 60 users is past the knee. Throughput stops rising at about 22 requests per
  second and the extra users only add latency, until 6% of requests fail with
  `500` and `timeout exceeded when trying to connect` in the logs. That message
  is the Postgres pool: `DB_POOL_MAX` is 5, and a request that cannot get a
  connection within the timeout gives up instead of queueing forever.
- Login is the expensive operation, as designed: Argon2id at the deployed cost
  setting takes about 1.5 s on a quarter of a core, so one task serves roughly
  two logins per second.
- The autoscaling policy is registered and never fired during these runs, so
  every number above is one task. On real AWS, two tasks would roughly double
  the ceiling and the pool timeout would arrive later.

## Files

- `lib.js` holds the base URL, the login helper, the page reader and the summary
  writer. The rest is one scenario per file.
- `results/` holds the machine-readable output of each run. The JSON is ignored
  by git; the directory is kept so the writer always has somewhere to put it.
