/**
 * PostgreSQL connection pool and schema helpers for Altus.
 * Uses the shared Railway PostgreSQL instance with altus_ prefixed tables.
 */

import pg from 'pg';
import { logger } from '../logger.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error', { error: err.message });
});

/**
 * Run on startup. Creates altus tables and indexes if they don't exist.
 * Safe to run on every deploy (all DDL uses IF NOT EXISTS).
 */
export async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');

    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_content (
        id              SERIAL PRIMARY KEY,
        wp_id           INTEGER NOT NULL,
        content_type    TEXT NOT NULL,
        title           TEXT NOT NULL,
        slug            TEXT,
        url             TEXT,
        published_at    TIMESTAMPTZ,
        author          TEXT,
        categories      TEXT[],
        tags            TEXT[],
        raw_text        TEXT,
        embedding       vector(1024),
        ingested_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(wp_id, content_type)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS altus_content_embedding_idx
        ON altus_content
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 50);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS altus_content_type_idx
        ON altus_content (content_type);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_ingest_log (
        id                 SERIAL PRIMARY KEY,
        run_at             TIMESTAMPTZ DEFAULT NOW(),
        mode               TEXT,
        posts_ingested     INTEGER DEFAULT 0,
        galleries_ingested INTEGER DEFAULT 0,
        errors             INTEGER DEFAULT 0,
        duration_ms        INTEGER,
        notes              TEXT
      );
    `);

    logger.info('Altus schema initialized');
  } finally {
    client.release();
  }
}

/**
 * Upsert a single content record. Returns the row id.
 * @param {object} doc
 * @returns {Promise<number>} row id
 */
export async function upsertContent(doc) {
  const embeddingStr = `[${doc.embedding.join(',')}]`;
  const result = await pool.query(
    `INSERT INTO altus_content
       (wp_id, content_type, title, slug, url, published_at, author,
        categories, tags, raw_text, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::vector)
     ON CONFLICT (wp_id, content_type)
     DO UPDATE SET
       title        = EXCLUDED.title,
       slug         = EXCLUDED.slug,
       url          = EXCLUDED.url,
       raw_text     = EXCLUDED.raw_text,
       embedding    = EXCLUDED.embedding,
       ingested_at  = NOW()
     RETURNING id`,
    [
      doc.wp_id,
      doc.content_type,
      doc.title,
      doc.slug ?? null,
      doc.url ?? null,
      doc.published_at ?? null,
      doc.author ?? null,
      doc.categories ?? [],
      doc.tags ?? [],
      doc.raw_text ?? '',
      embeddingStr,
    ]
  );
  return result.rows[0].id;
}

/**
 * Write an ingest run log entry.
 */
export async function logIngestRun({ mode, postsIngested, galleriesIngested, errors, durationMs, notes }) {
  await pool.query(
    `INSERT INTO altus_ingest_log (mode, posts_ingested, galleries_ingested, errors, duration_ms, notes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [mode, postsIngested, galleriesIngested, errors, durationMs, notes ?? null]
  );
}

export default pool;
