/**
 * scripts/reembed.js
 *
 * Re-embeds archive rows whose vectors came from a different embedding model
 * (altus_content.embedding_model differs from the current Voyage model, or is
 * empty for rows embedded before the column existed). Works from the text
 * already stored in the database: no WordPress fetch and no gallery
 * re-synthesis, so the only cost is Voyage embedding.
 *
 * Resumable: each page is written as soon as it is embedded, so re-running
 * picks up where it stopped (for --all, pass the last id it printed as
 * --after-id).
 *
 * Usage:
 *   node scripts/reembed.js --dry-run      # count stale rows and estimate tokens
 *   node scripts/reembed.js                # re-embed stale rows
 *   node scripts/reembed.js --all          # re-embed every row (e.g. after changing embed text)
 *   node scripts/reembed.js --all --after-id 5000   # resume an --all run
 *   node scripts/reembed.js --limit 200    # at most 200 rows this run
 *
 * Required env vars: ALTWIRE_DATABASE_URL (or DATABASE_URL), VOYAGE_API_KEY
 */

import pool from '../lib/altus-db.js';
import { embedDocuments, embeddingModelId } from '../lib/voyage.js';
import { buildGalleryEmbedText, buildPostEmbedText } from '../lib/ingest-pipeline.js';

const PAGE_SIZE = 100;
const CHARS_PER_TOKEN = 4;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const all = args.includes('--all');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? Number(args[limitIdx + 1]) || null : null;
const afterIdIdx = args.indexOf('--after-id');
const startAfterId = afterIdIdx !== -1 ? Number(args[afterIdIdx + 1]) || 0 : 0;

if (!process.env.ALTWIRE_DATABASE_URL && !process.env.DATABASE_URL) {
  console.error('reembed: ALTWIRE_DATABASE_URL not set.');
  process.exit(1);
}
if (!dryRun && !process.env.VOYAGE_API_KEY) {
  console.error('reembed: VOYAGE_API_KEY not set.');
  process.exit(1);
}

function embedTextForRow(row) {
  return row.content_type === 'gallery'
    ? buildGalleryEmbedText({ title: row.title, tags: row.tags }, row.raw_text ?? '')
    : buildPostEmbedText(row);
}

async function main() {
  const model = embeddingModelId();
  // Rows walk in id order with a cursor, so --all (which matches rows already
  // on the current model) still finishes and can resume with --after-id.
  const staleWhere = all ? 'TRUE' : '(embedding_model IS DISTINCT FROM $1 OR embedding IS NULL)';
  const staleParams = all ? [] : [model];

  const { rows: [summary] } = await pool.query(
    `SELECT COUNT(*)::int AS rows,
            COALESCE(SUM(LEAST(length(coalesce(raw_text, '')) + length(title) + 200, 12500)), 0)::bigint AS chars
       FROM altus_content WHERE ${staleWhere}`,
    staleParams,
  );
  const { rows: byModel } = await pool.query(
    `SELECT coalesce(embedding_model, '(unknown, pre-tracking)') AS model, content_type, COUNT(*)::int AS rows
       FROM altus_content GROUP BY 1, 2 ORDER BY 1, 2`,
  );

  console.log(`Current embedding model: ${model}`);
  console.table(byModel);
  const tokens = Math.round(Number(summary.chars) / CHARS_PER_TOKEN);
  console.log(`Rows to re-embed: ${summary.rows}${limit ? ` (this run: up to ${limit})` : ''}, about ${tokens.toLocaleString()} tokens`);
  if (dryRun || !summary.rows) return;

  let done = 0;
  let failed = 0;
  let lastId = startAfterId;
  while (!limit || done < limit) {
    const pageSize = limit ? Math.min(PAGE_SIZE, limit - done) : PAGE_SIZE;
    const { rows } = await pool.query(
      `SELECT id, content_type, title, categories, tags, raw_text
         FROM altus_content
        WHERE ${staleWhere} AND id > $${staleParams.length + 1}
        ORDER BY id
        LIMIT ${pageSize}`,
      [...staleParams, lastId],
    );
    if (!rows.length) break;

    const vectors = await embedDocuments(rows.map(embedTextForRow));
    if (vectors?.error) {
      console.error(`Embedding failed: ${vectors.error}. Re-run to resume.`);
      failed += rows.length;
      break;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [i, row] of rows.entries()) {
        await client.query(
          'UPDATE altus_content SET embedding = $1::vector, embedding_model = $2 WHERE id = $3',
          [`[${vectors[i].join(',')}]`, model, row.id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    done += rows.length;
    lastId = rows[rows.length - 1].id;
    console.log(`Re-embedded ${done}/${limit ? Math.min(limit, summary.rows) : summary.rows} (last id ${lastId})`);
  }

  console.log(`Done. Re-embedded ${done} rows${failed ? `, ${failed} failed` : ''}.`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('reembed: fatal error', err);
    pool.end().finally(() => process.exit(1));
  });
