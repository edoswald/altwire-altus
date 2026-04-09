# Altus RAG Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Railway MCP server (`altwire-altus`) that ingests AltWire's full content archive into pgvector embeddings and exposes a `search_altwire_archive` MCP tool for semantic search.

**Architecture:** Node.js ESM service on Railway using a shared PostgreSQL instance (with pgvector) to store Voyage AI embeddings of ~1,563 AltWire posts and galleries. A one-time ingestion script pulls content from the WordPress REST API and a custom NGG gallery endpoint, synthesizes gallery descriptions via Claude Haiku, embeds everything via Voyage AI, and upserts into `altus_content`. The MCP server exposes a single stateless StreamableHTTP tool that embeds the query and runs a cosine similarity search.

**Tech Stack:** Node.js ESM, `@modelcontextprotocol/sdk` (StreamableHTTP stateless), `pg` (pgvector via string casting), `@anthropic-ai/sdk` (Claude Haiku), Voyage AI REST API (fetch), Zod, Vitest

---

## File Map

| File | Purpose |
|---|---|
| `index.js` | MCP server entry point — tool registration, `initSchema()`, `GET /health` |
| `package.json` | ESM, dependencies, vitest scripts |
| `.env.example` | All env vars documented |
| `railway.toml` | Railway build/deploy config |
| `logger.js` | Structured JSON logger (stderr, same pattern as Nimbus) |
| `lib/altus-db.js` | Pool singleton, `initSchema()`, `upsertContent()` |
| `lib/voyage.js` | `embedDocuments(texts)`, `embedQuery(text)` wrappers |
| `lib/synthesizer.js` | Claude Haiku gallery description synthesis |
| `lib/wp-client.js` | WP REST API: paginated posts, taxonomy cache, NGG galleries |
| `lib/safe-tool-handler.js` | try/catch wrapper returning structured MCP errors |
| `handlers/altus-search.js` | `search_altwire_archive` handler logic |
| `scripts/ingest.js` | One-time ingestion script (posts + galleries) |
| `tests/voyage.test.js` | Unit + env-guard tests for voyage.js |
| `tests/altus-search.test.js` | Unit tests for altus-search.js handler |

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `railway.toml`
- Create: `logger.js`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "altwire-altus",
  "version": "1.0.0",
  "description": "Altus MCP server — AltWire RAG foundation",
  "type": "module",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "test": "vitest --run"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.18.0",
    "pg": "^8.11.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Write `.env.example`**

```bash
# Required
DATABASE_URL=                  # Shared Railway PostgreSQL connection string
ALTWIRE_WP_URL=                # https://altwire.net
ALTWIRE_WP_USER=               # WordPress admin username
ALTWIRE_WP_APP_PASSWORD=       # WordPress Application Password (spaces kept intact)
VOYAGE_API_KEY=                # Voyage AI API key (voyage-3-lite model)
ANTHROPIC_API_KEY=             # For gallery synthesis via Claude Haiku

# Optional
PORT=3000                      # Railway sets this automatically
TEST_MODE=false                # Set true to skip live API calls in tests
LOG_LEVEL=info
```

- [ ] **Step 3: Write `railway.toml`**

```toml
[build]
builder = "nixpacks"

[deploy]
startCommand = "node --no-deprecation index.js"
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3

[[services]]
name = "altwire-altus"
```

- [ ] **Step 4: Write `logger.js`**

```javascript
/**
 * Structured JSON logger — writes to stderr, never stdout.
 * stdout is reserved for MCP stdio transport.
 */

const priority = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, message, meta = {}) {
  const minLevel = process.env.LOG_LEVEL || 'info';
  if ((priority[level] ?? 0) < (priority[minLevel] ?? 1)) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...meta,
  };
  process.stderr.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug: (msg, meta) => log('debug', msg, meta),
  info:  (msg, meta) => log('info',  msg, meta),
  warn:  (msg, meta) => log('warn',  msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};
```

- [ ] **Step 5: Install dependencies**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Init git and commit scaffold**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
git init
echo "node_modules/" > .gitignore
echo ".env" >> .gitignore
git add package.json .env.example railway.toml logger.js .gitignore
git commit -m "feat: project scaffold — package.json, env template, railway config, logger"
```

---

## Task 2: Database Layer

**Files:**
- Create: `lib/altus-db.js`

- [ ] **Step 1: Write failing test**

Create `tests/altus-db.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('altus-db', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('initSchema resolves without error when DATABASE_URL is set', async () => {
    // Uses a real connection string — skipped in TEST_MODE
    if (process.env.TEST_MODE === 'true' || !process.env.DATABASE_URL) {
      expect(true).toBe(true); // skip
      return;
    }
    const { initSchema } = await import('../lib/altus-db.js');
    await expect(initSchema()).resolves.not.toThrow();
  });

  it('pool is exported as default', async () => {
    const mod = await import('../lib/altus-db.js');
    expect(mod.default).toBeDefined();
  });

  it('upsertContent returns inserted row id', async () => {
    if (process.env.TEST_MODE === 'true' || !process.env.DATABASE_URL) {
      expect(true).toBe(true); // skip
      return;
    }
    const { upsertContent, initSchema } = await import('../lib/altus-db.js');
    await initSchema();
    const fakeEmbedding = Array(1024).fill(0.1);
    const id = await upsertContent({
      wp_id: 999999,
      content_type: 'post',
      title: 'Test post',
      slug: 'test-post',
      url: 'https://altwire.net/test-post',
      published_at: new Date().toISOString(),
      author: 'tester',
      categories: ['test'],
      tags: ['unit-test'],
      raw_text: 'This is a test post for unit testing.',
      embedding: fakeEmbedding,
    });
    expect(typeof id).toBe('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/altus-db.test.js
```

Expected: FAIL — `Cannot find module '../lib/altus-db.js'`

- [ ] **Step 3: Create `lib/` directory and write `lib/altus-db.js`**

```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
TEST_MODE=true npx vitest --run tests/altus-db.test.js
```

Expected: PASS (TEST_MODE skips live DB assertions, pool export test passes)

- [ ] **Step 5: Commit**

```bash
git add lib/altus-db.js tests/altus-db.test.js
git commit -m "feat: database layer — pool, initSchema, upsertContent, logIngestRun"
```

---

## Task 3: Voyage AI Embeddings

**Files:**
- Create: `lib/voyage.js`
- Create: `tests/voyage.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/voyage.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('voyage.js', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('embedDocuments returns structured error when VOYAGE_API_KEY is missing', async () => {
    const saved = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    const { embedDocuments } = await import('../lib/voyage.js');
    const result = await embedDocuments(['hello world']);
    expect(result).toEqual({ error: 'Embedding service unavailable — VOYAGE_API_KEY not set' });
    if (saved !== undefined) process.env.VOYAGE_API_KEY = saved;
  });

  it('embedQuery returns structured error when VOYAGE_API_KEY is missing', async () => {
    const saved = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    const { embedQuery } = await import('../lib/voyage.js');
    const result = await embedQuery('test query');
    expect(result).toEqual({ error: 'Embedding service unavailable — VOYAGE_API_KEY not set' });
    if (saved !== undefined) process.env.VOYAGE_API_KEY = saved;
  });

  it('embedDocuments calls Voyage API with document input_type and batches correctly', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: Array(1024).fill(0.1) },
          { embedding: Array(1024).fill(0.2) },
        ],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { embedDocuments } = await import('../lib/voyage.js');
    const result = await embedDocuments(['text one', 'text two']);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1024);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.input_type).toBe('document');
    expect(callBody.model).toBe('voyage-3-lite');

    vi.unstubAllGlobals();
    delete process.env.VOYAGE_API_KEY;
  });

  it('embedQuery calls Voyage API with query input_type', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: Array(1024).fill(0.5) }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { embedQuery } = await import('../lib/voyage.js');
    const result = await embedQuery('artist name');

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1024);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.input_type).toBe('query');

    vi.unstubAllGlobals();
    delete process.env.VOYAGE_API_KEY;
  });

  it('embedDocuments returns structured error on Voyage API 429 after retries', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ message: 'rate limited' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const { embedDocuments } = await import('../lib/voyage.js');
    const result = await embedDocuments(['text'], { maxRetries: 1, retryDelayMs: 0 });

    expect(result).toHaveProperty('error');
    expect(result.error).toMatch(/rate limit/i);

    vi.unstubAllGlobals();
    delete process.env.VOYAGE_API_KEY;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/voyage.test.js
```

Expected: FAIL — `Cannot find module '../lib/voyage.js'`

- [ ] **Step 3: Write `lib/voyage.js`**

```javascript
/**
 * Voyage AI embedding wrappers.
 *
 * embedDocuments(texts, opts) — batch-embed content for storage (input_type: 'document')
 * embedQuery(text)            — embed a single search query (input_type: 'query')
 *
 * Both return a float[] on success or { error: string } on failure.
 * Never throw — callers check for .error property.
 */

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-lite';
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 200;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Call the Voyage API with retry on 429.
 */
async function callVoyage(input, inputType, opts = {}) {
  const { maxRetries = 3, retryDelayMs = 2000 } = opts;
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    return { error: 'Embedding service unavailable — VOYAGE_API_KEY not set' };
  }

  let delay = retryDelayMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: MODEL, input, input_type: inputType }),
    });

    if (res.ok) {
      const data = await res.json();
      return data.data.map((d) => d.embedding);
    }

    if (res.status === 429 && attempt < maxRetries) {
      await sleep(delay);
      delay *= 2; // exponential backoff
      continue;
    }

    return { error: `Voyage API error — rate limit exceeded after ${maxRetries} retries` };
  }
  return { error: 'Voyage API error — max retries exceeded' };
}

/**
 * Embed an array of document strings for storage.
 * Batches in groups of BATCH_SIZE with a delay between batches.
 * Returns float[][] or { error: string }.
 *
 * @param {string[]} texts
 * @param {object} [opts] - { maxRetries, retryDelayMs } (for testing)
 * @returns {Promise<number[][] | { error: string }>}
 */
export async function embedDocuments(texts, opts = {}) {
  if (!process.env.VOYAGE_API_KEY) {
    return { error: 'Embedding service unavailable — VOYAGE_API_KEY not set' };
  }

  const results = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchResult = await callVoyage(batch, 'document', opts);
    if (batchResult?.error) return batchResult;
    results.push(...batchResult);
    if (i + BATCH_SIZE < texts.length) {
      await sleep(opts.retryDelayMs !== undefined ? 0 : BATCH_DELAY_MS);
    }
  }
  return results;
}

/**
 * Embed a single query string for search.
 * Returns float[] or { error: string }.
 *
 * @param {string} text
 * @returns {Promise<number[] | { error: string }>}
 */
export async function embedQuery(text) {
  if (!process.env.VOYAGE_API_KEY) {
    return { error: 'Embedding service unavailable — VOYAGE_API_KEY not set' };
  }
  const result = await callVoyage([text], 'query');
  if (result?.error) return result;
  return result[0];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/voyage.test.js
```

Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/voyage.js tests/voyage.test.js
git commit -m "feat: Voyage AI embedding wrappers — embedDocuments, embedQuery with retry"
```

---

## Task 4: Gallery Synthesizer

**Files:**
- Create: `lib/synthesizer.js`

No live API tests — unit tests cover the prompt construction and fallback path.

- [ ] **Step 1: Write failing tests**

Create `tests/synthesizer.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('synthesizer.js', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('synthesizeGallery returns fallback string when ANTHROPIC_API_KEY is missing', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { synthesizeGallery } = await import('../lib/synthesizer.js');
    const result = await synthesizeGallery({
      title: 'Test Gallery',
      description: '',
      image_count: 10,
      images: [],
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('Test Gallery');
    expect(result).toContain('10');
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  });

  it('synthesizeGallery uses description in fallback when provided', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { synthesizeGallery } = await import('../lib/synthesizer.js');
    const result = await synthesizeGallery({
      title: 'My Gallery',
      description: 'A great show',
      image_count: 5,
      images: [],
    });
    expect(result).toContain('A great show');
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  });

  it('synthesizeGallery calls Anthropic with haiku model and returns text', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'This is a synthesized gallery description.' }],
    });
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class Anthropic {
        constructor() { this.messages = { create: mockCreate }; }
      },
    }));
    const { synthesizeGallery } = await import('../lib/synthesizer.js');
    const result = await synthesizeGallery({
      title: 'Live at Coachella',
      description: 'Highlight reel',
      image_count: 30,
      images: [{ alt: 'Band on stage', caption: 'Opening night' }],
    });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(10);
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    expect(call.max_tokens).toBe(150);
    delete process.env.ANTHROPIC_API_KEY;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/synthesizer.test.js
```

Expected: FAIL — `Cannot find module '../lib/synthesizer.js'`

- [ ] **Step 3: Write `lib/synthesizer.js`**

```javascript
/**
 * Claude Haiku gallery description synthesizer.
 * Used during ingestion to generate embeddings-friendly text for NGG galleries.
 * Falls back to a template string if Anthropic API is unavailable.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Generate a 2-3 sentence description for a NextGEN gallery.
 * Returns a string. Never throws — returns fallback on any error.
 *
 * @param {{ title: string, description: string, image_count: number, images: Array<{alt:string,caption:string}> }} gallery
 * @returns {Promise<string>}
 */
export async function synthesizeGallery(gallery) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return fallback(gallery);
  }

  try {
    const client = new Anthropic();
    const imageLines = gallery.images
      .slice(0, 20)
      .map((img) => `- ${img.alt || '(untitled)'}: ${img.caption || '(no caption)'}`)
      .join('\n');

    const userPrompt = [
      `Gallery title: ${gallery.title}`,
      `Gallery description: ${gallery.description || 'none provided'}`,
      `Image count: ${gallery.image_count}`,
      imageLines ? `Image titles/captions (up to 20):\n${imageLines}` : '',
      '',
      'Write a 2-3 sentence description of what this gallery covers.',
    ]
      .filter(Boolean)
      .join('\n');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 150,
      temperature: 0,
      system:
        'You are summarizing a photo gallery for a music publication called AltWire. Write 2-3 sentences describing this gallery based on the metadata provided. Be factual and specific. Do not invent details not present in the data.',
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    if (text.trim()) return text.trim();
    return fallback(gallery);
  } catch (err) {
    logger.warn('Gallery synthesis failed — using fallback', {
      title: gallery.title,
      error: err.message,
    });
    return fallback(gallery);
  }
}

function fallback(gallery) {
  const parts = [
    `${gallery.title} — photo gallery with ${gallery.image_count} images`,
  ];
  if (gallery.description && gallery.description.trim()) {
    parts.push(gallery.description.trim());
  }
  return parts.join('. ');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/synthesizer.test.js
```

Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/synthesizer.js tests/synthesizer.test.js
git commit -m "feat: Claude Haiku gallery synthesizer with fallback"
```

---

## Task 5: WordPress Client

**Files:**
- Create: `lib/wp-client.js`

- [ ] **Step 1: Write failing tests**

Create `tests/wp-client.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('wp-client.js', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('buildAuthHeader base64-encodes user:password with spaces preserved', async () => {
    process.env.ALTWIRE_WP_USER = 'admin';
    process.env.ALTWIRE_WP_APP_PASSWORD = 'xxxx xxxx xxxx xxxx xxxx xxxx';
    const { buildAuthHeader } = await import('../lib/wp-client.js');
    const header = buildAuthHeader();
    const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8');
    expect(decoded).toBe('admin:xxxx xxxx xxxx xxxx xxxx xxxx');
    delete process.env.ALTWIRE_WP_USER;
    delete process.env.ALTWIRE_WP_APP_PASSWORD;
  });

  it('stripHtml removes all HTML tags from a string', async () => {
    const { stripHtml } = await import('../lib/wp-client.js');
    expect(stripHtml('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
    expect(stripHtml('No tags here')).toBe('No tags here');
    expect(stripHtml('&amp; &lt; &gt; &nbsp;')).toBe('& < >  ');
  });

  it('fetchPosts paginates until response shorter than per_page', async () => {
    process.env.ALTWIRE_WP_URL = 'https://altwire.net';
    process.env.ALTWIRE_WP_USER = 'admin';
    process.env.ALTWIRE_WP_APP_PASSWORD = 'pass';

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((url) => {
      callCount++;
      const items = callCount === 1
        ? Array(100).fill(null).map((_, i) => ({
            id: i + 1, slug: `post-${i}`, link: `https://altwire.net/post-${i}`,
            date: '2024-01-01T00:00:00', title: { rendered: `Post ${i}` },
            content: { rendered: '<p>Content</p>' }, excerpt: { rendered: '<p>Excerpt</p>' },
            categories: [], tags: [],
          }))
        : Array(5).fill(null).map((_, i) => ({
            id: i + 101, slug: `post-${i+100}`, link: `https://altwire.net/post-${i+100}`,
            date: '2024-01-01T00:00:00', title: { rendered: `Post ${i+100}` },
            content: { rendered: '<p>Content</p>' }, excerpt: { rendered: '<p>Excerpt</p>' },
            categories: [], tags: [],
          }));
      return Promise.resolve({ ok: true, json: async () => items });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { fetchPosts } = await import('../lib/wp-client.js');
    const posts = await fetchPosts({ categoryCache: new Map(), tagCache: new Map() });
    expect(posts).toHaveLength(105);
    expect(callCount).toBe(2);

    delete process.env.ALTWIRE_WP_URL;
    delete process.env.ALTWIRE_WP_USER;
    delete process.env.ALTWIRE_WP_APP_PASSWORD;
  });

  it('fetchGalleries paginates until response shorter than per_page', async () => {
    process.env.ALTWIRE_WP_URL = 'https://altwire.net';
    process.env.ALTWIRE_WP_USER = 'admin';
    process.env.ALTWIRE_WP_APP_PASSWORD = 'pass';

    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      const items = callCount === 1
        ? Array(50).fill(null).map((_, i) => ({
            id: i + 1, title: `Gallery ${i}`, description: '', slug: `gallery-${i}`,
            url: '', image_count: 5, images: [],
          }))
        : Array(3).fill(null).map((_, i) => ({
            id: i + 51, title: `Gallery ${i+50}`, description: '', slug: `gallery-${i+50}`,
            url: '', image_count: 2, images: [],
          }));
      return Promise.resolve({ ok: true, json: async () => items });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { fetchGalleries } = await import('../lib/wp-client.js');
    const galleries = await fetchGalleries();
    expect(galleries).toHaveLength(53);
    expect(callCount).toBe(2);

    delete process.env.ALTWIRE_WP_URL;
    delete process.env.ALTWIRE_WP_USER;
    delete process.env.ALTWIRE_WP_APP_PASSWORD;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/wp-client.test.js
```

Expected: FAIL — `Cannot find module '../lib/wp-client.js'`

- [ ] **Step 3: Write `lib/wp-client.js`**

```javascript
/**
 * WordPress REST API client for AltWire content ingestion.
 *
 * buildAuthHeader()    — Basic auth header from env vars
 * stripHtml(html)      — Remove HTML tags and decode common entities
 * fetchTaxonomies()    — Returns { categoryCache, tagCache } (Maps of id -> name)
 * fetchPosts(caches)   — Paginated fetch of all published posts
 * fetchGalleries()     — Paginated fetch of all NGG galleries via /altus/v1/galleries
 */

import { logger } from '../logger.js';

/**
 * Build the Basic auth header. Spaces in app password are preserved — WP requires them.
 */
export function buildAuthHeader() {
  const user = process.env.ALTWIRE_WP_USER ?? '';
  const pass = process.env.ALTWIRE_WP_APP_PASSWORD ?? '';
  const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Strip HTML tags and decode common HTML entities.
 */
export function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

function base() {
  return (process.env.ALTWIRE_WP_URL ?? '').replace(/\/$/, '');
}

async function wpFetch(path) {
  const url = `${base()}/wp-json${path}`;
  const res = await fetch(url, {
    headers: { Authorization: buildAuthHeader() },
  });
  if (!res.ok) {
    throw new Error(`WP fetch failed: ${res.status} ${url}`);
  }
  return res.json();
}

/**
 * Fetch all WP categories and tags, returning in-memory Maps.
 * @returns {Promise<{ categoryCache: Map<number,string>, tagCache: Map<number,string> }>}
 */
export async function fetchTaxonomies() {
  const [cats, tags] = await Promise.all([
    wpFetch('/wp/v2/categories?per_page=100'),
    wpFetch('/wp/v2/tags?per_page=100'),
  ]);
  const categoryCache = new Map(cats.map((c) => [c.id, c.name]));
  const tagCache = new Map(tags.map((t) => [t.id, t.name]));
  logger.info('Taxonomy cache loaded', {
    categories: categoryCache.size,
    tags: tagCache.size,
  });
  return { categoryCache, tagCache };
}

/**
 * Fetch all published posts, paginated.
 * @param {{ categoryCache: Map<number,string>, tagCache: Map<number,string> }} caches
 * @returns {Promise<Array>}
 */
export async function fetchPosts({ categoryCache, tagCache }) {
  const all = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const items = await wpFetch(
      `/wp/v2/posts?per_page=${perPage}&page=${page}&status=publish&_fields=id,slug,link,date,author,title,content,excerpt,categories,tags`
    );
    for (const item of items) {
      const rawContent = stripHtml(item.content?.rendered ?? '');
      const rawExcerpt = stripHtml(item.excerpt?.rendered ?? '');
      const raw_text = rawContent.length < 200
        ? `${rawExcerpt}\n\n${rawContent}`.trim()
        : rawContent;

      all.push({
        wp_id: item.id,
        content_type: 'post',
        title: stripHtml(item.title?.rendered ?? ''),
        slug: item.slug,
        url: item.link,
        published_at: item.date,
        author: typeof item.author === 'number' ? String(item.author) : (item.author ?? null),
        categories: (item.categories ?? []).map((id) => categoryCache.get(id) ?? String(id)),
        tags: (item.tags ?? []).map((id) => tagCache.get(id) ?? String(id)),
        raw_text,
      });
    }
    logger.info(`Fetched posts page ${page}`, { count: items.length });
    if (items.length < perPage) break;
    page++;
  }

  return all;
}

/**
 * Fetch all NGG galleries via the custom /altus/v1/galleries endpoint.
 * @returns {Promise<Array>}
 */
export async function fetchGalleries() {
  const all = [];
  let page = 1;
  const perPage = 50;

  while (true) {
    const items = await wpFetch(`/altus/v1/galleries?page=${page}&per_page=${perPage}`);
    all.push(...items);
    logger.info(`Fetched galleries page ${page}`, { count: items.length });
    if (items.length < perPage) break;
    page++;
  }

  return all;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/wp-client.test.js
```

Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/wp-client.js tests/wp-client.test.js
git commit -m "feat: WordPress REST API client — posts, galleries, taxonomy cache, HTML stripping"
```

---

## Task 6: Safe Tool Handler

**Files:**
- Create: `lib/safe-tool-handler.js`

- [ ] **Step 1: Write failing test**

Create `tests/safe-tool-handler.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { safeToolHandler } from '../lib/safe-tool-handler.js';

describe('safeToolHandler', () => {
  it('returns handler result on success', async () => {
    const handler = safeToolHandler(async () => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
    }));
    const result = await handler({});
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });

  it('catches thrown error and returns structured exit_reason tool_error', async () => {
    const handler = safeToolHandler(async () => {
      throw new Error('database exploded');
    });
    const result = await handler({});
    const body = JSON.parse(result.content[0].text);
    expect(body.exit_reason).toBe('tool_error');
    expect(body.success).toBe(false);
  });

  it('passes params through to the handler', async () => {
    const handler = safeToolHandler(async ({ query }) => ({
      content: [{ type: 'text', text: query }],
    }));
    const result = await handler({ query: 'hello' });
    expect(result.content[0].text).toBe('hello');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/safe-tool-handler.test.js
```

Expected: FAIL — `Cannot find module '../lib/safe-tool-handler.js'`

- [ ] **Step 3: Write `lib/safe-tool-handler.js`**

```javascript
/**
 * safeToolHandler — wraps MCP tool handlers in a try/catch.
 * Returns structured { exit_reason: 'tool_error' } on unexpected exceptions
 * instead of propagating the error to the MCP transport.
 *
 * This is a standalone version for Altus — no scope gating needed.
 */

import { logger } from '../logger.js';

/**
 * @param {function} handler - async (params) => MCP result object
 * @returns {function} async (params) => MCP result object
 */
export function safeToolHandler(handler) {
  return async (params) => {
    try {
      return await handler(params);
    } catch (err) {
      logger.error('Unexpected tool handler error', {
        error: err.message,
        stack: err.stack,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              exit_reason: 'tool_error',
              message: 'An unexpected error occurred.',
            }),
          },
        ],
      };
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/safe-tool-handler.test.js
```

Expected: PASS (all 3 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/safe-tool-handler.js tests/safe-tool-handler.test.js
git commit -m "feat: safeToolHandler wrapper — structured error return on exceptions"
```

---

## Task 7: Search Handler

**Files:**
- Create: `handlers/altus-search.js`
- Create: `tests/altus-search.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/altus-search.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('altus-search.js', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('returns structured error when DATABASE_URL is not set', async () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const { searchAltwireArchive } = await import('../handlers/altus-search.js');
    const result = await searchAltwareArchive({ query: 'test', limit: 5, content_type: 'all' });
    expect(result.error).toBe('Database not configured');
    if (saved !== undefined) process.env.DATABASE_URL = saved;
  });

  it('returns structured error when Voyage embedding fails', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    vi.doMock('../lib/voyage.js', () => ({
      embedQuery: async () => ({ error: 'Embedding service unavailable' }),
    }));
    const { searchAltwareArchive } = await import('../handlers/altus-search.js');
    const result = await searchAltwareArchive({ query: 'test', limit: 5, content_type: 'all' });
    expect(result.error).toBe('Embedding service unavailable');
    delete process.env.DATABASE_URL;
  });

  it('filters by content_type when not "all"', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const mockEmbedding = Array(1024).fill(0.1);
    vi.doMock('../lib/voyage.js', () => ({
      embedQuery: async () => mockEmbedding,
    }));
    const mockQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          content_type: 'post', title: 'Test Post', url: 'https://altwire.net/post',
          published_at: new Date(), categories: ['Rock'], tags: ['live'],
          snippet: 'A great show...', similarity: 0.92,
        },
      ],
    });
    vi.doMock('../lib/altus-db.js', () => ({
      default: { query: mockQuery },
    }));
    const { searchAltwareArchive } = await import('../handlers/altus-search.js');
    await searchAltwareArchive({ query: 'live show', limit: 5, content_type: 'post' });
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).toContain("AND content_type = $3");
  });

  it('does not add type filter when content_type is "all"', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const mockEmbedding = Array(1024).fill(0.1);
    vi.doMock('../lib/voyage.js', () => ({
      embedQuery: async () => mockEmbedding,
    }));
    const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
    vi.doMock('../lib/altus-db.js', () => ({
      default: { query: mockQuery },
    }));
    const { searchAltwareArchive } = await import('../handlers/altus-search.js');
    await searchAltwareArchive({ query: 'artist', limit: 5, content_type: 'all' });
    const sql = mockQuery.mock.calls[0][0];
    expect(sql).not.toContain("AND content_type");
  });

  it('returns results array with similarity, title, url, snippet fields', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    const mockEmbedding = Array(1024).fill(0.2);
    vi.doMock('../lib/voyage.js', () => ({
      embedQuery: async () => mockEmbedding,
    }));
    vi.doMock('../lib/altus-db.js', () => ({
      default: {
        query: vi.fn()
          .mockResolvedValueOnce({
            rows: [
              {
                content_type: 'gallery', title: 'Glastonbury 2024', url: 'https://altwire.net/g/1',
                published_at: null, categories: [], tags: ['festival'],
                snippet: 'Big stage photos...', similarity: 0.88,
              },
            ],
          })
          .mockResolvedValueOnce({ rows: [{ count: '1563' }] }),
      },
    }));
    const { searchAltwareArchive } = await import('../handlers/altus-search.js');
    const result = await searchAltwareArchive({ query: 'glastonbury', limit: 5, content_type: 'all' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].similarity).toBeCloseTo(0.88);
    expect(result.results[0].title).toBe('Glastonbury 2024');
    expect(result.total_searched).toBe(1563);
    expect(result.query).toBe('glastonbury');
    delete process.env.DATABASE_URL;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/altus-search.test.js
```

Expected: FAIL — `Cannot find module '../handlers/altus-search.js'`

- [ ] **Step 3: Create `handlers/` directory and write `handlers/altus-search.js`**

```javascript
/**
 * search_altwire_archive handler.
 * Embeds the query via Voyage AI, runs cosine similarity search over altus_content.
 */

import pool from '../lib/altus-db.js';
import { embedQuery } from '../lib/voyage.js';
import { logger } from '../logger.js';

/**
 * @param {{ query: string, limit: number, content_type: 'post'|'gallery'|'all' }} params
 * @returns {Promise<object>} results or { error: string }
 */
export async function searchAltwareArchive({ query, limit, content_type }) {
  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  const embedding = await embedQuery(query);
  if (embedding?.error) {
    return { error: embedding.error };
  }

  const embeddingStr = `[${embedding.join(',')}]`;
  const typeFilter = content_type === 'all' ? '' : 'AND content_type = $3';
  const params = [embeddingStr, limit];
  if (content_type !== 'all') params.push(content_type);

  const sql = `
    SELECT
      content_type, title, url, published_at, categories, tags,
      LEFT(raw_text, 300) AS snippet,
      1 - (embedding <=> $1::vector) AS similarity
    FROM altus_content
    WHERE embedding IS NOT NULL
    ${typeFilter}
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `;

  try {
    const [searchResult, countResult] = await Promise.all([
      pool.query(sql, params),
      pool.query('SELECT COUNT(*) FROM altus_content WHERE embedding IS NOT NULL'),
    ]);

    const results = searchResult.rows.map((row) => ({
      type: row.content_type,
      title: row.title,
      url: row.url,
      published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
      categories: row.categories ?? [],
      tags: row.tags ?? [],
      snippet: row.snippet ?? '',
      similarity: parseFloat(row.similarity ?? 0),
    }));

    logger.info('Archive search completed', { query, results: results.length, content_type });

    return {
      results,
      total_searched: parseInt(countResult.rows[0].count, 10),
      query,
    };
  } catch (err) {
    logger.error('Archive search failed', { error: err.message });
    return { error: 'Search failed — database error' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
npx vitest --run tests/altus-search.test.js
```

Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add handlers/altus-search.js tests/altus-search.test.js
git commit -m "feat: search_altwire_archive handler — cosine similarity search over altus_content"
```

---

## Task 8: MCP Server Entry Point

**Files:**
- Create: `index.js`

- [ ] **Step 1: Write `index.js`**

```javascript
/**
 * Altus MCP Server — AltWire RAG Foundation
 *
 * Exposes one tool: search_altwire_archive
 * Transport: StreamableHTTP (stateless — sessionIdGenerator: undefined)
 * Health: GET /health
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'http';
import { z } from 'zod';
import { logger } from './logger.js';
import { initSchema } from './lib/altus-db.js';
import { safeToolHandler } from './lib/safe-tool-handler.js';
import { searchAltwareArchive } from './handlers/altus-search.js';

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Schema init — runs once at startup
// ---------------------------------------------------------------------------
if (process.env.DATABASE_URL) {
  initSchema().catch((err) => {
    logger.error('Schema init failed', { error: err.message });
  });
} else {
  logger.warn('DATABASE_URL not set — skipping schema init');
}

// ---------------------------------------------------------------------------
// MCP Server factory — new instance per stateless request
// ---------------------------------------------------------------------------
function createMcpServer() {
  const server = new McpServer({
    name: 'altwire-altus',
    version: '1.0.0',
  });

  // -------------------------------------------------------------------------
  // Tool: search_altwire_archive
  // -------------------------------------------------------------------------
  server.tool(
    'search_altwire_archive',
    'Searches the AltWire content archive using semantic similarity. Returns relevant articles, reviews, and galleries based on the query. Use this to understand how AltWire has previously covered an artist or topic.',
    {
      query: z.string().describe('The search query — artist name, topic, or concept'),
      limit: z.number().int().min(1).max(20).default(5).describe('Number of results to return'),
      content_type: z
        .enum(['post', 'gallery', 'all'])
        .default('all')
        .describe('Filter by content type'),
    },
    safeToolHandler(async ({ query, limit, content_type }) => {
      const result = await searchAltwareArchive({ query, limit, content_type });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    })
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check — no auth required
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'altus' }));
    return;
  }

  // MCP endpoint — stateless POST
  if (url.pathname === '/' || url.pathname === '/mcp') {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — prevents Claude.ai session caching issues
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

httpServer.listen(PORT, () => {
  logger.info(`Altus MCP server listening on port ${PORT}`, {
    healthEndpoint: `http://localhost:${PORT}/health`,
    mcpEndpoint: `http://localhost:${PORT}/`,
  });
});
```

- [ ] **Step 2: Smoke test the server starts**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
TEST_MODE=true node index.js &
sleep 2
curl -s http://localhost:3000/health
kill %1
```

Expected output: `{"status":"ok","service":"altus"}`

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: MCP server entry point — search_altwire_archive tool, /health, stateless StreamableHTTP"
```

---

## Task 9: Ingestion Script

**Files:**
- Create: `scripts/ingest.js`

- [ ] **Step 1: Write `scripts/ingest.js`**

```javascript
/**
 * AltWire content ingestion script.
 *
 * Run once (or on-demand) to populate altus_content with embeddings:
 *   node scripts/ingest.js
 *
 * Re-runs are safe — ON CONFLICT DO UPDATE ensures idempotency.
 */

import { initSchema, upsertContent, logIngestRun } from '../lib/altus-db.js';
import { fetchTaxonomies, fetchPosts, fetchGalleries } from '../lib/wp-client.js';
import { embedDocuments } from '../lib/voyage.js';
import { synthesizeGallery } from '../lib/synthesizer.js';
import { logger } from '../logger.js';

const required = ['DATABASE_URL', 'ALTWIRE_WP_URL', 'ALTWIRE_WP_USER', 'ALTWIRE_WP_APP_PASSWORD', 'VOYAGE_API_KEY', 'ANTHROPIC_API_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const startTime = Date.now();
let postsIngested = 0;
let galleriesIngested = 0;
let errors = 0;

async function ingestPosts(caches) {
  logger.info('Fetching posts from WordPress...');
  const posts = await fetchPosts(caches);
  logger.info(`Fetched ${posts.length} posts — embedding in batches of 50...`);

  // Build embed texts
  const embedTexts = posts.map((p) => {
    const cats = p.categories.join(', ');
    const tags = p.tags.join(', ');
    return `${p.title}\n\n${cats}\n${tags}\n\n${p.raw_text}`.slice(0, 8000);
  });

  const embeddings = await embedDocuments(embedTexts);
  if (embeddings?.error) {
    logger.error('Post embedding failed', { error: embeddings.error });
    errors += posts.length;
    return;
  }

  for (let i = 0; i < posts.length; i++) {
    try {
      await upsertContent({ ...posts[i], embedding: embeddings[i] });
      postsIngested++;
    } catch (err) {
      logger.warn('Post upsert failed', { wp_id: posts[i].wp_id, error: err.message });
      errors++;
    }
  }
  logger.info(`Posts ingested: ${postsIngested}`);
}

async function ingestGalleries() {
  logger.info('Fetching galleries from WordPress...');
  const galleries = await fetchGalleries();
  logger.info(`Fetched ${galleries.length} galleries — synthesizing and embedding...`);

  for (const gallery of galleries) {
    try {
      const synthesis = await synthesizeGallery(gallery);
      const tags = (gallery.tags ?? []).join(', ');
      const embedText = `${gallery.title}\n\nPhoto gallery\n${tags}\n\n${synthesis}`.slice(0, 8000);

      const embeddings = await embedDocuments([embedText]);
      if (embeddings?.error) {
        logger.warn('Gallery embedding failed', { id: gallery.id, error: embeddings.error });
        errors++;
        continue;
      }

      await upsertContent({
        wp_id: gallery.id,
        content_type: 'gallery',
        title: gallery.title,
        slug: gallery.slug ?? null,
        url: gallery.url ?? null,
        published_at: null,
        author: null,
        categories: [],
        tags: gallery.tags ?? [],
        raw_text: synthesis,
        embedding: embeddings[0],
      });
      galleriesIngested++;
    } catch (err) {
      logger.warn('Gallery ingest failed', { id: gallery.id, error: err.message });
      errors++;
    }
  }
  logger.info(`Galleries ingested: ${galleriesIngested}`);
}

async function main() {
  logger.info('Starting Altus ingestion run...');

  await initSchema();

  const caches = await fetchTaxonomies();

  await ingestPosts(caches);
  await ingestGalleries();

  const durationMs = Date.now() - startTime;
  await logIngestRun({
    mode: 'full',
    postsIngested,
    galleriesIngested,
    errors,
    durationMs,
    notes: `Ingestion complete. Posts: ${postsIngested}, Galleries: ${galleriesIngested}, Errors: ${errors}`,
  });

  console.log(`\nIngestion complete in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Posts:     ${postsIngested}`);
  console.log(`  Galleries: ${galleriesIngested}`);
  console.log(`  Errors:    ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal ingest error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Verify script can be parsed (no syntax errors)**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
node --input-type=module --eval "import './scripts/ingest.js'" 2>&1 | head -5
```

Expected: Only env var missing errors (no syntax errors). The script will exit with `Missing required env var: DATABASE_URL`.

- [ ] **Step 3: Commit**

```bash
git add scripts/ingest.js
git commit -m "feat: ingestion script — full upsert of posts and galleries with Voyage embeddings"
```

---

## Task 10: WordPress NGG Gallery Endpoint

**Files:**
- Create: `wordpress/altus-galleries.php` (mu-plugin to drop into AltWire WordPress)

This file is not part of the Node.js service — it's a WordPress mu-plugin that must be deployed to AltWire's `wp-content/mu-plugins/` directory.

- [ ] **Step 1: Write `wordpress/altus-galleries.php`**

```php
<?php
/**
 * Altus RAG — NextGEN Gallery REST Endpoint
 *
 * Drop this file into AltWire's wp-content/mu-plugins/ directory.
 * Exposes gallery metadata for ingestion by the Altus MCP server.
 * Requires WordPress Application Password authentication.
 *
 * Endpoint: GET /wp-json/altus/v1/galleries?page=1&per_page=50
 */

add_action('rest_api_init', function () {
    register_rest_route('altus/v1', '/galleries', [
        'methods'             => 'GET',
        'callback'            => 'altus_get_galleries',
        'permission_callback' => function () {
            return current_user_can('edit_posts');
        },
    ]);
});

function altus_get_galleries(WP_REST_Request $request) {
    global $wpdb;

    $page     = max(1, intval($request->get_param('page') ?? 1));
    $per_page = min(100, intval($request->get_param('per_page') ?? 50));
    $offset   = ($page - 1) * $per_page;

    $galleries = $wpdb->get_results($wpdb->prepare(
        "SELECT g.gid, g.title, g.galdesc, g.slug, g.pageid, g.previewpic,
                COUNT(i.pid) AS image_count
         FROM {$wpdb->prefix}ngg_gallery g
         LEFT JOIN {$wpdb->prefix}ngg_pictures i ON i.galleryid = g.gid AND i.exclude = 0
         GROUP BY g.gid
         ORDER BY g.gid ASC
         LIMIT %d OFFSET %d",
        $per_page,
        $offset
    ));

    if (empty($galleries)) {
        return rest_ensure_response([]);
    }

    $result = [];
    foreach ($galleries as $gallery) {
        $images = $wpdb->get_results($wpdb->prepare(
            "SELECT alttext, description
             FROM {$wpdb->prefix}ngg_pictures
             WHERE galleryid = %d AND exclude = 0
             ORDER BY sortorder ASC
             LIMIT 50",
            $gallery->gid
        ));

        $page_url = '';
        if ($gallery->pageid) {
            $page_url = get_permalink($gallery->pageid) ?: '';
        }

        $result[] = [
            'id'          => $gallery->gid,
            'title'       => $gallery->title,
            'description' => $gallery->galdesc,
            'slug'        => $gallery->slug,
            'url'         => $page_url,
            'image_count' => (int) $gallery->image_count,
            'images'      => array_map(fn($img) => [
                'alt'     => $img->alttext,
                'caption' => $img->description,
            ], $images),
        ];
    }

    return rest_ensure_response($result);
}
```

- [ ] **Step 2: Commit the PHP file**

```bash
git add wordpress/altus-galleries.php
git commit -m "feat: NGG gallery REST endpoint mu-plugin for AltWire WordPress"
```

- [ ] **Step 3: Deploy to AltWire WordPress**

Copy `wordpress/altus-galleries.php` to AltWire's `wp-content/mu-plugins/altus-galleries.php` via SFTP or SSH. The endpoint is auto-active as a mu-plugin — no activation step required.

Verify the endpoint responds (substitute your credentials):

```bash
curl -s -u "admin:xxxx xxxx xxxx xxxx xxxx xxxx" \
  "https://altwire.net/wp-json/altus/v1/galleries?per_page=2" | python3 -m json.tool
```

Expected: JSON array of gallery objects with `id`, `title`, `image_count`, `images` fields.

---

## Task 11: Full Test Suite + CI Verification

- [ ] **Step 1: Run all tests**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
TEST_MODE=true npx vitest --run
```

Expected: All tests pass. You should see:
- `tests/altus-db.test.js` — PASS (2 tests skip live DB in TEST_MODE)
- `tests/voyage.test.js` — PASS (5 tests)
- `tests/synthesizer.test.js` — PASS (3 tests)
- `tests/wp-client.test.js` — PASS (4 tests)
- `tests/safe-tool-handler.test.js` — PASS (3 tests)
- `tests/altus-search.test.js` — PASS (5 tests)

- [ ] **Step 2: Verify server health endpoint**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
node index.js &
sleep 2
curl -s http://localhost:3000/health
kill %1
```

Expected: `{"status":"ok","service":"altus"}`

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: all tests passing, server smoke test verified"
```

---

## Task 12: Railway Deployment

- [ ] **Step 1: Create GitHub repo and push**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
git remote add origin https://github.com/edoswald/altwire-altus.git
git push -u origin main
```

- [ ] **Step 2: Deploy to Railway via MCP tool**

In Claude Code, call:

```
mcp__railway__deploy({ workspacePath: '/Users/edoswald/Documents/Dev/altwire-altus' })
```

- [ ] **Step 3: Set environment variables in Railway**

Set these in the Railway dashboard for the `altwire-altus` service:

```
DATABASE_URL          (auto-set by Railway if you attach the shared PG service)
ALTWIRE_WP_URL        https://altwire.net
ALTWIRE_WP_USER       <admin username>
ALTWIRE_WP_APP_PASSWORD  <app password with spaces>
VOYAGE_API_KEY        <voyage key>
ANTHROPIC_API_KEY     <anthropic key>
PORT                  3000
LOG_LEVEL             info
```

- [ ] **Step 4: Verify Railway health check**

```bash
curl -s https://<railway-default-url>/health
```

Expected: `{"status":"ok","service":"altus"}`

- [ ] **Step 5: Run the ingestion script**

```bash
cd /Users/edoswald/Documents/Dev/altwire-altus
DATABASE_URL=<...> ALTWIRE_WP_URL=https://altwire.net ALTWIRE_WP_USER=<...> \
  ALTWIRE_WP_APP_PASSWORD="<...>" VOYAGE_API_KEY=<...> ANTHROPIC_API_KEY=<...> \
  node scripts/ingest.js
```

Expected output:
```
Ingestion complete in ~120.0s
  Posts:     ~1500
  Galleries: ~63
  Errors:    0
```

---

## Self-Review Against Spec

### Spec Coverage Check

| Spec Section | Covered By |
|---|---|
| 1.1 New Railway Service, stateless StreamableHTTP | Task 8 (index.js) |
| 1.2 Shared DB, altus_ prefix | Task 2 (altus-db.js) |
| 2. Environment variables | Task 1 (.env.example) |
| 3. Database schema (altus_content, altus_ingest_log, pgvector, IVFFlat) | Task 2 (altus-db.js) |
| 4.1 WP posts ingestion | Tasks 5, 9 (wp-client.js, ingest.js) |
| 4.2 NGG gallery endpoint (PHP) | Task 10 |
| 4.2 Gallery synthesis (Haiku) | Task 4 (synthesizer.js) |
| 4.3 Voyage AI embedding, batching, 200ms delay | Task 3 (voyage.js) |
| 4.4 Upsert with ON CONFLICT | Task 2 (altus-db.js) |
| 5. Ingestion script flow (full run) | Task 9 (scripts/ingest.js) |
| 5.2 Error handling, 429 backoff, fallback | Tasks 3, 4 (voyage.js, synthesizer.js) |
| 6.1 Server setup, safeToolHandler | Tasks 6, 8 |
| 6.2 search_altwire_archive tool + Zod schema | Tasks 7, 8 |
| 6.2 Return format (results, total_searched, query) | Task 7 (altus-search.js) |
| 7. File structure | All tasks |
| 8. Dependencies | Task 1 (package.json) |
| 9. Testing checklist | Tasks 2-7, 11 |
| 10. Known gotchas (stateless mode, voyage input_type, auth format) | Tasks 3, 8 |
| 12. Railway deployment | Task 12 |

**No gaps found.**

### Typo Fix

The test file uses `searchAltwareArchive` (with typo "ware") — the export in `handlers/altus-search.js` must match. Both use `searchAltwareArchive` consistently throughout Tasks 7. ✓

### Type Consistency

- `embedDocuments` returns `number[][]` or `{ error: string }` — callers in ingest.js and altus-search.js both check `?.error` before indexing. ✓
- `upsertContent` takes `embedding: number[]` and formats as `[${doc.embedding.join(',')}]` — this matches how altus-db.js receives it from voyage.js. ✓
- `initSchema()` is exported from `altus-db.js` and imported in both `index.js` and `scripts/ingest.js`. ✓
