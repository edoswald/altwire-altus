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
  logger.error('PostgreSQL pool error', { error: err.message, code: err.code, stack: err.stack });
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

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS altus_article_assignments_url_idx
        ON altus_article_assignments (article_url);
    `);

    // agent_memory table — shared key/value store for Hal agent identity,
    // soul blocks, onboarding state, editorial context, etc.
    // This is the same schema as nimbus's agent_memory table.
    // Soft-delete is implemented via deleted_at column.
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id          SERIAL PRIMARY KEY,
        agent       TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT,
        access_count INTEGER DEFAULT 0,
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        deleted_at  TIMESTAMPTZ
      );
    `);

    // Add deleted_at column to existing rows (must precede the partial index below)
    // IF NOT EXISTS only avoids error when column already exists — handles both
    // new tables and pre-existing tables created before this column was added.
    try {
      await client.query(`
        ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
      `);
    } catch {
      // column may already exist — ignore
    }

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_memory_agent_key_idx
        ON agent_memory (agent, key) WHERE deleted_at IS NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS agent_memory_updated_idx
        ON agent_memory (updated_at DESC);
    `);

    // altus_search_queries — analytics log for public search queries
    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_search_queries (
        id               SERIAL PRIMARY KEY,
        query            TEXT NOT NULL,
        mode             TEXT NOT NULL DEFAULT 'ai',
        result_count     INTEGER DEFAULT 0,
        response_time_ms INTEGER DEFAULT 0,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS altus_search_queries_created_idx
        ON altus_search_queries (created_at DESC);
    `);

    // altus_search_feedback — reader feedback on AI search results
    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_search_feedback (
        id               SERIAL PRIMARY KEY,
        query            TEXT NOT NULL,
        mode             TEXT NOT NULL DEFAULT 'ai',
        rating           INTEGER NOT NULL,
        comment          TEXT,
        answer_excerpt   TEXT,
        results_shown    TEXT[],
        ip_address       INET,
        user_agent       TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS altus_search_feedback_created_idx
        ON altus_search_feedback (created_at DESC);
    `);

    logger.info('Altus schema initialized');
  } finally {
    client.release();
  }
}

export async function initAltusEventLogSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_events (
        id            BIGSERIAL     PRIMARY KEY,
        event_type    VARCHAR(20)   NOT NULL
                      CHECK (event_type IN ('tool_call', 'tool_error', 'cron_trigger', 'session_start', 'session_end', 'scope_denied')),
        tool_name     VARCHAR(100),
        session_id    INTEGER,
        payload       JSONB,
        error_message TEXT,
        duration_ms   INTEGER,
        created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS altus_events_created_at_idx
        ON altus_events (created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS altus_events_tool_created_idx
        ON altus_events (tool_name, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS altus_events_session_created_idx
        ON altus_events (session_id, created_at DESC)
        WHERE session_id IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_audit_batches (
        id            SERIAL        PRIMARY KEY,
        batch_id      VARCHAR(100)  NOT NULL UNIQUE,
        requested_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        window_hours  INTEGER       NOT NULL,
        status        VARCHAR(20)   NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'complete', 'error')),
        narrative     TEXT,
        completed_at  TIMESTAMPTZ
      )
    `);

    logger.info('Altus event log schema initialized');
  } finally {
    client.release();
  }
}

export async function initHeartbeatSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_heartbeat_log (
        id               SERIAL PRIMARY KEY,
        run_at           TIMESTAMPTZ DEFAULT NOW(),
        duration_ms      INTEGER,
        items_evaluated  INTEGER DEFAULT 0,
        items_acted      INTEGER DEFAULT 0,
        items_queued     INTEGER DEFAULT 0,
        items_skipped    INTEGER DEFAULT 0,
        alerts_sent      INTEGER DEFAULT 0,
        error_message    TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_scheduled_tasks (
        id            SERIAL PRIMARY KEY,
        task_type     VARCHAR(50)  NOT NULL,
        payload       JSONB,
        due_at        TIMESTAMPTZ  NOT NULL,
        status        VARCHAR(20)  NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        started_at    TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        error_message TEXT,
        metadata      JSONB
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS altus_scheduled_tasks_due_at_idx
        ON altus_scheduled_tasks (due_at ASC)
        WHERE status = 'pending'
    `);

    logger.info('Altus heartbeat schema initialized');
  } finally {
    client.release();
  }
}

/**
 * Read a single agent_memory entry (excludes soft-deleted rows).
 *
 * @param {string} agent - 'hal', 'ben', 'altus', etc.
 * @param {string} key
 * @returns {Promise<{success: boolean, agent: string, key: string, value: string, updated_at: string}|{success: false, exit_reason: string}>}
 */
export async function readAgentMemory(agent, key) {
  const { rows } = await pool.query(
    `SELECT agent, key, value, updated_at FROM agent_memory
     WHERE agent = $1 AND key = $2 AND deleted_at IS NULL`,
    [agent.toLowerCase(), key]
  );
  if (rows.length === 0) {
    return { success: false, exit_reason: 'not_found', message: `No memory entry for agent="${agent}" key="${key}"` };
  }
  return { success: true, ...rows[0] };
}

/**
 * Write (upsert) a memory entry for an agent.
 * If the row exists and is soft-deleted, this undeletes it (clears deleted_at).
 *
 * @param {string} agent - 'hal', 'ben', 'altus', etc.
 * @param {string} key
 * @param {string} value
 * @returns {Promise<{success: boolean, agent: string, key: string}>}
 */
export async function writeAgentMemory(agent, key, value) {
  await pool.query(
    `INSERT INTO agent_memory (agent, key, value, deleted_at)
     VALUES ($1, $2, $3, NULL)
     ON CONFLICT (agent, key) DO UPDATE
       SET value      = EXCLUDED.value,
           updated_at = NOW(),
           deleted_at = NULL`,
    [agent.toLowerCase(), key, value]
  );
  logger.info('Agent memory written', { agent, key });
  return { success: true, agent, key };
}

/**
 * Soft-delete a memory entry by setting deleted_at = NOW().
 * Does NOT hard-delete — the row is retained for recovery.
 *
 * @param {string} agent
 * @param {string} key
 * @returns {Promise<{success: boolean, deleted: boolean}>}
 */
export async function deleteAgentMemory(agent, key) {
  const result = await pool.query(
    `UPDATE agent_memory SET deleted_at = NOW()
     WHERE agent = $1 AND key = $2 AND deleted_at IS NULL`,
    [agent.toLowerCase(), key]
  );
  return { success: true, deleted: result.rowCount > 0 };
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
