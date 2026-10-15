/**
 * Scheduled agent jobs, configured with BRIDGE_SCHEDULES (a JSON array):
 *
 *   [{ "name": "weekly-recap", "cron": "45 8 * * 1", "timezone": "America/New_York",
 *      "channel": "C0AVAMXP17Y", "prompt": "Write this week's analytics recap…" }]
 *
 * Each run starts a fresh session with only the shared vault and posts the
 * agent's answer to the job's channel, which must be on the allowlist.
 *
 * A job can instead deliver several outputs from one run (the daily digest):
 *
 *   "email":  { "to": ["$DEREK_EMAIL"], "cc": ["$ALTUS_CC_EMAILS"], "subject": "AltWire daily digest" }
 *   "routes": { "team":    { "channel": "C0AVAMXP17Y", "about": "general AltWire work" },
 *               "holiday": { "channel": "C0C8DSN1BP0", "about": "holiday gift guides" } }
 *
 * The agent then answers in labelled sections (see outputInstructions): a
 * detailed email, plus short Slack posts for whichever routes have something
 * actionable. Addresses written as $NAME are read from that environment
 * variable (comma-separated lists are split).
 *
 * "manual": true (no cron) defines a job that only runs with `run <name>`.
 *
 * "preview": true posts nothing to Slack; the Slack sections are appended to
 * the email instead, for trying a job out before it goes to the team.
 */

export function parseSchedules(raw, { allowedChannels, env = process.env }) {
  if (!raw || !String(raw).trim()) return { jobs: [], errors: [] };
  let list;
  try {
    list = JSON.parse(raw);
  } catch (err) {
    return { jobs: [], errors: [`BRIDGE_SCHEDULES is not valid JSON: ${err.message}`] };
  }
  if (!Array.isArray(list)) return { jobs: [], errors: ['BRIDGE_SCHEDULES must be a JSON array'] };

  const jobs = [];
  const errors = [];
  const names = new Set();
  list.forEach((job, i) => {
    const label = job?.name || `#${i}`;
    const manual = job?.manual === true;
    const required = manual ? ['name', 'channel', 'prompt'] : ['name', 'cron', 'channel', 'prompt'];
    const missing = required.filter((k) => !job?.[k] || typeof job[k] !== 'string');
    if (missing.length) return errors.push(`schedule ${label}: missing ${missing.join(', ')}`);
    if (names.has(job.name)) return errors.push(`schedule ${label}: duplicate name`);
    if (!allowedChannels.has(job.channel)) return errors.push(`schedule ${label}: channel ${job.channel} is not in BRIDGE_ALLOWED_CHANNELS`);
    if (!manual && job.cron.trim().split(/\s+/).length !== 5) return errors.push(`schedule ${label}: cron must have 5 fields`);

    const routes = parseRoutes(job.routes);
    if (routes.error) return errors.push(`schedule ${label}: ${routes.error}`);
    const blocked = routes.list.find((r) => !allowedChannels.has(r.channel));
    if (blocked) return errors.push(`schedule ${label}: route ${blocked.name} channel ${blocked.channel} is not in BRIDGE_ALLOWED_CHANNELS`);

    let email = null;
    if (job.email) {
      const to = resolveAddresses(job.email.to, env);
      if (!to.length) return errors.push(`schedule ${label}: email.to resolves to no addresses`);
      email = {
        to,
        cc: resolveAddresses(job.email.cc, env).filter((a) => !to.includes(a)),
        subject: typeof job.email.subject === 'string' && job.email.subject.trim() ? job.email.subject.trim() : `AltWire: ${job.name}`,
      };
    }

    names.add(job.name);
    jobs.push({
      name: job.name,
      cron: manual ? null : job.cron.trim(),
      ...(manual ? { manual: true } : {}),
      timezone: job.timezone || 'America/New_York',
      channel: job.channel,
      prompt: job.prompt,
      ...(email ? { email } : {}),
      ...(routes.list.length ? { routes: routes.list } : {}),
      ...(job.preview === true ? { preview: true } : {}),
    });
  });
  return { jobs, errors };
}

function parseRoutes(raw) {
  if (raw == null) return { list: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'routes must be an object of name → channel' };
  const list = [];
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[a-z0-9_-]+$/i.test(name)) return { error: `route name "${name}" must be letters, digits, - or _` };
    const channel = typeof value === 'string' ? value : value?.channel;
    if (!channel || typeof channel !== 'string') return { error: `route ${name} needs a channel` };
    list.push({ name: name.toLowerCase(), channel, about: typeof value === 'object' ? value.about ?? null : null });
  }
  return { list };
}

/** ["a@x.com", "$CC_LIST"] → addresses, expanding $VAR from the environment. */
export function resolveAddresses(value, env = process.env) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  const out = [];
  for (const item of items) {
    const raw = String(item).trim();
    const expanded = raw.startsWith('$') ? String(env[raw.slice(1)] ?? '') : raw;
    for (const addr of expanded.split(',').map((a) => a.trim()).filter(Boolean)) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) && !out.includes(addr)) out.push(addr);
    }
  }
  return out;
}

export function isMultiOutput(job) {
  return Boolean(job.email || job.routes?.length);
}

/** Format contract appended to the prompt of a multi-output job. */
export function outputInstructions(job) {
  const lines = [
    'Deliver your answer in these labelled sections, each label alone on its own line, and nothing outside them:',
  ];
  if (job.email) {
    lines.push(
      '=== EMAIL SUBJECT ===',
      'One line: a specific subject (the headline of the day), without a date.',
      '=== EMAIL ===',
      'The detailed email in Markdown (headings, short paragraphs, bullets; tables are fine). It goes to the editor.',
    );
  }
  for (const route of job.routes ?? []) {
    lines.push(
      `=== SLACK ${route.name} ===`,
      `Action items for the ${route.name} channel${route.about ? ` (${route.about})` : ''}: a short Slack post, only things someone should act on. Write exactly "none" if there is nothing for this channel.`,
    );
  }
  return lines.join('\n');
}

/** The message sent to the agent for a scheduled run. */
export function scheduledPrompt(job, now = new Date()) {
  const date = now.toLocaleDateString('en-US', { timeZone: job.timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  if (isMultiOutput(job)) {
    return `${job.prompt}\n\n(Scheduled job "${job.name}", run on ${date}.)\n\n${outputInstructions(job)}`;
  }
  return `${job.prompt}\n\n(Scheduled job "${job.name}", run on ${date}. Your reply will be posted to Slack as-is, so write only the post itself.)`;
}

const SECTION_RE = /^[ \t]*={3,}[ \t]*(EMAIL SUBJECT|EMAIL|SLACK[ \t]+[a-z0-9_-]+)[ \t]*={3,}[ \t]*$/gim;

/**
 * Split a multi-output reply into its sections.
 * @returns {{ subject: string|null, email: string|null, slack: Array<{route, channel, text}>, found: boolean }}
 */
export function parseJobOutput(text, job) {
  const raw = String(text ?? '');
  const marks = [...raw.matchAll(SECTION_RE)];
  const sections = new Map();
  marks.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : raw.length;
    sections.set(m[1].toUpperCase().replace(/\s+/g, ' '), raw.slice(start, end).trim());
  });

  const isNone = (t) => !t || /^[_*]?none\.?[_*]?$/i.test(t.trim());
  const slack = [];
  for (const route of job.routes ?? []) {
    const body = sections.get(`SLACK ${route.name.toUpperCase()}`);
    if (!isNone(body)) slack.push({ route: route.name, channel: route.channel, text: body });
  }
  const subject = sections.get('EMAIL SUBJECT')?.split('\n')[0].trim() || null;
  const email = sections.get('EMAIL') || null;
  return { subject, email, slack, found: marks.length > 0 };
}
