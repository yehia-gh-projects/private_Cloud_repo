/**
 * The outbox: mail is queued in the same transaction as the thing it describes,
 * then drained by a loop inside the same process.
 *
 * Why not send inline? Because the request that creates a user would then depend
 * on SES being reachable, and a slow mail API would make registration slow or
 * fail after the row was already committed. The queue decouples "this happened"
 * from "tell someone", which is the whole reason transactional outboxes exist.
 *
 * Why not a real queue (SQS)? One process, one database, one consumer: a table
 * drained by a claim that takes a lease gives the same guarantee and one fewer
 * moving part to explain. With several tasks running, the lease is what stops
 * two of them sending the same mail; see `claim` below.
 */

const MAX_ATTEMPTS = 5;

export function createOutbox({ query }) {
  if (typeof query !== 'function') throw new Error('createOutbox needs query from db.js.');

  /**
   * Queue a mail. `payload` holds template *values* only - never a rendered body
   * and never a token (see auth/action-tokens.js for why).
   */
  async function enqueue({ toEmail, templateKey, payload = {} }, client = null) {
    const run = client ? (text, values) => client.query(text, values) : query;
    const { rows } = await run(
      `insert into email_outbox (to_email, template_key, payload)
       values ($1, $2, $3)
       returning id`,
      [toEmail, templateKey, JSON.stringify(payload)],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Take up to `limit` due mails for this worker.
   *
   * The claim moves `next_attempt_at` forward by a lease, and that is what makes
   * two tasks safe. `for update skip locked` alone only protects rows locked at
   * the instant of the query; once the first worker commits its claim the row is
   * unlocked again and a second task would send the same mail. The lease keeps
   * the row invisible to everyone else for as long as a send can take. If the
   * sender dies mid-send, the lease expires and the row comes back.
   *
   * `toEmailLike` exists for the test suite, which runs several files in parallel
   * against one database: each file drains only its own addresses, so a worker in
   * one file cannot swallow another's mail. Production passes nothing.
   */
  async function claim(limit = 10, { toEmailLike = null, leaseSeconds = 60 } = {}) {
    const { rows } = await query(
      `update email_outbox
          set attempts = attempts + 1,
              next_attempt_at = now() + make_interval(secs => $3)
        where id in (
          select id from email_outbox
           where sent_at is null and failed_at is null and next_attempt_at <= now()
             and ($2::text is null or to_email like $2)
           order by next_attempt_at
           limit $1
           for update skip locked
        )
        returning id, to_email, template_key, payload, attempts`,
      [limit, toEmailLike, leaseSeconds],
    );

    return rows.map((row) => ({
      id: row.id,
      toEmail: row.to_email,
      templateKey: row.template_key,
      payload: row.payload ?? {},
      attempts: row.attempts,
    }));
  }

  async function markSent(id) {
    await query('update email_outbox set sent_at = now() where id = $1', [id]);
  }

  /**
   * Give up after MAX_ATTEMPTS, otherwise come back later. The delay grows with
   * the attempt count so a broken SES endpoint is not hammered every two seconds.
   */
  async function markFailed(id, error) {
    const message = String(error?.message ?? error ?? 'unknown error').slice(0, 500);

    await query(
      `update email_outbox
          set failed_at = case when attempts >= $2 then now() else null end,
              last_error = $3,
              next_attempt_at = now() + make_interval(secs => least(attempts * 30, 600))
        where id = $1`,
      [id, MAX_ATTEMPTS, message],
    );
  }

  /**
   * How many mails of this kind were *asked for* since `sinceMs`.
   *
   * The count belongs here, not in `auth_tokens`: a token is minted when the mail
   * is sent, so counting tokens would count deliveries and let a user request a
   * hundred mails while the worker was busy. The request is the thing being
   * limited.
   */
  async function countSince({ toEmail, templateKey, sinceMs }) {
    const { rows } = await query(
      `select count(*)::int as count
         from email_outbox
        where to_email = $1 and template_key = $2 and created_at >= $3`,
      [toEmail, templateKey, new Date(sinceMs)],
    );
    return rows[0]?.count ?? 0;
  }

  /** Counts for tests and the health story: how much mail is waiting. */
  async function stats() {
    const { rows } = await query(
      `select count(*) filter (where sent_at is null and failed_at is null)::int as pending,
              count(*) filter (where sent_at is not null)::int as sent,
              count(*) filter (where failed_at is not null)::int as failed
         from email_outbox`,
    );
    return rows[0] ?? { pending: 0, sent: 0, failed: 0 };
  }

  return { enqueue, claim, markSent, markFailed, countSince, stats, MAX_ATTEMPTS };
}
