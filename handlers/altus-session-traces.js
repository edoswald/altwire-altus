import pool from '../lib/altus-db.js';

export async function querySessionTraces({ session_id, limit = 50 } = {}) {
  if (!process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }

  if (session_id !== undefined && session_id !== null) {
    const { rows } = await pool.query(
      `SELECT * FROM altus_events WHERE session_id = $1 ORDER BY created_at ASC`,
      [session_id],
    );

    if (rows.length === 0) {
      return { success: false, exit_reason: 'not_found' };
    }

    return { success: true, events: rows, count: rows.length };
  }

  const resolvedLimit = Math.min(Math.max(limit, 1), 100);
  const { rows } = await pool.query(
    `SELECT session_id, COUNT(*)::int AS event_count, MAX(created_at) AS last_seen
       FROM altus_events
      WHERE session_id IS NOT NULL
      GROUP BY session_id
      ORDER BY last_seen DESC
      LIMIT $1`,
    [resolvedLimit],
  );

  return { success: true, traces: rows, count: rows.length };
}
