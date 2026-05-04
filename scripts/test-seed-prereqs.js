/**
 * scripts/test-seed-prereqs.js
 *
 * Validates that all prerequisites are in place before running:
 *   - seed-hal-soul-altwire.js
 *   - analyze-rag-corpus.js
 *
 * Run: node scripts/test-seed-prereqs.js
 *
 * Exits 0 if all checks pass, non-zero otherwise.
 */

import altusDb from '../lib/altus-db.js';
const { pool, readAgentMemory } = altusDb;

const CHECKS = [];

function check(name, pass, detail) {
  CHECKS.push({ name, pass, detail });
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`);
}

async function main() {
  console.log('=== AltWire Seed Prerequisite Checks ===\n');

  // 1. Environment variables
  console.log('-- Environment --');
  const dbUrl = !!process.env.ALTWIRE_DATABASE_URL;
  check('ALTWIRE_DATABASE_URL set', dbUrl);
  if (!dbUrl) console.log('  Will skip DB checks');

  const minimaxKey = !!process.env.MINIMAX_API_KEY;
  check('MINIMAX_API_KEY set', minimaxKey);
  if (!minimaxKey) console.log('  corpus analysis will only run Opus pass (skip Step 1b)');

  const anthropicKey = !!process.env.ANTHROPIC_API_KEY;
  check('ANTHROPIC_API_KEY set', anthropicKey);

  // 2. Database connectivity
  if (dbUrl) {
    console.log('\n-- Database --');
    try {
      const result = await pool.query('SELECT 1');
      check('PostgreSQL connection', result.rows.length === 1, 'pong');
    } catch (err) {
      check('PostgreSQL connection', false, err.message);
    }

    try {
      const result = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'altus_content' AND column_name = 'author'`
      );
      check('altus_content.author column exists', result.rows.length === 1);
    } catch (err) {
      check('altus_content.author column', false, err.message);
    }

    try {
      const result = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'agent_memory'`
      );
      check('agent_memory table exists', result.rows.length > 0);
    } catch (err) {
      check('agent_memory table', false, err.message);
    }
  }

  // 3. Model name validation
  console.log('\n-- Model Names --');
  const MINIMAX_MODEL = 'MiniMax-M2.7';
  const OPUS_MODEL = 'claude-opus-4-7';

  check('Minimax model name', MINIMAX_MODEL.startsWith('MiniMax'));
  check('Opus model name', OPUS_MODEL.startsWith('claude'));

  // 4. API key connectivity (if available)
  if (minimaxKey) {
    console.log('\n-- Minimax API --');
    try {
      const res = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`,
        },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          messages: [{ role: 'user', content: 'respond with exactly the word "ok"' }],
          max_tokens: 5,
        }),
      });
      check('Minimax API reachable', res.ok, `HTTP ${res.status}`);
    } catch (err) {
      check('Minimax API reachable', false, err.message);
    }
  }

  if (anthropicKey) {
    console.log('\n-- Anthropic API --');
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: OPUS_MODEL,
          messages: [{ role: 'user', content: 'respond with exactly the word "ok"' }],
          max_tokens: 5,
        }),
      });
      check('Anthropic API reachable', res.ok, `HTTP ${res.status}`);
    } catch (err) {
      check('Anthropic API reachable', false, err.message);
    }
  }

  // 5. Script syntax check
  console.log('\n-- Script Syntax --');
  try {
    await import('./seed-hal-soul-altwire.js');
    check('seed-hal-soul-altwire.js loads', true);
  } catch (err) {
    check('seed-hal-soul-altwire.js loads', false, err.message);
  }

  try {
    await import('./analyze-rag-corpus.js');
    check('analyze-rag-corpus.js loads', true);
  } catch (err) {
    check('analyze-rag-corpus.js loads', false, err.message);
  }

  // Summary
  console.log('\n-- Summary --');
  const failed = CHECKS.filter((c) => !c.pass);
  if (failed.length === 0) {
    console.log('All checks passed.');
  } else {
    console.log(`${failed.length} check(s) failed:`);
    failed.forEach((f) => console.log(`  - ${f.name}`));
  }

  if (pool) await pool.end().catch(() => {});
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('test-seed-prereqs: Unexpected error', err);
  process.exit(1);
});
