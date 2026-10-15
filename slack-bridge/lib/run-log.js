/**
 * Run logs for scheduled jobs, kept in the shared team memory.
 *
 * After a job delivers, the bridge records what went out (a digest's
 * subject and action items, or a recap's post) in a Markdown file such as
 * /digest-log.md, newest entry first, trimmed to the last N entries. The
 * bridge writes it, not the agent, so the log is exactly what was sent and
 * never skipped. Later runs read it to follow up on open items, avoid
 * repeats, and judge what past recommendations did.
 *
 * Configured per job: "log": { "path": "/digest-log.md", "keep": 30 }.
 */

const ENTRY_RE = /^## /m;

export const LOG_HEADERS = {
  default: (title) => `# ${title}\n\nWritten by the Slack bridge after each run: exactly what was sent, newest first. Read it to follow up on open items, avoid repeating them, and see what earlier recommendations led to. Don't edit; the bridge rewrites this file.\n`,
};

export function parseLogConfig(raw, jobName) {
  if (raw == null) return { log: null };
  const path = typeof raw === 'string' ? raw : raw?.path;
  if (typeof path !== 'string' || !/^\/[\w./-]+\.md$/.test(path) || path.includes('..')) {
    return { error: 'log.path must look like /something.md' };
  }
  const keep = Number(raw?.keep ?? 30);
  if (!Number.isInteger(keep) || keep < 1 || keep > 200) return { error: 'log.keep must be 1-200' };
  const title = typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : `${jobName} log`;
  return { log: { path, keep, title } };
}

/** Date label in the job's time zone, e.g. "2026-10-15 (Thu)". */
export function dateLabel(now, timeZone = 'America/New_York') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} (${parts.weekday})`;
}

/** Log entry for a multi-output job: subject plus each route's action items. */
export function digestEntry({ now, timeZone, subject, routes, slack, emailed }) {
  const lines = [`## ${dateLabel(now, timeZone)}`];
  if (subject) lines.push(`Subject: ${subject}${emailed === false ? ' (email not sent)' : ''}`);
  for (const route of routes ?? []) {
    const item = slack.find((s) => s.route === route.name);
    lines.push('', `### ${route.name}`, item ? item.text.trim() : 'none');
  }
  return lines.join('\n');
}

/** Log entry for a single-post job: the post itself. */
export function postEntry({ now, timeZone, text }) {
  return `## ${dateLabel(now, timeZone)}\n\n${String(text ?? '').trim()}`;
}

/**
 * Put a new entry at the top of a log document and keep the newest `keep`.
 * Content before the first entry (the header) is kept, or replaced with
 * `header` if the file has none.
 */
export function prependEntry(existing, entry, { keep, header }) {
  const doc = String(existing ?? '');
  const first = doc.search(ENTRY_RE);
  const head = first === -1 ? (doc.trim() ? doc : header) : doc.slice(0, first);
  const body = first === -1 ? '' : doc.slice(first);
  const entries = body ? body.split(/(?=^## )/m).map((e) => e.trim()).filter(Boolean) : [];
  const kept = [entry.trim(), ...entries].slice(0, keep);
  return `${(head.trim() ? head.trim() : header.trim())}\n\n${kept.join('\n\n')}\n`;
}

/** Directory part of a path, with a trailing slash: '/a/b.md' -> '/a/'. */
export function parentDir(path) {
  return path.slice(0, path.lastIndexOf('/') + 1) || '/';
}

async function findMemory(anthropic, storeId, path) {
  // path_prefix must be a directory (ending in '/'), so list the parent and match exactly.
  for await (const item of anthropic.beta.memoryStores.memories.list(storeId, { path_prefix: parentDir(path) })) {
    if (item.type === 'memory' && item.path === path) return item;
  }
  return null;
}

/**
 * Prepend an entry to the log file in the store, creating it if needed.
 * Uses the content hash as a precondition so a concurrent edit isn't
 * overwritten (retries once with fresh content).
 */
export async function appendRunLog(anthropic, storeId, log, entry) {
  const header = LOG_HEADERS.default(log.title);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const found = await findMemory(anthropic, storeId, log.path);
    if (!found) {
      try {
        await anthropic.beta.memoryStores.memories.create(storeId, {
          path: log.path,
          content: prependEntry('', entry, { keep: log.keep, header }),
        });
        return 'created';
      } catch (err) {
        if (err?.status === 409 && attempt === 0) continue; // created meanwhile
        throw err;
      }
    }
    const current = await anthropic.beta.memoryStores.memories.retrieve(found.id, { memory_store_id: storeId });
    try {
      await anthropic.beta.memoryStores.memories.update(found.id, {
        memory_store_id: storeId,
        content: prependEntry(current.content, entry, { keep: log.keep, header }),
        precondition: { type: 'content_sha256', content_sha256: current.content_sha256 },
      });
      return 'updated';
    } catch (err) {
      if (err?.status === 409 && attempt === 0) continue; // changed meanwhile
      throw err;
    }
  }
  throw new Error('run log changed repeatedly while updating');
}
