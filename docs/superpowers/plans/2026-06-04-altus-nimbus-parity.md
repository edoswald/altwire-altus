# Altus Nimbus Hal Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `altwire-altus` to feature and bugfix parity with the non-WooCommerce, non-CW shared-Hal layer in `cirrusly-nimbus` so AltWire admins can use Hal without regressions.

**Architecture:** Use Nimbus as the reference implementation for shared Hal capabilities, but port behavior instead of blindly copying files. Start by creating a parity matrix and locking the `must-port` list. Then implement parity in focused slices: registration/scoping guardrails, action-item and scheduled-task infrastructure, session trace visibility, shared research and skill surfaces, and finally gray-area tools that survive classification.

**Tech Stack:** Node.js, MCP SDK, Zod, Vitest, PostgreSQL-backed state helpers, cron-driven background jobs, Altus event log and memory helpers.

---

### Task 1: Build The Parity Matrix And Lock Scope

**Files:**
- Create: `docs/parity/altus-nimbus-parity-matrix.md`
- Inspect: `index.js`
- Inspect: `handlers/altus-heartbeat.js`
- Inspect: `handlers/altus-onboarding.js`
- Inspect: `handlers/altus-memory-scope.js`
- Inspect: `handlers/altus-reflection.js`
- Inspect: `altus-event-log.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/index.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-action-items.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-task-queue.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-session-traces.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-skill-library.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-web-research.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-topic-synthesis.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-commitments.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-document.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-documents.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-chat-history.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-chat-presence.js`
- Inspect: `/Users/edoswald/Dev/cirrusly-nimbus/hal-autonomy-policy.js`

- [ ] **Step 1: Create the matrix document with explicit parity columns**

Create `docs/parity/altus-nimbus-parity-matrix.md`:

```md
# Altus Nimbus Parity Matrix

| Capability | Nimbus Files | Altus Files | Status | Classification | Admin Risk If Missing | Notes |
| --- | --- | --- | --- | --- | --- | --- |
```

- [ ] **Step 2: Capture the real Altus tool surface**

Run: `rg -n "scopedRegister\\(" /Users/edoswald/Dev/altwire-altus/index.js`
Expected: a complete list of Altus registrations driven by `scopedRegister()`.

Then record the shared-Hal-relevant families already present:

```md
| memory tools | n/a | index.js, handlers/hal-memory.js, handlers/altus-memory-scope.js | present | baseline | high | shared memory surface already exists in Altus |
| onboarding | hal-onboarding.js | index.js, handlers/altus-onboarding.js | present | baseline | high | Altus already has multi-admin onboarding |
| heartbeat scheduling | hal-heartbeat.js, hal-task-queue.js | handlers/altus-heartbeat.js | partial | must-port | high | Altus has scheduling but not full queue/action-item parity |
| event/audit log | hal-event-log.js | altus-event-log.js | partial | must-port | high | Altus has audit visibility but not dedicated session trace surface |
```

- [ ] **Step 3: Capture the Nimbus shared-Hal surface**

Run: `rg --files /Users/edoswald/Dev/cirrusly-nimbus | rg '/hal-.*\\.js$|^/Users/edoswald/Dev/cirrusly-nimbus/hal-.*\\.js$'`
Expected: a list of Nimbus shared-Hal modules.

Append the first-pass candidates:

```md
| hal-action-items | hal-action-items.js | handlers/altus-heartbeat.js | partial | must-port | high | action-item lifecycle exists in data model but not in a dedicated module/tool surface |
| hal-task-queue | hal-task-queue.js | handlers/altus-heartbeat.js | partial | must-port | high | queue semantics are mixed into heartbeat today |
| hal-session-traces | hal-session-traces.js | altus-event-log.js | partial | must-port | high | Altus has event log but no session-trace module |
| hal-skill-library | hal-skill-library.js | none | absent | must-port | medium | generic Hal skill storage/search is missing |
| hal-web-research | hal-web-research.js | none | absent | must-port | medium | Altus has editorial research flows but no generic shared-Hal web research tool |
| hal-topic-synthesis | hal-topic-synthesis.js | handlers/altus-topic-discovery.js | partial | adapt-for-altwire | medium | likely editorialized rather than copied verbatim |
| hal-commitments | hal-commitments.js | handlers/altus-weekly-brief.js | partial | adapt-for-altwire | medium | commitment/watch concepts already appear in weekly brief output |
| hal-document / hal-documents | hal-document.js, hal-documents.js | none | absent | review | low | determine whether generic doc generation matters for AltWire admins |
| hal-chat-history | hal-chat-history.js | SSE/session code in index.js | partial | review | medium | session plumbing exists but not shared history persistence |
| hal-chat-presence | hal-chat-presence.js | SSE/session code in index.js | partial | review | low | likely useful, but admin impact may be limited |
| hal-autonomy-policy | hal-autonomy-policy.js | client/tool restrictions in index.js | partial | review | medium | verify whether Altus needs explicit policy tooling or current gating is enough |
```

- [ ] **Step 4: Review recent Nimbus bugfix commits and classify them**

Run:

```bash
git -C /Users/edoswald/Dev/cirrusly-nimbus show --stat c9e97c7
git -C /Users/edoswald/Dev/cirrusly-nimbus show --stat 0ee78a9
git -C /Users/edoswald/Dev/cirrusly-nimbus show --stat b9295b6
git -C /Users/edoswald/Dev/cirrusly-nimbus show --stat c8c22be
git -C /Users/edoswald/Dev/cirrusly-nimbus show --stat e4283cf
```

Expected: enough context to mark each change as `shared`, `adapt-for-altwire`, or `nimbus-only`.

Append:

```md
## Recent Fix Review

- `c9e97c7`: classify the heartbeat skip-routing change and record the exact Altus port/no-port decision.
- `0ee78a9`: classify the inbox split audit coverage change and record the exact Altus port/no-port decision.
- `b9295b6`: classify the batch reflection processing change and record the exact Altus port/no-port decision.
- `c8c22be`: classify the SES inbox classification change and record whether any shared ingestion logic exists in Altus.
- `e4283cf`: classify the guided digest composition change and record whether it belongs in Altus as an editorial admin workflow.
```

- [ ] **Step 5: Commit the scope lock**

```bash
git add docs/parity/altus-nimbus-parity-matrix.md
git commit -m "docs: add Altus Nimbus parity matrix"
```

### Task 2: Add Registration And Scoping Guardrails

**Files:**
- Create: `tests/altus-tool-registry-parity.unit.test.js`
- Create: `tests/altus-memory-scope-parity.unit.test.js`
- Modify: `handlers/altus-memory-scope.js`
- Reference: `/Users/edoswald/Dev/cirrusly-nimbus/tests/tool-registry.property.test.js`
- Reference: `/Users/edoswald/Dev/cirrusly-nimbus/tests/hal-scoping.unit.test.js`

- [ ] **Step 1: Write the failing tool registry parity test**

Create `tests/altus-tool-registry-parity.unit.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function extractScopedToolNames(source) {
  return [...source.matchAll(/scopedRegister\\(\\s*'([^']+)'/g)].map(match => match[1]);
}

describe('Altus shared Hal registry parity', () => {
  it('retains the baseline shared Hal tools already expected in Altus', () => {
    const names = new Set(extractScopedToolNames(indexSource));

    expect(names.has('hal_read_memory')).toBe(true);
    expect(names.has('query_altus_events')).toBe(true);
    expect(names.has('get_altus_audit_log')).toBe(true);
    expect(names.has('altus_check_onboarding_status')).toBe(true);
    expect(names.has('schedule_altus_task')).toBe(true);
    expect(names.has('list_altus_scheduled_tasks')).toBe(true);
    expect(names.has('cancel_altus_scheduled_task')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new registry test**

Run: `npm test -- tests/altus-tool-registry-parity.unit.test.js`
Expected: PASS for the current baseline. If it fails, fix the extraction or assertions before continuing.

- [ ] **Step 3: Write the failing memory scope parity test**

Create `tests/altus-memory-scope-parity.unit.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { classifyKey, transformKey, stripPrefix } from '../handlers/altus-memory-scope.js';

describe('Altus memory scope parity', () => {
  it('keeps shared Hal prefixes shared', () => {
    expect(classifyKey('hal:soul')).toBe('shared');
    expect(classifyKey('hal:altwire:editorial_context')).toBe('shared');
    expect(classifyKey('reflection:combined')).toBe('shared');
  });

  it('scopes admin-specific keys to the admin namespace', () => {
    expect(transformKey('42', 'notes:session')).toBe('altus:mem:42:notes:session');
    expect(stripPrefix('42', 'altus:mem:42:notes:session')).toBe('notes:session');
  });
});
```

- [ ] **Step 4: Run the memory-scope test and then extend shared prefixes if Nimbus requires it**

Run: `npm test -- tests/altus-memory-scope-parity.unit.test.js`
Expected: PASS or a focused failure that shows which prefix behavior diverges.

If the matrix review identifies missing shared prefixes, update `handlers/altus-memory-scope.js` like this:

```js
export const SHARED_PREFIXES = [
  'altus:soul',
  'altus:perch_agenda',
  'altus:heartbeat:',
  'hal:altwire:',
  'hal:soul',
  'hal:perch_agenda',
  'reflection:',
  'prediction:',
];
```

- [ ] **Step 5: Commit the guardrails**

```bash
git add tests/altus-tool-registry-parity.unit.test.js tests/altus-memory-scope-parity.unit.test.js handlers/altus-memory-scope.js
git commit -m "test: add Altus shared Hal parity guardrails"
```

### Task 3: Extract Action-Item And Scheduled-Task Parity Into A Real Altus Module

**Files:**
- Create: `handlers/altus-action-items.js`
- Modify: `handlers/altus-heartbeat.js`
- Modify: `index.js`
- Create: `tests/altus-action-items.unit.test.js`
- Reference: `/Users/edoswald/Dev/cirrusly-nimbus/hal-action-items.js`
- Reference: `/Users/edoswald/Dev/cirrusly-nimbus/tests/hal-action-items.unit.test.js`

- [ ] **Step 1: Write the failing action-item tests**

Create `tests/altus-action-items.unit.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: { query: vi.fn(), connect: vi.fn() },
}));

import pool from '../lib/altus-db.js';
import { listActionItems, manageActionItem } from '../handlers/altus-action-items.js';

describe('Altus action-item parity module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
  });

  it('returns not_found when manageActionItem cannot find an item', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await manageActionItem({ item_id: 999, action: 'accept' });
    expect(result.success).toBe(false);
    expect(result.exit_reason).toBe('not_found');
  });

  it('lists proposed items by default', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'proposed' }] });
    const result = await listActionItems();
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the new action-item test**

Run: `npm test -- tests/altus-action-items.unit.test.js`
Expected: FAIL because the module does not exist yet.

- [ ] **Step 3: Create `handlers/altus-action-items.js` by moving stateful action-item behavior out of heartbeat**

Create `handlers/altus-action-items.js`:

```js
import pool from '../lib/altus-db.js';
import { logger } from '../logger.js';

export async function initActionItemsSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS altus_action_items (
        id              SERIAL PRIMARY KEY,
        title           VARCHAR(200)  NOT NULL,
        description     TEXT          NOT NULL,
        category        VARCHAR(20)   NOT NULL
                        CHECK (category IN ('marketing', 'operations', 'pricing', 'quality', 'infrastructure', 'editorial')),
        signal_source   VARCHAR(100)  NOT NULL,
        signal_data     TEXT,
        proposed_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        status          VARCHAR(20)   NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed', 'accepted', 'completed', 'dismissed')),
        accepted_at     TIMESTAMPTZ,
        completed_at    TIMESTAMPTZ,
        dismissed_at    TIMESTAMPTZ,
        dismiss_reason  TEXT,
        outcome_notes   TEXT,
        reflection_date DATE          NOT NULL
      )
    `);
    logger.info('initActionItemsSchema: altus_action_items table ready');
  } finally {
    client.release();
  }
}

export async function listActionItems({ status = 'proposed', category, limit = 20 } = {}) {
  const conditions = ['status = $1'];
  const params = [status];
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  params.push(Math.min(Math.max(limit, 1), 100));
  const sql = `SELECT * FROM altus_action_items WHERE ${conditions.join(' AND ')} ORDER BY proposed_at DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return { success: true, items: rows, count: rows.length };
}

export async function manageActionItem({ item_id, action, reason, outcome_notes } = {}) {
  const current = await pool.query('SELECT * FROM altus_action_items WHERE id = $1', [item_id]);
  if (current.rows.length === 0) return { success: false, exit_reason: 'not_found' };
  return { success: true, item: current.rows[0], action, reason, outcome_notes };
}
```

- [ ] **Step 4: Update heartbeat to import the module instead of owning the schema**

In `handlers/altus-heartbeat.js`, remove the local `initActionItemsSchema()` definition and use imports from `./altus-action-items.js` for any shared action-item helpers needed by the heartbeat.

Use this import shape:

```js
import { listActionItems, manageActionItem } from './altus-action-items.js';
```

- [ ] **Step 5: Register explicit admin-facing parity tools in `index.js`**

Add tool registrations alongside the other shared Hal admin tools:

```js
scopedRegister(
  'altus_list_action_items',
  {
    description: 'List Altus action items for admin follow-through and heartbeat review.',
    inputSchema: {
      status: z.string().optional(),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ status, category, limit }) => ({ content: [{ type: 'text', text: JSON.stringify(await listActionItems({ status, category, limit })) }] }),
);
```

```js
scopedRegister(
  'altus_manage_action_item',
  {
    description: 'Accept, complete, or dismiss an Altus action item.',
    inputSchema: {
      item_id: z.number().int(),
      action: z.enum(['accept', 'complete', 'dismiss']),
      reason: z.string().optional(),
      outcome_notes: z.string().optional(),
    },
  },
  async ({ item_id, action, reason, outcome_notes }) => ({ content: [{ type: 'text', text: JSON.stringify(await manageActionItem({ item_id, action, reason, outcome_notes })) }] }),
);
```

- [ ] **Step 6: Re-run the focused tests**

Run:

```bash
npm test -- tests/altus-action-items.unit.test.js tests/altus-tool-registry-parity.unit.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit the extraction**

```bash
git add handlers/altus-action-items.js handlers/altus-heartbeat.js index.js tests/altus-action-items.unit.test.js tests/altus-tool-registry-parity.unit.test.js
git commit -m "feat: add Altus action-item parity module"
```

### Task 4: Add Session Trace Parity On Top Of The Existing Event Log

**Files:**
- Create: `handlers/altus-session-traces.js`
- Modify: `index.js`
- Create: `tests/altus-session-traces.unit.test.js`
- Reference: `/Users/edoswald/Dev/cirrusly-nimbus/hal-session-traces.js`
- Reference: `/Users/edoswald/Dev/cirrusly-nimbus/tests/hal-session-traces.unit.test.js`

- [ ] **Step 1: Write the failing session-trace tests**

Create `tests/altus-session-traces.unit.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: { query: vi.fn() },
}));

import pool from '../lib/altus-db.js';
import { querySessionTraces } from '../handlers/altus-session-traces.js';

describe('Altus session trace parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
  });

  it('returns not_found for a missing session trace lookup', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await querySessionTraces({ session_id: 999 });
    expect(result.success).toBe(false);
    expect(result.exit_reason).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/altus-session-traces.unit.test.js`
Expected: FAIL because the module does not exist yet.

- [ ] **Step 3: Create `handlers/altus-session-traces.js` as a real adapter over `altus_events`**

Create:

```js
import pool from '../lib/altus-db.js';

export async function querySessionTraces({ session_id, limit = 50 } = {}) {
  if (!process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }

  if (session_id) {
    const { rows } = await pool.query(
      `SELECT * FROM altus_events WHERE session_id = $1 ORDER BY created_at ASC`,
      [session_id],
    );
    if (rows.length === 0) return { success: false, exit_reason: 'not_found' };
    return { success: true, events: rows, count: rows.length };
  }

  const { rows } = await pool.query(
    `SELECT session_id, COUNT(*)::int AS event_count, MAX(created_at) AS last_seen
       FROM altus_events
      WHERE session_id IS NOT NULL
      GROUP BY session_id
      ORDER BY last_seen DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 100)],
  );
  return { success: true, traces: rows, count: rows.length };
}
```

- [ ] **Step 4: Register the session trace tool**

Add to `index.js`:

```js
scopedRegister(
  'altus_get_session_trace',
  {
    description: 'Inspect Altus session traces derived from the event log.',
    inputSchema: {
      session_id: z.number().int().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ session_id, limit }) => ({ content: [{ type: 'text', text: JSON.stringify(await querySessionTraces({ session_id, limit })) }] }),
);
```

- [ ] **Step 5: Re-run the trace and registry tests**

Run:

```bash
npm test -- tests/altus-session-traces.unit.test.js tests/altus-tool-registry-parity.unit.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add handlers/altus-session-traces.js index.js tests/altus-session-traces.unit.test.js tests/altus-tool-registry-parity.unit.test.js
git commit -m "feat: add Altus session trace parity surface"
```

### Task 5: Add Shared Web Research And Topic Synthesis Parity

**Files:**
- Create: `handlers/altus-web-research.js`
- Create: `handlers/altus-topic-synthesis.js`
- Modify: `index.js`
- Create: `tests/altus-web-research.unit.test.js`
- Create: `tests/altus-topic-synthesis.unit.test.js`
- Inspect: `handlers/altwire-search.js`
- Inspect: `handlers/altus-topic-discovery.js`
- Reference: `/Users/edoswald/Dev/cirrusly-nimbus/hal-web-research.js`
- Reference: `/Users/edoswald/Dev/cirrusly-nimbus/hal-topic-synthesis.js`

- [ ] **Step 1: Write failing research and synthesis tests**

Create `tests/altus-web-research.unit.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { isPrivateUrl, isBinaryUrl } from '../handlers/altus-web-research.js';

describe('Altus web research parity helpers', () => {
  it('blocks private URLs', () => {
    expect(isPrivateUrl('http://localhost:3000')).toBe(true);
    expect(isPrivateUrl('https://example.com')).toBe(false);
  });

  it('detects binary targets', () => {
    expect(isBinaryUrl('https://example.com/report.pdf')).toBe(true);
    expect(isBinaryUrl('https://example.com/post')).toBe(false);
  });
});
```

Create `tests/altus-topic-synthesis.unit.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildTopicSynthesisPrompt } from '../handlers/altus-topic-synthesis.js';

describe('Altus topic synthesis parity', () => {
  it('keeps the AltWire editorial framing in the synthesis prompt', () => {
    const prompt = buildTopicSynthesisPrompt({ topic: 'AI and indie music publishing', findings: ['a', 'b'] });
    expect(prompt).toContain('AltWire');
    expect(prompt).toContain('editorial');
  });
});
```

- [ ] **Step 2: Run the tests**

Run:

```bash
npm test -- tests/altus-web-research.unit.test.js tests/altus-topic-synthesis.unit.test.js
```

Expected: FAIL because the files do not exist yet.

- [ ] **Step 3: Port the reusable web-research helpers and wire them to Altus search/fetch**

Create `handlers/altus-web-research.js`:

```js
import { searchAltwirePublic } from './altwire-search.js';

const BINARY_EXTENSIONS = ['.pdf', '.zip', '.exe', '.dmg', '.iso', '.tar', '.gz'];

export function isPrivateUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
  } catch {
    return false;
  }
}

export function isBinaryUrl(url) {
  const lower = (url || '').toLowerCase();
  return BINARY_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export async function altusWebResearch({ query, limit = 5 } = {}) {
  const result = await searchAltwirePublic({ query, limit });
  return { success: true, query, results: result.results ?? [], count: result.results?.length ?? 0 };
}
```

- [ ] **Step 4: Create the AltWire-adapted topic synthesis helper**

Create `handlers/altus-topic-synthesis.js`:

```js
export function buildTopicSynthesisPrompt({ topic, findings }) {
  const items = Array.isArray(findings) ? findings.join('\n- ') : '';
  return `You are Altus for AltWire, an editorial admin assistant.\nSynthesize the following findings into an editorial briefing for topic: ${topic}\n- ${items}`;
}

export async function synthesizeTopic({ topic, findings }) {
  return {
    success: true,
    topic,
    prompt: buildTopicSynthesisPrompt({ topic, findings }),
  };
}
```

- [ ] **Step 5: Register the tools**

Add to `index.js`:

```js
scopedRegister(
  'altus_web_research',
  {
    description: 'Perform shared Hal-style web research for AltWire admin questions.',
    inputSchema: {
      query: z.string(),
      limit: z.number().int().min(1).max(10).optional(),
    },
  },
  async ({ query, limit }) => ({ content: [{ type: 'text', text: JSON.stringify(await altusWebResearch({ query, limit })) }] }),
);
```

```js
scopedRegister(
  'altus_topic_synthesis',
  {
    description: 'Synthesize research findings into an AltWire editorial briefing.',
    inputSchema: {
      topic: z.string(),
      findings: z.array(z.string()),
    },
  },
  async ({ topic, findings }) => ({ content: [{ type: 'text', text: JSON.stringify(await synthesizeTopic({ topic, findings })) }] }),
);
```

- [ ] **Step 6: Re-run the tests**

Run:

```bash
npm test -- tests/altus-web-research.unit.test.js tests/altus-topic-synthesis.unit.test.js tests/altus-tool-registry-parity.unit.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add handlers/altus-web-research.js handlers/altus-topic-synthesis.js index.js tests/altus-web-research.unit.test.js tests/altus-topic-synthesis.unit.test.js tests/altus-tool-registry-parity.unit.test.js
git commit -m "feat: add Altus shared research parity tools"
```

### Task 6: Port The Shared Skill Library Surface

**Files:**
- Create: `handlers/altus-skill-library.js`
- Modify: `index.js`
- Create: `tests/altus-skill-library.unit.test.js`
- Reference: `/Users/edoswald/Dev/cirrusly-nimbus/hal-skill-library.js`
- Reference: `/Users/edoswald/Dev/cirrusly-nimbus/tests/hal-skill-library.unit.test.js`

- [ ] **Step 1: Write the failing skill-library test**

Create `tests/altus-skill-library.unit.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: { query: vi.fn() },
}));

import pool from '../lib/altus-db.js';
import { searchSkills } from '../handlers/altus-skill-library.js';

describe('Altus skill library parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
  });

  it('returns config_error when the database is unavailable', async () => {
    delete process.env.DATABASE_URL;
    const result = await searchSkills({ query: 'seo' });
    expect(result.success).toBe(false);
    expect(result.exit_reason).toBe('config_error');
  });

  it('returns rows from the local skill library', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ name: 'seo-brief', title: 'SEO Brief' }] });
    const result = await searchSkills({ query: 'seo' });
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- tests/altus-skill-library.unit.test.js`
Expected: FAIL because the module does not exist yet.

- [ ] **Step 3: Create the Altus skill-library module**

Create `handlers/altus-skill-library.js`:

```js
import pool from '../lib/altus-db.js';

export async function initSkillLibrarySchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_skills (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      source VARCHAR(20) NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )
  `);
}

export async function searchSkills({ query, limit = 10 } = {}) {
  if (!process.env.DATABASE_URL) return { success: false, exit_reason: 'config_error' };
  const { rows } = await pool.query(
    `SELECT name, title, description, tags, source
       FROM altus_skills
      WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR title ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
      ORDER BY name ASC
      LIMIT $2`,
    [query || null, Math.min(Math.max(limit, 1), 50)],
  );
  return { success: true, skills: rows, count: rows.length };
}
```

- [ ] **Step 4: Register the initial skill tools**

Add to `index.js`:

```js
scopedRegister(
  'altus_search_skills',
  {
    description: 'Search Altus shared skills for reusable admin workflows.',
    inputSchema: {
      query: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async ({ query, limit }) => ({ content: [{ type: 'text', text: JSON.stringify(await searchSkills({ query, limit })) }] }),
);
```

This first pass only needs `search` parity. Add `read` and `list` in the same module if the matrix classifies them as `must-port`.

- [ ] **Step 5: Re-run the test**

Run:

```bash
npm test -- tests/altus-skill-library.unit.test.js tests/altus-tool-registry-parity.unit.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add handlers/altus-skill-library.js index.js tests/altus-skill-library.unit.test.js tests/altus-tool-registry-parity.unit.test.js
git commit -m "feat: add Altus shared skill library parity"
```

### Task 7: Resolve The Gray-Area Tools And Close The Loop

**Files:**
- Modify: `docs/parity/altus-nimbus-parity-matrix.md`
- Modify: `index.js`
- Optionally Create: `handlers/altus-commitments.js`
- Optionally Create: `handlers/altus-documents.js`
- Optionally Create: `handlers/altus-chat-history.js`
- Optionally Create: `tests/altus-commitments.unit.test.js`
- Optionally Create: `tests/altus-documents.unit.test.js`
- Optionally Create: `tests/altus-chat-history.unit.test.js`

- [ ] **Step 1: Finalize the classification rows for gray-area tools**

Update the matrix so each of these ends in exactly one bucket:

```md
- hal-commitments
- hal-document / hal-documents
- hal-chat-history
- hal-chat-presence
- hal-autonomy-policy
```

Expected: no remaining `review` rows in the matrix.

- [ ] **Step 2: Implement only the tools that the matrix marks `must-port` or `adapt-for-altwire`**

If `hal-commitments` is approved, create `handlers/altus-commitments.js`:

```js
export async function listCommitments() {
  return { success: true, commitments: [] };
}
```

If `hal-document / hal-documents` is approved, create `handlers/altus-documents.js`:

```js
export async function listGeneratedDocuments() {
  return { success: true, documents: [] };
}
```

If `hal-chat-history` is approved, create `handlers/altus-chat-history.js`:

```js
export async function getChatHistory() {
  return { success: true, messages: [] };
}
```

For each approved tool, add the matching `scopedRegister()` block and a focused Vitest file before moving on.

- [ ] **Step 3: Run the parity-focused suite**

Run:

```bash
npm test -- \
  tests/altus-tool-registry-parity.unit.test.js \
  tests/altus-memory-scope-parity.unit.test.js \
  tests/altus-action-items.unit.test.js \
  tests/altus-session-traces.unit.test.js \
  tests/altus-web-research.unit.test.js \
  tests/altus-topic-synthesis.unit.test.js \
  tests/altus-skill-library.unit.test.js
```

Expected: PASS.

- [ ] **Step 4: Run the nearby Altus regression tests**

Run:

```bash
npm test -- \
  tests/altus-mountaineering.unit.test.js \
  tests/ai-cost-tracker.unit.test.js \
  tests/safe-tool-handler.test.js
```

Expected: PASS.

- [ ] **Step 5: Update the matrix to final state**

Every row in `docs/parity/altus-nimbus-parity-matrix.md` must end with:

```md
Status: present | intentionally skipped
Classification: must-port | adapt-for-altwire | do-not-port
Notes: concrete explanation
```

- [ ] **Step 6: Commit the parity pass**

```bash
git add docs/parity/altus-nimbus-parity-matrix.md index.js handlers tests
git commit -m "feat: align Altus shared Hal parity with Nimbus"
```

### Task 8: Harden And Complete Altus-Only Tools

**Files:**
- Modify: `handlers/altus-link-evaluator.js`
- Modify: `handlers/altus-reingest.js`
- Modify: `handlers/altus-fetch.js`
- Modify: `handlers/altus-editorial-tools.js`
- Modify: `index.js`
- Create: `tests/altus-link-evaluator.unit.test.js`
- Create: `tests/altus-reingest.unit.test.js`
- Create: `tests/altus-fetch.unit.test.js`
- Create: `tests/altus-editorial-tools.unit.test.js`
- Create: `tests/get-writer-summary.unit.test.js`

- [ ] **Step 1: Write the failing SSRF safety tests for `evaluate_link_fitness`**

Create `tests/altus-link-evaluator.unit.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { isPrivateUrl } from '../handlers/altus-web-research.js';

describe('Altus link evaluator hardening', () => {
  it('treats localhost and private network targets as blocked', () => {
    expect(isPrivateUrl('http://localhost:3000')).toBe(true);
    expect(isPrivateUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isPrivateUrl('http://192.168.1.10')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the link evaluator test and then block private URLs in the handler**

Run: `npm test -- tests/altus-link-evaluator.unit.test.js`
Expected: FAIL until the hardening is wired through.

Then update `handlers/altus-link-evaluator.js` so `evaluateLinkFitness()` rejects private or localhost URLs before `fetch(url)` is attempted. Reuse the same URL-classification behavior used by `handlers/altus-web-research.js`.

- [ ] **Step 3: Write the failing reingest mode test**

Create `tests/altus-reingest.unit.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';

const fetchAllPosts = vi.fn();
const fetchAllGalleries = vi.fn();

vi.mock('../lib/wp-client.js', () => ({
  fetchAllPosts,
  fetchAllGalleries,
}));

vi.mock('../lib/altus-db.js', () => ({
  upsertContent: vi.fn(),
  logIngestRun: vi.fn(),
}));

describe('Altus reingest mode behavior', () => {
  it('uses the recent window consistently when mode is recent', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    fetchAllPosts.mockResolvedValue([]);
    fetchAllGalleries.mockResolvedValue([]);
    const { reIngestHandler } = await import('../handlers/altus-reingest.js');
    await reIngestHandler({ mode: 'recent', dry_run: true });
    expect(fetchAllPosts).toHaveBeenCalledTimes(1);
    expect(fetchAllGalleries).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 4: Run the reingest test and fix the mode mismatch**

Run: `npm test -- tests/altus-reingest.unit.test.js`
Expected: FAIL or expose that gallery fetch ignores the recent window.

Then update `handlers/altus-reingest.js` so the recent-mode contract is honest. Either:
- pass an equivalent window into gallery fetches if the fetch layer supports it, or
- explicitly branch the handler so `recent` mode skips full gallery reingest and reports that behavior in the return payload.

- [ ] **Step 5: Write the failing deterministic content fetch test**

Create `tests/altus-fetch.unit.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  default: { query: vi.fn() },
}));

import pool from '../lib/altus-db.js';
import { getContentByUrl } from '../handlers/altus-fetch.js';

describe('Altus content fetch determinism', () => {
  it('returns not found rather than an arbitrary fuzzy slug match when multiple rows compete', async () => {
    process.env.DATABASE_URL = 'postgres://test';
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ slug: 'foo' }, { slug: 'foo-bar' }] });

    const result = await getContentByUrl({ slug: 'foo' });

    expect(result.found).toBe(false);
  });
});
```

- [ ] **Step 6: Run the content fetch test and make the fallback deterministic**

Run: `npm test -- tests/altus-fetch.unit.test.js`
Expected: FAIL because the current fallback can return an arbitrary match.

Then update `handlers/altus-fetch.js` so the fuzzy fallback is deterministic and safe. Preferred behavior:
- exact slug hit wins
- single fuzzy candidate may be returned
- multiple fuzzy candidates should return `found: false` with an `ambiguous_match` reason instead of picking one by accident

- [ ] **Step 7: Write the failing editorial-tools totals test**

Create `tests/altus-editorial-tools.unit.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  readAgentMemory: vi.fn(),
  writeAgentMemory: vi.fn(),
  pool: { query: vi.fn() },
}));

import { pool } from '../lib/altus-db.js';
import { listTrackedArticles, getContentIdeas } from '../handlers/altus-editorial-tools.js';

describe('Altus editorial tool list semantics', () => {
  it('does not label a limited page size as the true total', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ key: 'a' }, { key: 'b' }] });
    const result = await listTrackedArticles({ limit: 2 });
    expect(result.returned ?? result.total).toBe(2);
  });

  it('returns returned-count metadata for content ideas', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ key: 'idea-1' }] });
    const result = await getContentIdeas({ limit: 1 });
    expect(result.returned ?? result.total).toBe(1);
  });
});
```

- [ ] **Step 8: Run the editorial-tools test and fix list metadata**

Run: `npm test -- tests/altus-editorial-tools.unit.test.js`
Expected: FAIL or reveal misleading `total` semantics.

Then update `handlers/altus-editorial-tools.js` so list tools return unambiguous pagination metadata, such as:

```js
return { success: true, articles, returned: rows.length };
```

and

```js
return { success: true, ideas, returned: rows.length };
```

Do not report `total` unless you also run a real count query.

- [ ] **Step 9: Write the failing writer-summary degradation test**

Create `tests/get-writer-summary.unit.test.js` that parses `index.js` source and asserts the summary surface reports degraded upstream dependencies instead of silently zeroing them out.

Use this shape:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

describe('writer summary resilience', () => {
  it('includes a degraded/warnings surface for non-blocking upstream failures', () => {
    expect(indexSource.includes('writer_summary_warnings')).toBe(true);
  });
});
```

- [ ] **Step 10: Run the writer-summary test and expose degradation honestly**

Run: `npm test -- tests/get-writer-summary.unit.test.js`
Expected: FAIL until the summary exposes degradation state.

Then update the `get_writer_summary` tool in `index.js` so Matomo, GSC, and digest failures are surfaced explicitly in the payload rather than silently converted into healthy-looking zeros. A minimal acceptable shape is:

```js
writer_summary_warnings: [
  { source: 'matomo', error: '...' },
  { source: 'gsc', error: '...' },
]
```

- [ ] **Step 11: Re-run the new custom-tool hardening suite**

Run:

```bash
npm test -- \
  tests/altus-link-evaluator.unit.test.js \
  tests/altus-reingest.unit.test.js \
  tests/altus-fetch.unit.test.js \
  tests/altus-editorial-tools.unit.test.js \
  tests/get-writer-summary.unit.test.js
```

Expected: PASS.

- [ ] **Step 12: Commit the Altus-only hardening pass**

```bash
git add handlers/altus-link-evaluator.js handlers/altus-reingest.js handlers/altus-fetch.js handlers/altus-editorial-tools.js index.js tests/altus-link-evaluator.unit.test.js tests/altus-reingest.unit.test.js tests/altus-fetch.unit.test.js tests/altus-editorial-tools.unit.test.js tests/get-writer-summary.unit.test.js
git commit -m "fix: harden Altus-only tool surfaces"
```

### Task 9: Raise Coverage For Custom Altus Tools

**Files:**
- Create: `tests/altus-digest.unit.test.js`
- Create: `tests/altus-monitoring.unit.test.js`
- Create: `tests/altus-coverage.unit.test.js`
- Create: `tests/altus-author-profile.unit.test.js`
- Modify: `docs/parity/altus-nimbus-parity-matrix.md`

- [ ] **Step 1: Create a coverage inventory table in the matrix**

Append to `docs/parity/altus-nimbus-parity-matrix.md`:

```md
## Altus-Only Coverage Inventory

| Tool Family | Handler | Focused Tests Present | Gaps |
| --- | --- | --- | --- |
```

Then populate at least:
- `altus-link-evaluator`
- `altus-reingest`
- `altus-fetch`
- `altus-editorial-tools`
- `get_writer_summary`
- `altus-digest`
- `altus-monitoring`
- `author profile tools`

- [ ] **Step 2: Add digest tests**

Create `tests/altus-digest.unit.test.js` to cover:
- `TEST_MODE` canned response
- graceful parsing of missing story-opportunity/news-alert memory
- warnings array population when one section fails

- [ ] **Step 3: Add monitoring tests**

Create `tests/altus-monitoring.unit.test.js` to cover:
- `TEST_MODE`
- missing `BETTER_STACK_TOKEN`
- non-200 API behavior mapping to structured errors

- [ ] **Step 4: Add coverage-analysis tests**

Create `tests/altus-coverage.unit.test.js` to cover:
- `coverage_status` classification thresholds
- behavior when archive search returns no rows
- output shape for direct vs related coverage

- [ ] **Step 5: Add author-profile tests**

Create `tests/altus-author-profile.unit.test.js` to cover:
- `get_author_profile` returning the current editorial profile
- `update_author_profile` rejecting invalid field paths
- `update_author_profile` persisting allowed field-path updates

These tests may exercise the tool behavior through source parsing plus extracted helper logic, or by extracting the author-profile logic into a dedicated handler if that is the cleaner seam.

- [ ] **Step 6: Run the expanded custom-tool coverage suite**

Run:

```bash
npm test -- \
  tests/altus-digest.unit.test.js \
  tests/altus-monitoring.unit.test.js \
  tests/altus-coverage.unit.test.js \
  tests/altus-author-profile.unit.test.js \
  tests/altus-link-evaluator.unit.test.js \
  tests/altus-reingest.unit.test.js \
  tests/altus-fetch.unit.test.js \
  tests/altus-editorial-tools.unit.test.js \
  tests/get-writer-summary.unit.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit the coverage expansion**

```bash
git add tests docs/parity/altus-nimbus-parity-matrix.md
git commit -m "test: expand coverage for Altus-only tools"
```

### Task 10: Make `hal-chat-ui` Admin-Testable For Mixed Hal And Altus Rollout

**Files To Inspect And Likely Modify:**
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/App.tsx`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/context/ModeContext.tsx`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/hooks/useAuth.ts`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/hooks/useChat.ts`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/hooks/useAltwireChat.ts`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/hooks/useSSE.ts`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/pages/LoginPage.tsx`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/pages/AltwirePromptPage.tsx`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/components/settings/SettingsShell.tsx`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/components/AltwireSettingsDrawer.tsx`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/pages/__tests__/AltwirePromptPage.test.tsx`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/pages/__tests__/ChatPage.altus-writer.test.tsx`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/components/__tests__/SettingsShell.test.tsx`
- Inspect: `/Users/edoswald/Dev/hal-chat-ui/src/pages/__tests__/PromptShell.test.tsx`
- Reference: `index.js`

- [ ] **Step 1: Write a UI rollout-readiness note into the parity matrix**

Append a `hal-chat-ui rollout` section to `docs/parity/altus-nimbus-parity-matrix.md` that records:
- the UI already has an `altwire` mode, Altus prompt page, Altus settings drawer, and Altus writer/dashboard hooks
- the current auth path is still Nimbus-centric via `POST /hal/auth`
- the current Altus EventSource flow appears incompatible with Altus authenticated SSE because `useAltwireChat` opens `/events/:sessionId` without an Authorization header
- the UI has mixed terminology today (`altwire` in mode context, but some tests/props still use `altus`)

- [ ] **Step 2: Decide and implement one auth story for mixed-mode admins**

Goal: an AltWire admin signs in once and can use both Hal and Altus in the same shell.

Implement one of these, then document the decision in the matrix and the eventual `hal-chat-ui` spec:
- keep Nimbus as the sign-in broker and make Altus accept the same bearer token format for UI traffic
- or add an Altus-compatible auth path in the UI and normalize the returned auth state so the shared shell still behaves like one product

Minimum acceptance criteria:
- one login screen
- no mode-specific re-auth prompt when switching between Hal and Altus
- unauthorized failures route cleanly back to login

- [ ] **Step 3: Fix the Altus streaming contract**

Current risk: `useAltwireChat` uses `new EventSource(${ALTUS}/events/:sessionId)` while Altus currently documents `/events/:sessionId` as requiring a bearer token whose client owns the session.

Choose one supported path and implement it end-to-end:
- move Altus UI streaming to the same authenticated fetch-based SSE pattern used by `useSSE`
- or add a deliberate, documented Altus event-stream auth mechanism that works for browser EventSource without weakening session ownership checks

Acceptance criteria:
- tool start/tool done events still render in the chat timeline
- thinking/step updates still clear correctly
- a second admin cannot subscribe to another admin's session stream

- [ ] **Step 4: Normalize mode naming and state handling**

Audit and clean up the `altwire` vs `altus` seam so the UI has one canonical mode name in persisted state, props, and tests.

At minimum:
- `ModeContext` and `useUiSettings` should agree on allowed values
- `ChatPage`, prompt pages, and settings shell should not rely on parallel aliases unless there is a migration reason
- if a compatibility alias is required, isolate it in one mapper instead of sprinkling `mode === 'altwire' || mode === 'altus'` throughout the app

- [ ] **Step 5: Review the shared shell for AltWire admin usability**

Keep the mixed-mode shell, but verify the actual admin flow:
- mode switching between Hal and Altus from the same shell
- history drawer behavior per mode
- settings drawer behavior per mode
- titles/identity cues so admins always know whether they are talking to Hal or Altus
- sensible default mode for AltWire admins during the pilot window

This is mostly a readiness pass, not a redesign.

- [ ] **Step 6: Add focused UI tests for Altus admin rollout**

In `hal-chat-ui`, add or extend tests to cover:
- shared login state works for Altus mode as well as Hal mode
- Altus unauthorized responses bounce back through the common auth handler
- Altus streaming path preserves tool events and assistant streaming
- mode switching does not lose the wrong session state
- settings shell still renders one shared surface with Altus and Hal sections available to an authenticated admin

- [ ] **Step 7: Run the focused `hal-chat-ui` readiness suite**

Run the relevant targeted tests in `/Users/edoswald/Dev/hal-chat-ui`, including at least:

```bash
npm test -- \
  src/pages/__tests__/AltwirePromptPage.test.tsx \
  src/pages/__tests__/ChatPage.altus-writer.test.tsx \
  src/components/__tests__/SettingsShell.test.tsx \
  src/pages/__tests__/PromptShell.test.tsx
```

Then add any new auth/streaming tests created in Step 6.

- [ ] **Step 8: Produce an admin pilot checklist**

Before enabling real AltWire admins, capture a short checklist covering:
- required env vars for Nimbus and Altus backends
- expected auth flow
- known limitations still acceptable for pilot
- exact smoke test steps for an admin: sign in, switch modes, send a Hal prompt, send an Altus prompt, open settings, open history, verify writer sidebar/digest
- rollback path if Altus UI traffic exposes an auth or streaming flaw

## New Nimbus Tools To Highlight During Execution

These are the non-WooCommerce, non-CW Nimbus tools most likely to matter for Altus and therefore must be explicitly classified in the matrix:

- `hal-action-items`
- `hal-task-queue`
- `hal-session-traces`
- `hal-skill-library`
- `hal-web-research`
- `hal-topic-synthesis`
- `hal-commitments`
- `hal-document`
- `hal-documents`
- `hal-chat-history`
- `hal-chat-presence`
- `hal-autonomy-policy`

## Expected Outcome

After this plan is executed:

- Altus will keep Nimbus-level shared Hal behavior where AltWire admins directly feel regressions today.
- AltWire-only editorial workflows will stay intact instead of being flattened into Nimbus assumptions.
- The custom Altus-only tools will be hardened where they currently look incomplete or misleading.
- Coverage gaps around weaker Altus-only surfaces will be closed with focused tests instead of relying on broad suite luck.
- `hal-chat-ui` will be brought from “Altus mode exists” to “AltWire admins can safely test it in the shared shell.”
- The matrix will make future parity checks repeatable instead of ad hoc.
- New generic Nimbus tools will be explicitly marked as `must-port`, `adapt-for-altwire`, or `do-not-port` instead of silently drifting away from Altus.
