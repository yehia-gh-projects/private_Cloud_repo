// The claim, against a real Postgres. What is under test is the SQL: a row taken
// by one worker must be invisible to the next one until the lease runs out. A
// fake pool would only prove that the fake returns what it was told to.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

import pg from 'pg';

import { createOutbox } from '../src/models/outbox.model.js';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = DATABASE_URL ? false : 'needs DATABASE_URL (local stack on :5433)';

// One prefix per run, so a parallel suite cannot see these rows.
const TAG = `outbox-test-${process.pid}`;
const LIKE = `${TAG}%`;

let pool;
let outbox;

before(async () => {
  if (!DATABASE_URL) return;

  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  outbox = createOutbox({ query: (text, params) => pool.query(text, params) });
});

after(async () => {
  if (!pool) return;
  await pool.query('delete from email_outbox where to_email like $1', [LIKE]);
  await pool.end();
});

async function enqueueOne() {
  const id = await outbox.enqueue({
    toEmail: `${TAG}-${Math.random().toString(16).slice(2)}@class-tt.local`,
    templateKey: 'verify_email',
    payload: { token: 'x'.repeat(8) },
  });
  return id;
}

test('a claimed row is not offered to a second worker', { skip }, async () => {
  await enqueueOne();

  const first = await outbox.claim(10, { toEmailLike: LIKE });
  assert.equal(first.length, 1);
  assert.equal(first[0].attempts, 1);

  // The same tick of a second task: the lease hides the row, so it takes nothing.
  const second = await outbox.claim(10, { toEmailLike: LIKE });
  assert.deepEqual(second, []);
});

test('the lease expires and the row comes back with the next attempt counted', { skip }, async () => {
  const id = await enqueueOne();

  const first = await outbox.claim(10, { toEmailLike: LIKE, leaseSeconds: 1 });
  assert.equal(first[0].id, id);

  // Pretend the sender died: the lease is a clock, not a flag.
  await pool.query('update email_outbox set next_attempt_at = now() - interval \'1 second\' where id = $1', [id]);

  const again = await outbox.claim(10, { toEmailLike: LIKE });
  assert.equal(again.length, 1);
  assert.equal(again[0].id, id);
  assert.equal(again[0].attempts, 2);
});

test('a sent row is never claimed again', { skip }, async () => {
  const id = await enqueueOne();

  await outbox.claim(10, { toEmailLike: LIKE });
  await outbox.markSent(id);
  await pool.query('update email_outbox set next_attempt_at = now() - interval \'1 second\' where id = $1', [id]);

  assert.deepEqual(await outbox.claim(10, { toEmailLike: LIKE }), []);
});

test('a failed send backs off instead of retrying immediately', { skip }, async () => {
  const id = await enqueueOne();

  await outbox.claim(10, { toEmailLike: LIKE });
  await outbox.markFailed(id, new Error('offline'));

  // next_attempt_at is now 30 seconds out, so the next tick takes nothing.
  assert.deepEqual(await outbox.claim(10, { toEmailLike: LIKE }), []);

  const { rows } = await pool.query(
    'select attempts, last_error, failed_at from email_outbox where id = $1',
    [id],
  );
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].last_error, 'offline');
  assert.equal(rows[0].failed_at, null);
});
