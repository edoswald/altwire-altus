/**
 * Scheduled agent jobs, configured with BRIDGE_SCHEDULES (a JSON array):
 *
 *   [{ "name": "weekly-recap", "cron": "45 8 * * 1", "timezone": "America/New_York",
 *      "channel": "C0AVAMXP17Y", "prompt": "Write this week's analytics recap…" }]
 *
 * Each run starts a fresh session with only the shared vault and posts the
 * agent's answer to the job's channel, which must be on the allowlist.
 */

export function parseSchedules(raw, { allowedChannels }) {
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
    const missing = ['name', 'cron', 'channel', 'prompt'].filter((k) => !job?.[k] || typeof job[k] !== 'string');
    if (missing.length) return errors.push(`schedule ${label}: missing ${missing.join(', ')}`);
    if (names.has(job.name)) return errors.push(`schedule ${label}: duplicate name`);
    if (!allowedChannels.has(job.channel)) return errors.push(`schedule ${label}: channel ${job.channel} is not in BRIDGE_ALLOWED_CHANNELS`);
    if (job.cron.trim().split(/\s+/).length !== 5) return errors.push(`schedule ${label}: cron must have 5 fields`);
    names.add(job.name);
    jobs.push({ name: job.name, cron: job.cron.trim(), timezone: job.timezone || 'America/New_York', channel: job.channel, prompt: job.prompt });
  });
  return { jobs, errors };
}

/** The message sent to the agent for a scheduled run. */
export function scheduledPrompt(job, now = new Date()) {
  const date = now.toLocaleDateString('en-US', { timeZone: job.timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `${job.prompt}\n\n(Scheduled job "${job.name}", run on ${date}. Your reply will be posted to Slack as-is, so write only the post itself.)`;
}
