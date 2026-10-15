/**
 * Shared team memory (a Managed Agents memory store, BRIDGE_MEMORY_STORE_ID).
 *
 * The store is mounted into every channel and scheduled session at
 * /mnt/memory/<store-name>/, so the agent carries editorial decisions and
 * ongoing project state (the holiday tracker) from one thread or weekly run
 * to the next.
 *
 * DMs get the store read-only by default (BRIDGE_MEMORY_DM_ACCESS): DMs can
 * carry a person's own mail and accounts, and a read-only mount means none of
 * that can be written into memory the whole team shares.
 */

export const MEMORY_INSTRUCTIONS = `Shared AltWire team memory. Read the files relevant to the request before starting (ls the folder first).

Save only what will matter in a later conversation:
- Editorial decisions and standing preferences ("no listicles for live reviews"), in decisions.md.
- Ongoing project state, such as the holiday plan in holiday-2026.md: guides, their status, chosen picks, prices with the date checked, and each week's priority.
- Corrections to things you got wrong about AltWire.

Never save: anything from someone's email or private messages, credentials, one-off answers, or analytics numbers that will be stale tomorrow (Altus has those).

Edit existing files instead of creating new ones, keep entries short and dated (YYYY-MM-DD), and mention in your reply when you've updated memory.`;

export const MEMORY_INSTRUCTIONS_READ_ONLY = `Shared AltWire team memory, read-only in this conversation. Read the files relevant to the request before starting (ls the folder first). If something here should be updated, say what, so it can be changed from a team channel.`;

/**
 * Session resources for the shared memory store.
 * @returns {Array<object>}  [] when no store is configured
 */
export function memoryResourcesFor({ isDm, memoryStoreId, dmAccess = 'read_only' }) {
  if (!memoryStoreId) return [];
  const access = isDm ? dmAccess : 'read_write';
  return [{
    type: 'memory_store',
    memory_store_id: memoryStoreId,
    access,
    instructions: access === 'read_only' ? MEMORY_INSTRUCTIONS_READ_ONLY : MEMORY_INSTRUCTIONS,
  }];
}

export function parseDmAccess(value) {
  return String(value ?? '').trim().toLowerCase() === 'read_write' ? 'read_write' : 'read_only';
}

export const HOLIDAY_TRACKER_PATH = '/holiday-2026.md';

export const HOLIDAY_TRACKER_SEED = `# Holiday 2026 tracker

Shared plan for AltWire's 2026 holiday gift guides and seasonal content. The Monday holiday check-in reads this file first and updates it after posting. Keep entries short and dated.

## Key dates
- Thu Nov 26: Thanksgiving
- Fri Nov 27: Black Friday
- Mon Nov 30: Cyber Monday
- Fri Dec 4 (evening): Hanukkah begins
- Fri Dec 25: Christmas
- Goal: guides published and indexed by mid-November

## Guides
| Guide | New or refresh | Status | Target publish | URL | Notes |
|---|---|---|---|---|---|
| (none yet) | | | | | |

Status values: idea, picking, drafting, in review, published, refreshed.

## Picks
Per guide: product, AltWire review URL, overall rating, price and date checked, in stock (y/n).

(none yet)

## Weekly priorities
One line per week: date, the priority set, and whether it got done.

(none yet)

## Decisions
Dated decisions about the holiday plan (themes, what's in or out, disclosure, affiliate links).

(none yet)
`;

export const DECISIONS_PATH = '/decisions.md';

export const DECISIONS_SEED = `# AltWire editorial decisions

Standing decisions and preferences the team has agreed on. One dated line each; newest at the bottom. Holiday-specific decisions go in holiday-2026.md.

(none yet)
`;

export const MEMORY_SEEDS = [
  { path: HOLIDAY_TRACKER_PATH, content: HOLIDAY_TRACKER_SEED },
  { path: DECISIONS_PATH, content: DECISIONS_SEED },
];

/**
 * Create the starter files if they don't exist yet. An existing file is left
 * alone (the API returns 409 for an occupied path), so this is safe on every
 * startup and never overwrites what the team has written.
 *
 * @returns {Promise<{ created: string[], existing: string[], failed: string[] }>}
 */
export async function seedMemoryStore(anthropic, memoryStoreId, seeds = MEMORY_SEEDS) {
  const result = { created: [], existing: [], failed: [] };
  for (const { path, content } of seeds) {
    try {
      await anthropic.beta.memoryStores.memories.create(memoryStoreId, { path, content });
      result.created.push(path);
    } catch (err) {
      if (err?.status === 409) result.existing.push(path);
      else result.failed.push(`${path}: ${err?.message ?? err}`);
    }
  }
  return result;
}
