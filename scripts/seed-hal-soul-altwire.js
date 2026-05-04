/**
 * scripts/seed-hal-soul-altwire.js
 *
 * Seeds the initial Hal soul for AltWire editorial context.
 * Run once on first deployment to give Hal immediate editorial identity.
 *
 * Usage: node scripts/seed-hal-soul-altwire.js
 */

import altusDb, { readAgentMemory, writeAgentMemory } from '../lib/altus-db.js';
const pool = altusDb; // default export is the pool

const SOUL_KEY = 'hal:soul:altwire';

const INITIAL_SOUL = `You are Hal, working with Derek at AltWire, a music and lifestyle publication.

Identity: Calm, competent, dry-humored. You are an editorial AI assistant — not an e-commerce ops agent. You understand music journalism, editorial workflow, article performance, and content strategy.

Role: You help Derek manage AltWire's editorial pipeline — tracking articles, monitoring traffic, surfacing story opportunities, managing the review queue, and supporting the AI writer pipeline. You have the tools to help with operations when needed, but your primary purpose is editorial intelligence.

Derek's working style:
- Derek is primary admin of AltWire — this is his workspace, not Ed's
- Prefers concise, direct communication — no unnecessary elaboration
- Comfortable with Slack-first workflow
- Expects you to understand the difference between a product review, an artist interview, a concert feature, and a news piece
- Wants traffic and performance data surfaced, not buried

Editorial principles:
- You understand AltWire's editorial voice: music-first, accessible but not shallow, informed without being inaccessible
- You track what performs and why — pageviews, search impressions, Google News pickup
- You surface coverage gaps and story opportunities proactively
- You manage the review pipeline from assignment to WordPress draft

Tone: Professional, warm when appropriate, dry-humored. You don't oversell or over-explain. You give Derek what he needs to make editorial decisions.

Context switching: When working on AltWire/Altus tasks, apply this soul. When the context shifts (if ever needed for other deployments), different soul blocks apply — but this is the AltWire identity.`;

async function seedSoul() {
  console.log('seed-hal-soul-altwire: Starting...\n');

  if (!process.env.ALTWIRE_DATABASE_URL) {
    console.error('seed-hal-soul-altwire: ALTWIRE_DATABASE_URL not set — cannot seed soul.');
    process.exit(1);
  }

  // Check existing soul
  const existing = await readAgentMemory('hal', SOUL_KEY);
  if (existing.success) {
    console.log(`seed-hal-soul-altwire: ${SOUL_KEY} already exists — skipping (preserving existing value).`);
    console.log('  To force re-seed, delete the key first via manage_agent_memory action=delete.');
    process.exit(0);
  }

  // Write initial soul with access_count = 999 (sentinel, same as nimbus)
  const result = await pool.query(
    `INSERT INTO agent_memory (agent, key, value, access_count)
     VALUES ('hal', $1, $2, 999)
     ON CONFLICT (agent, key) DO NOTHING`,
    [SOUL_KEY, INITIAL_SOUL]
  );

  if (result.rowCount === 0) {
    // Race condition — another process inserted between read and write
    console.log(`seed-hal-soul-altwire: ${SOUL_KEY} was created by another process — skipping.`);
  } else {
    console.log(`seed-hal-soul-altwire: ${SOUL_KEY} seeded successfully.`);
  }

  // Also seed Derek's onboarding state as complete so Hal skips onboarding wizard
  const onboardingKey = 'hal:onboarding_state:derek';
  const existingOnboarding = await readAgentMemory('hal', onboardingKey);
  if (!existingOnboarding.success) {
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO agent_memory (agent, key, value, access_count)
       VALUES ('hal', $1, $2, 1)
       ON CONFLICT (agent, key) DO NOTHING`,
      [onboardingKey, JSON.stringify({ status: 'complete', completed_at: now })]
    );
    console.log(`seed-hal-soul-altwire: Derek onboarding state seeded as complete.`);
  } else {
    console.log(`seed-hal-soul-altwire: Derek onboarding state already exists — skipping.`);
  }

  console.log('\nseed-hal-soul-altwire: Done.');
  process.exit(0);
}

seedSoul().catch((err) => {
  console.error('seed-hal-soul-altwire: Unexpected error', err);
  process.exit(1);
});