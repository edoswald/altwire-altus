/**
 * PostgreSQL connection pool and schema helpers for Altus.
 * Uses the shared Railway PostgreSQL instance with altus_ prefixed tables.
 */

import pg from 'pg';
import { logger } from '../logger.js';

const { Pool } = pg;

export const dbUrl = process.env.ALTWIRE_DATABASE_URL || process.env.DATABASE_URL;
export const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error', { error: err.message });
});

export default pool;

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
        embedding       vector(512),
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

    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_article_performance (
        id               SERIAL PRIMARY KEY,
        article_url      TEXT NOT NULL,
        wp_post_id       INTEGER,
        published_at     TIMESTAMPTZ,
        snapshot_type    TEXT NOT NULL,
        snapshot_taken_at TIMESTAMPTZ DEFAULT NOW(),
        clicks           INTEGER DEFAULT 0,
        impressions      INTEGER DEFAULT 0,
        ctr              NUMERIC(5,4) DEFAULT 0,
        avg_position     NUMERIC(6,2),
        top_queries      JSONB DEFAULT '[]',
        source_query     TEXT,
        UNIQUE(article_url, snapshot_type)
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS altus_article_perf_published_idx
        ON altus_article_performance (published_at);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_article_assignments (
        id            SERIAL PRIMARY KEY,
        article_url   TEXT UNIQUE,
        wp_post_id    INTEGER,
        assigned_at   TIMESTAMPTZ DEFAULT NOW(),
        status        TEXT DEFAULT 'draft',
        source_query  TEXT
      );
    `);

    await client.query(`
      ALTER TABLE altus_article_assignments ADD COLUMN IF NOT EXISTS source_query TEXT;
    `);

    // Safe unique index addition for existing tables without the constraint
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS altus_article_assignments_url_idx
        ON altus_article_assignments (article_url);
    `);

    // agent_memory table — shared key/value store for Hal agent identity,
    // soul blocks, onboarding state, editorial context, etc.
    // This is the same schema as nimbus's agent_memory table.
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id          SERIAL PRIMARY KEY,
        agent       TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT,
        access_count INTEGER DEFAULT 0,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_agent_key_idx
        ON agent_memory (agent, key);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS agent_memory_updated_idx
        ON agent_memory (updated_at DESC);
    `);

    logger.info('Altus schema initialized');
  } finally {
    client.release();
  }
}

/**
 * Read a single agent_memory entry.
 *
 * @param {string} agent - 'hal', 'ben', 'altus', etc.
 * @param {string} key
 * @returns {Promise<{success: boolean, agent: string, key: string, value: string, updated_at: string}|{success: false, exit_reason: string}>}
 */
export async function readAgentMemory(agent, key) {
  const { rows } = await pool.query(
    `SELECT agent, key, value, updated_at FROM agent_memory WHERE agent = $1 AND key = $2`,
    [agent.toLowerCase(), key]
  );
  if (rows.length === 0) {
    return { success: false, exit_reason: 'not_found', message: `No memory entry for agent="${agent}" key="${key}"` };
  }
  return { success: true, ...rows[0] };
}

/**
 * Write (upsert) a memory entry for an agent.
 *
 * @param {string} agent - 'hal', 'ben', 'altus', etc.
 * @param {string} key
 * @param {string} value
 * @returns {Promise<{success: boolean, agent: string, key: string}>}
 */
export async function writeAgentMemory(agent, key, value) {
  await pool.query(
    `INSERT INTO agent_memory (agent, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent, key) DO UPDATE
       SET value      = EXCLUDED.value,
           updated_at = NOW()`,
    [agent.toLowerCase(), key, value]
  );
  logger.info('Agent memory written', { agent, key });
  return { success: true, agent, key };
}

/**
 * Upsert a single content record. Returns the row id.
 * @param {object} doc
 * @returns {Promise<number>} row id
 */
export async function upsertContent(doc) {
  if (!doc.embedding || !Array.isArray(doc.embedding)) {
    throw new Error(`upsertContent: doc.embedding is required (wp_id=${doc.wp_id})`);
  }
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
       published_at = EXCLUDED.published_at,
       author       = EXCLUDED.author,
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