/**
 * AltWire Insights Slack bridge.
 *
 * Slack (Events API) ──► this service ──► Claude Managed Agents session ──► Slack reply
 *
 * - @mention in an allowlisted channel → one agent session per Slack thread
 * - DM → personal conversation; the person's own vault (mail, Canva) is
 *   attached only here, never in channels
 * - DM commands: connect <canva | MCP URL>, connections, new, help
 * - Scheduled jobs (BRIDGE_SCHEDULES) run fresh sessions and post to their
 *   channel; a job can also email (SES) and route action items to several
 *   channels (the daily digest). Admins can run a job now with `run <name>`.
 * - Shared team memory (BRIDGE_MEMORY_STORE_ID) is mounted in every session:
 *   read-write in channels and scheduled jobs, read-only in DMs by default
 * - Personal memory: each person's own store, created on first DM and
 *   mounted read-write in their DMs only
 *
 * The agent has no Slack tools: the bridge posts every reply itself and only
 * to DMs or BRIDGE_ALLOWED_CHANNELS.
 */

import { createServer } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import pg from 'pg';

import { SlackClient } from './lib/slack.js';
import { parseCsvSet } from './lib/router.js';
import { Store } from './lib/store.js';
import { parseSchedules } from './lib/schedules.js';
import { createBridge } from './lib/app.js';
import { parseDmAccess, parseUserNames, seedMemoryStore } from './lib/memory.js';
import { createSesMailer } from './lib/email.js';

const log = {
  info: (msg, meta = {}) => console.log(JSON.stringify({ level: 'info', msg, ...meta })),
  warn: (msg, meta = {}) => console.warn(JSON.stringify({ level: 'warn', msg, ...meta })),
  error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'error', msg, ...meta })),
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const env = process.env;
const config = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.BRIDGE_PUBLIC_URL || '').replace(/\/+$/, ''),
  agentId: env.BRIDGE_AGENT_ID,
  environmentId: env.BRIDGE_ENVIRONMENT_ID,
  sharedVaultId: env.BRIDGE_SHARED_VAULT_ID || null,
  slackToken: env.SLACK_BOT_TOKEN,
  slackSigningSecret: env.SLACK_SIGNING_SECRET,
  allowedChannels: parseCsvSet(env.BRIDGE_ALLOWED_CHANNELS),
  connectUsers: parseCsvSet(env.BRIDGE_CONNECT_USERS),
  dmSessionIdleMinutes: Number(env.BRIDGE_DM_SESSION_IDLE_MINUTES || 120),
  memoryStoreId: env.BRIDGE_MEMORY_STORE_ID || null,
  memoryDmAccess: parseDmAccess(env.BRIDGE_MEMORY_DM_ACCESS),
  personalMemory: String(env.BRIDGE_PERSONAL_MEMORY ?? '').trim().toLowerCase() !== 'false',
  userNames: parseUserNames(env.BRIDGE_USER_NAMES),
  adminUsers: parseCsvSet(env.BRIDGE_ADMIN_USERS),
  emailFrom: env.BRIDGE_EMAIL_FROM || null,
  databaseUrl: env.BRIDGE_DATABASE_URL || env.DATABASE_URL,
};

const missing = ['agentId', 'environmentId', 'slackToken', 'slackSigningSecret', 'databaseUrl', 'publicUrl']
  .filter((k) => !config[k]);
if (missing.length) {
  log.error('Missing required configuration', { missing });
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: false }, max: 5 });
const store = new Store(pool);
const slack = new SlackClient({ token: config.slackToken });
const anthropic = new Anthropic();

const { jobs, errors } = parseSchedules(env.BRIDGE_SCHEDULES, { allowedChannels: config.allowedChannels });
for (const e of errors) log.error('Invalid schedule', { error: e });
config.jobs = jobs.filter((job) => {
  if (job.manual || cron.validate(job.cron)) return true;
  log.error('Invalid schedule', { error: `schedule ${job.name}: invalid cron "${job.cron}"` });
  return false;
});

// Email for scheduled jobs that have one (the daily digest), through SES.
const mailer = config.emailFrom
  ? createSesMailer({
      from: config.emailFrom,
      region: env.AWS_REGION || 'us-east-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    })
  : null;
for (const job of config.jobs) {
  if (job.email && !mailer) log.error('Scheduled job has an email but BRIDGE_EMAIL_FROM is not set; it will only post to Slack', { job: job.name });
}

const bridge = createBridge({ config, store, anthropic, slack, log, mailer });

await store.init();
const botUserId = (await slack.authTest()).user_id;
bridge.setBotUserId(botUserId);

for (const job of config.jobs.filter((j) => !j.manual)) {
  cron.schedule(job.cron, () => bridge.runScheduledJob(job), { timezone: job.timezone, name: job.name, noOverlap: true });
}
cron.schedule('17 * * * *', () => store.pruneSeenEvents().catch(() => {}), { name: 'prune' });

// Starter files for the shared memory (holiday tracker, decisions). Existing
// files are never overwritten.
if (config.memoryStoreId) {
  seedMemoryStore(anthropic, config.memoryStoreId)
    .then((r) => log[r.failed.length ? 'warn' : 'info']('Memory store seeded', r))
    .catch((err) => log.error('Memory store seeding failed', { error: err.message }));
}

createServer((req, res) => bridge.handleHttp(req, res)).listen(config.port, () => {
  log.info('Slack bridge listening', {
    port: config.port,
    botUserId,
    allowedChannels: [...config.allowedChannels],
    schedules: config.jobs.map((j) => `${j.name} (${j.manual ? 'manual' : `${j.cron} ${j.timezone}`})${j.email ? ` email→${j.email.to.length + j.email.cc.length}` : ''}${j.routes ? ` slack→${j.routes.map((r) => r.name).join('/')}` : ''}`),
    email: mailer ? 'ses' : 'off',
    memory: config.memoryStoreId ? `channels read_write, DMs ${config.memoryDmAccess}` : 'off',
    personalMemory: config.personalMemory ? 'per user, DMs only' : 'off',
  });
});
