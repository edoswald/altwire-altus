/**
 * scripts/oauth-clients.js
 *
 * List or remove dynamically registered OAuth clients (and their tokens).
 *
 * Usage:
 *   node scripts/oauth-clients.js                       # list clients with token counts
 *   node scripts/oauth-clients.js --delete "Altus smoke test" "Altus docs check"
 *                                                       # delete clients by exact name, with their codes and tokens
 *
 * Required env: ALTWIRE_DATABASE_URL (or DATABASE_URL)
 */

import pool from '../lib/altus-db.js';

if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
  console.error('oauth-clients: ALTWIRE_DATABASE_URL not set.');
  process.exit(1);
}

const args = process.argv.slice(2);
const deleteIdx = args.indexOf('--delete');

async function list() {
  const { rows } = await pool.query(`
    SELECT c.client_id, c.client_name, c.created_at,
           (SELECT COUNT(*) FROM oauth_access_tokens a WHERE a.client_id = c.client_id AND a.expires_at > NOW())::int AS live_access_tokens,
           (SELECT COUNT(*) FROM oauth_refresh_tokens r WHERE r.client_id = c.client_id)::int AS refresh_tokens
      FROM oauth_clients c
     ORDER BY c.created_at`);
  console.table(rows.map((r) => ({ ...r, created_at: r.created_at.toISOString().slice(0, 16) })));
}

async function remove(names) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT client_id, client_name FROM oauth_clients WHERE client_name = ANY($1)', [names]);
    const missing = names.filter((n) => !rows.some((r) => r.client_name === n));
    const ids = rows.map((r) => r.client_id);
    if (ids.length) {
      for (const table of ['oauth_auth_codes', 'oauth_access_tokens', 'oauth_refresh_tokens', 'oauth_clients']) {
        await client.query(`DELETE FROM ${table} WHERE client_id = ANY($1)`, [ids]);
      }
    }
    await client.query('COMMIT');
    console.log(`Deleted ${ids.length} client(s): ${rows.map((r) => r.client_name).join(', ') || 'none'}`);
    if (missing.length) console.log(`Not found: ${missing.join(', ')}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

(deleteIdx === -1 ? list() : remove(args.slice(deleteIdx + 1)))
  .then(() => pool.end())
  .catch((err) => {
    console.error('oauth-clients: failed', err.message);
    pool.end().finally(() => process.exit(1));
  });
