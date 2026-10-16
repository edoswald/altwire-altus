/**
 * The bridge's behaviour, independent of process setup: Slack event routing,
 * conversations, DM commands, the account-linking flow, scheduled jobs and the
 * HTTP handler. Dependencies are passed in so tests can drive it with fakes.
 */

import crypto from 'node:crypto';

import { chunkText, toSlackMrkdwn, verifySlackSignature } from './slack.js';
import { canPostIn, parseCommand, routeEvent, vaultsFor } from './router.js';
import { createSession, runTurn } from './agent-session.js';
import { createProgress } from './progress.js';
import {
  PERSONAL_SEEDS, memoryResourcesFor, personalStoreDescription, personalStoreName, seedMemoryStore,
} from './memory.js';
import {
  buildAuthorizeUrl, buildVaultAuth, createPkce, discover, exchangeCode,
  normalizeServerUrl, registerClient, resolveServer,
} from './mcp-oauth.js';
import { buildPersonalOverride, personalServersFromCredentials } from './personal-servers.js';
import { isMultiOutput, parseJobOutput, scheduledPrompt } from './schedules.js';
import { emailDocument, emailText } from './email.js';
import { appendRunLog, digestEntry, postEntry } from './run-log.js';
import { downloadFile, findNewSessionFiles } from './session-files.js';

/**
 * @param {object} deps
 * @param {object} deps.config     see index.js
 * @param {import('./store.js').Store} deps.store
 * @param {object} deps.anthropic  Anthropic client (uses client.beta.*)
 * @param {import('./slack.js').SlackClient} deps.slack
 * @param {object} [deps.log]
 * @param {Function} [deps.fetchImpl] fetch used for OAuth discovery and token calls
 * @param {Function} [deps.sleep]     delay used while waiting for output files (tests pass a no-op)
 */
export function createBridge({ config, store, anthropic, slack, log = console, fetchImpl = fetch, sleep, mailer = null }) {
  const redirectUri = `${config.publicUrl}/oauth/callback`;
  let botUserId = config.botUserId ?? null;

  // One turn at a time per conversation; later messages wait their turn.
  const queues = new Map();
  function enqueue(key, task) {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task).finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
    queues.set(key, next);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------
  /** Post (or fill in the placeholder with) the reply; returns the first message's ts. */
  async function postReply({ channel, threadTs, placeholderTs, text }) {
    const chunks = chunkText(toSlackMrkdwn(text));
    let firstTs = placeholderTs;
    if (placeholderTs) {
      await slack.update({ channel, ts: placeholderTs, text: chunks[0] });
    } else {
      firstTs = (await slack.post({ channel, text: chunks[0], thread_ts: threadTs ?? undefined })).ts;
    }
    for (const chunk of chunks.slice(1)) {
      await slack.post({ channel, text: chunk, thread_ts: threadTs ?? undefined });
    }
    return firstTs;
  }

  /** Attach files the agent created during the turn (reports, spreadsheets, decks). */
  async function deliverFiles({ sessionId, channel, threadTs }) {
    let files;
    try {
      files = await findNewSessionFiles(anthropic, sessionId, await store.getSentFiles(sessionId), sleep ? { sleep } : {});
    } catch (err) {
      log.warn('Listing session files failed', { sessionId, error: err.message });
      return;
    }
    for (const file of files) {
      try {
        const bytes = await downloadFile(anthropic, file.id);
        await slack.uploadFile({ channel, thread_ts: threadTs ?? undefined, filename: file.filename, bytes, title: file.filename });
        await store.markFileSent(sessionId, file.id);
        log.info('File attached', { sessionId, filename: file.filename, bytes: bytes.length });
      } catch (err) {
        log.error('Attaching file failed', { sessionId, filename: file.filename, error: err.message });
        await store.markFileSent(sessionId, file.id).catch(() => {});
        await slack.post({ channel, thread_ts: threadTs ?? undefined, text: `_Couldn't attach ${file.filename}: ${err.message}_` }).catch(() => {});
      }
    }
  }

  // The agent's own config, cached briefly; DM overrides are built on top of it.
  let agentCache = { at: 0, agent: null };
  async function currentAgent() {
    if (!agentCache.agent || Date.now() - agentCache.at > 5 * 60_000) {
      agentCache = { at: Date.now(), agent: await anthropic.beta.agents.retrieve(config.agentId) };
    }
    return agentCache.agent;
  }

  async function listVaultCredentials(vaultId) {
    const credentials = [];
    for await (const cred of anthropic.beta.vaults.credentials.list(vaultId)) credentials.push(cred);
    return credentials;
  }

  /** Agent reference for a new session: plain id, or an override adding the person's linked accounts. */
  async function agentFor(personalVaultId) {
    if (!personalVaultId) return config.agentId;
    const personal = personalServersFromCredentials(await listVaultCredentials(personalVaultId));
    if (!personal.length) return config.agentId;
    return buildPersonalOverride(await currentAgent(), personal) ?? config.agentId;
  }

  /** The person's own memory store, created on first use. Null if disabled or creation fails. */
  async function ensureUserMemoryStore(slackUserId) {
    if (!config.personalMemory) return null;
    const existing = await store.getUserMemoryStore(slackUserId);
    if (existing) return existing;
    try {
      const created = await anthropic.beta.memoryStores.create({
        name: personalStoreName(slackUserId, config.userNames),
        description: personalStoreDescription(slackUserId, config.userNames),
        metadata: { slack_user_id: slackUserId, owner: 'altwire-slack-bridge' },
      });
      const saved = await store.saveUserMemoryStore(slackUserId, created.id);
      if (saved !== created.id) {
        log.warn('Personal memory store created twice; using the first', { slackUserId, kept: saved, unused: created.id });
        return saved;
      }
      const seeded = await seedMemoryStore(anthropic, created.id, PERSONAL_SEEDS);
      log.info('Personal memory store created', { slackUserId, memoryStoreId: created.id, seeded: seeded.created });
      return created.id;
    } catch (err) {
      log.error('Personal memory store creation failed; continuing without it', { slackUserId, error: err.message });
      return null;
    }
  }

  async function listMemoryPaths(memoryStoreId) {
    const paths = [];
    for await (const item of anthropic.beta.memoryStores.memories.list(memoryStoreId, { path_prefix: '/' })) {
      if (item.type === 'memory') paths.push(item.path);
      if (paths.length >= 50) break;
    }
    return paths.sort();
  }

  async function describeMemory(slackUserId) {
    const lines = [];
    const section = async (label, id) => {
      if (!id) return;
      try {
        const paths = await listMemoryPaths(id);
        lines.push(`*${label}*`, paths.length ? paths.map((p) => `• \`${p}\``).join('\n') : '_empty_');
      } catch (err) {
        lines.push(`*${label}*`, `_couldn't read it (${err.message})_`);
      }
    };
    await section('Your memory (only used in DMs)', await ensureUserMemoryStore(slackUserId));
    await section(`Team memory (${config.memoryDmAccess === 'read_write' ? 'read-write' : 'read-only'} in DMs)`, config.memoryStoreId);
    if (!lines.length) return 'Memory is not set up for this app.';
    lines.push('', 'Ask me to remember or forget something, or review and edit the files in the Claude Console under Memory stores.');
    return lines.join('\n');
  }

  async function sessionFor(route) {
    const existing = await store.getSession(route.sessionKey, {
      maxIdleMinutes: route.rolling ? config.dmSessionIdleMinutes : null,
    });
    if (existing) return { ...existing, isNew: false };

    const personalVaultId = route.isDm ? await store.getUserVault(route.user) : null;
    const vaultIds = vaultsFor({ isDm: route.isDm, user: route.user, sharedVaultId: config.sharedVaultId, personalVaultId });
    const resources = memoryResourcesFor({
      isDm: route.isDm,
      memoryStoreId: config.memoryStoreId,
      dmAccess: config.memoryDmAccess,
      personalStoreId: route.isDm ? await ensureUserMemoryStore(route.user) : null,
    });
    const sessionId = await createSession(anthropic, {
      agent: await agentFor(route.isDm ? personalVaultId : null),
      environmentId: config.environmentId,
      vaultIds,
      resources,
      title: `Slack ${route.isDm ? 'DM' : 'thread'} ${route.sessionKey}`,
    });
    await store.saveSession(route.sessionKey, { sessionId, slackUserId: route.user, vaultIds });
    log.info('Session created', {
      sessionKey: route.sessionKey, sessionId, vaults: vaultIds.length, memory_stores: resources.length,
    });
    return { sessionId, slackUserId: route.user, vaultIds, isNew: true };
  }

  async function converse(route) {
    const placeholder = await slack.post({
      channel: route.channel,
      text: '_Working on it…_',
      thread_ts: route.replyThreadTs ?? undefined,
    });

    // Edit the placeholder into a live checklist of the agent's steps.
    const progress = createProgress(
      (text) => slack.update({ channel: route.channel, ts: placeholder.ts, text }),
      { minIntervalMs: config.progressIntervalMs ?? 1500, logger: log },
    );

    const attempt = async () => {
      const session = await sessionFor(route);
      const result = await runTurn(anthropic, session.sessionId, route.text, { logger: log, onStep: progress });
      await store.touchSession(route.sessionKey);
      return { session, result };
    };

    try {
      let outcome;
      try {
        outcome = await attempt();
      } catch (err) {
        // A session that was archived or terminated elsewhere can't take new
        // messages; start a fresh one once.
        log.warn('Turn failed; retrying with a new session', { sessionKey: route.sessionKey, error: err.message });
        await store.forgetSession(route.sessionKey);
        outcome = await attempt();
      }
      log.info('Turn complete', { sessionKey: route.sessionKey, stopReason: outcome.result.stopReason, toolCalls: outcome.result.toolCalls });
      await progress.stop();
      await postReply({ channel: route.channel, threadTs: route.replyThreadTs, placeholderTs: placeholder.ts, text: outcome.result.text });
      await deliverFiles({ sessionId: outcome.session.sessionId, channel: route.channel, threadTs: route.replyThreadTs });
    } catch (err) {
      log.error('Conversation failed', { sessionKey: route.sessionKey, error: err.message });
      await progress.stop();
      await slack.update({ channel: route.channel, ts: placeholder.ts, text: '_Something went wrong reaching the agent. Try again in a minute._' })
        .catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // DM commands
  // ---------------------------------------------------------------------------
  const HELP = [
    '*AltWire Insights* answers questions about AltWire stories, traffic, search and story ideas.',
    '• Ask anything here, or @mention me in #team-altwire.',
    '• `new` starts a fresh conversation in this DM.',
    '• `connect canva` or `connect <MCP server URL>` links one of your own accounts (only used in this DM).',
    '• `connections` lists what you have linked.',
    '• `memory` shows what I remember about you (your own notes, only used in DMs) and the team.',
  ].join('\n');

  async function handleCommand(route, command) {
    const reply = (text) => slack.post({ channel: route.channel, text, thread_ts: route.replyThreadTs ?? undefined });

    if (command.name === 'help') return reply(HELP);

    if (command.name === 'new') {
      await store.forgetSession(route.sessionKey);
      return reply('Started fresh. What would you like to know?');
    }

    if (command.name === 'connections') {
      const vaultId = await store.getUserVault(route.user);
      if (!vaultId) return reply('You have no linked accounts yet. Try `connect canva`.');
      const linked = personalServersFromCredentials(await listVaultCredentials(vaultId));
      return reply(linked.length ? `Linked accounts:\n${linked.map((p) => `• ${p.label}`).join('\n')}` : 'You have no linked accounts yet.');
    }

    if (command.name === 'memory') return reply(await describeMemory(route.user));

    if (command.name === 'run') {
      if (!config.adminUsers?.has(route.user)) return reply('Running scheduled jobs by hand is limited to admins.');
      const job = (config.jobs ?? []).find((j) => j.name === command.arg);
      if (!job) {
        const names = (config.jobs ?? []).map((j) => `\`${j.name}\``).join(', ') || 'none configured';
        return reply(`No scheduled job called \`${command.arg}\`. Jobs: ${names}.`);
      }
      await reply(`Running \`${job.name}\` now. It posts and emails for real, the same as a scheduled run; this takes a few minutes.`);
      const result = await runScheduledJob(job);
      if (result?.error) return reply(`\`${job.name}\` failed: ${result.error}`);
      if (!result) return reply(`\`${job.name}\` didn't finish cleanly, so nothing was sent. Check the bridge logs.`);
      const parts = [];
      if (result.emailed) parts.push('emailed');
      if (result.posted?.length) parts.push(`posted to ${result.posted.map((c) => `<#${c}>`).join(', ')}`);
      return reply(`\`${job.name}\` done: ${parts.join('; ') || 'nothing to deliver'}.`);
    }

    if (command.name === 'connect' || command.name === 'disconnect') {
      if (!config.connectUsers.has(route.user)) {
        return reply('Linking personal accounts is not enabled for you. Ask Ed to add you.');
      }
      const server = resolveServer(command.arg);
      if (server.error) return reply(server.error);
      if (command.name === 'disconnect') return reply(await disconnect(route.user, server));
      return reply(await startConnect(route, server));
    }
    return null;
  }

  async function startConnect(route, server) {
    try {
      const meta = await discover(server.url, { fetchImpl });
      const client = await registerClient(meta.registrationEndpoint, { redirectUri, clientName: 'AltWire Insights (Slack)', fetchImpl });
      const pkce = createPkce();
      const state = crypto.randomBytes(24).toString('base64url');
      await store.saveOAuthState(state, {
        slackUserId: route.user,
        dmChannel: route.channel,
        serverLabel: server.label,
        serverUrl: server.url,
        flow: {
          tokenEndpoint: meta.tokenEndpoint,
          resource: meta.resource,
          scopes: meta.scopes,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          authMethod: client.authMethod,
          codeVerifier: pkce.verifier,
        },
      });
      const link = buildAuthorizeUrl({
        authorizationEndpoint: meta.authorizationEndpoint,
        clientId: client.clientId,
        redirectUri,
        state,
        codeChallenge: pkce.challenge,
        resource: meta.resource,
        scopes: meta.scopes,
      });
      return `<${link}|Sign in to ${server.label}> to link it. The link works once and expires in 10 minutes. Only you can see this DM.`;
    } catch (err) {
      log.error('Connect failed to start', { server: server.url, error: err.message });
      return `I couldn't start linking ${server.label}: ${err.message}`;
    }
  }

  async function ensureUserVault(slackUserId) {
    const existing = await store.getUserVault(slackUserId);
    if (existing) return existing;
    const vault = await anthropic.beta.vaults.create({ display_name: `AltWire Insights: Slack user ${slackUserId}` });
    await store.saveUserVault(slackUserId, vault.id);
    return vault.id;
  }

  async function archiveCredentialsFor(vaultId, serverUrl) {
    const target = normalizeServerUrl(serverUrl);
    let archived = 0;
    for await (const cred of anthropic.beta.vaults.credentials.list(vaultId)) {
      const url = cred.auth?.mcp_server_url;
      if (!cred.archived_at && url && normalizeServerUrl(url) === target) {
        await anthropic.beta.vaults.credentials.archive(cred.id, { vault_id: vaultId });
        archived += 1;
      }
    }
    return archived;
  }

  async function disconnect(slackUserId, server) {
    const vaultId = await store.getUserVault(slackUserId);
    if (!vaultId) return `${server.label} isn't linked.`;
    const archived = await archiveCredentialsFor(vaultId, server.url);
    if (archived) await store.forgetDmSessions(slackUserId);
    return archived ? `Unlinked ${server.label}. Conversations started from now on won't use it.` : `${server.label} isn't linked.`;
  }

  async function completeConnect({ code, state }) {
    const pending = await store.takeOAuthState(state);
    if (!pending) return { ok: false, message: 'This sign-in link has expired or was already used. Send the connect command again in Slack.' };
    const { flow } = pending;
    try {
      const tokens = await exchangeCode({
        tokenEndpoint: flow.tokenEndpoint,
        code,
        redirectUri,
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        authMethod: flow.authMethod,
        codeVerifier: flow.codeVerifier,
        resource: flow.resource,
        fetchImpl,
      });
      const vaultId = await ensureUserVault(pending.slackUserId);
      await archiveCredentialsFor(vaultId, pending.serverUrl);
      await anthropic.beta.vaults.credentials.create(vaultId, {
        display_name: pending.serverLabel,
        auth: buildVaultAuth({
          serverUrl: pending.serverUrl,
          tokens,
          clientId: flow.clientId,
          clientSecret: flow.clientSecret,
          authMethod: flow.authMethod,
          tokenEndpoint: flow.tokenEndpoint,
          resource: flow.resource,
          scopes: flow.scopes,
        }),
      });
      // Vaults and servers are fixed when a session is created, so end the
      // person's DM sessions; their next message starts one that includes this account.
      await store.forgetDmSessions(pending.slackUserId);
      await slack.post({ channel: pending.dmChannel, text: `${pending.serverLabel} is linked. I'll use it in this DM from your next message.` });
      log.info('Account linked', { slackUserId: pending.slackUserId, server: pending.serverUrl });
      return { ok: true, message: `${pending.serverLabel} is linked. You can close this tab and go back to Slack.` };
    } catch (err) {
      log.error('Connect failed', { server: pending.serverUrl, error: err.message });
      await slack.post({ channel: pending.dmChannel, text: `Linking ${pending.serverLabel} failed: ${err.message}` }).catch(() => {});
      return { ok: false, message: `Linking ${pending.serverLabel} failed. Details are in your Slack DM.` };
    }
  }

  // ---------------------------------------------------------------------------
  // Slack events
  // ---------------------------------------------------------------------------
  async function handleSlackEvent(envelope) {
    if (envelope.type !== 'event_callback' || !envelope.event) return;
    if (envelope.event_id && !(await store.markEventSeen(envelope.event_id))) return;

    const route = routeEvent(envelope.event, { botUserId });
    if (!route || !route.text) return;

    if (!canPostIn(route.channel, { isDm: route.isDm, allowedChannels: config.allowedChannels })) {
      log.info('Ignoring message in a channel that is not allowlisted', { channel: route.channel });
      return;
    }

    if (route.kind === 'thread_followup' && !(await store.getSession(route.sessionKey))) return;

    if (route.isDm) {
      const command = parseCommand(route.text);
      if (command) return enqueue(route.sessionKey, () => handleCommand(route, command));
    }

    return enqueue(route.sessionKey, () => converse(route));
  }

  function readBody(req, limit = 1_000_000) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function sendPage(res, status, message) {
    const safe = message.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AltWire Insights</title><body style="font-family:system-ui,sans-serif;max-width:420px;margin:64px auto;padding:0 16px;line-height:1.5"><h1 style="font-size:1.2rem">AltWire Insights</h1><p>${safe}</p></body>`);
  }


  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'altwire-slack-bridge' }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/slack/events') {
        const body = await readBody(req);
        const valid = verifySlackSignature({
          signingSecret: config.slackSigningSecret,
          timestamp: req.headers['x-slack-request-timestamp'],
          signature: req.headers['x-slack-signature'],
          body,
        });
        if (!valid) {
          res.writeHead(401).end();
          return;
        }
        const envelope = JSON.parse(body);
        if (envelope.type === 'url_verification') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(envelope.challenge);
          return;
        }
        // Acknowledge within Slack's 3-second window; work continues in the background.
        res.writeHead(200).end();
        handleSlackEvent(envelope).catch((err) => log.error('Event handling failed', { error: err.message }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/oauth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (url.searchParams.get('error')) {
          if (state) await store.takeOAuthState(state);
          sendPage(res, 400, 'Sign-in was cancelled. Send the connect command again in Slack to retry.');
          return;
        }
        if (!code || !state) {
          sendPage(res, 400, 'This page needs to be opened from a sign-in link sent in Slack.');
          return;
        }
        const result = await completeConnect({ code, state });
        sendPage(res, result.ok ? 200 : 400, result.message);
        return;
      }

      res.writeHead(404).end();
    } catch (err) {
      log.error('Request failed', { path: url.pathname, error: err.message });
      if (!res.headersSent) res.writeHead(500).end();
    }
  }

  async function runScheduledJob(job) {
    log.info('Scheduled job started', { job: job.name });
    try {
      const sessionId = await createSession(anthropic, {
        agent: config.agentId,
        environmentId: config.environmentId,
        vaultIds: config.sharedVaultId ? [config.sharedVaultId] : [],
        resources: memoryResourcesFor({ isDm: false, memoryStoreId: config.memoryStoreId }),
        title: `Scheduled: ${job.name}`,
      });
      const result = await runTurn(anthropic, sessionId, scheduledPrompt(job), { logger: log });
      if (result.stopReason !== 'end_turn') {
        log.warn('Scheduled job did not finish cleanly; not posting', { job: job.name, stopReason: result.stopReason });
        return;
      }
      if (isMultiOutput(job)) {
        const delivered = await deliverJobOutputs(job, sessionId, result.text);
        await recordRun(job, delivered.entry);
        delete delivered.entry;
        return delivered;
      }
      const postTs = await postReply({ channel: job.channel, text: result.text });
      await deliverFiles({ sessionId, channel: job.channel, threadTs: postTs });
      // Replies in the post's thread continue this session, so people can
      // answer the job (e.g. approve a proposed batch) with its context.
      if (postTs) {
        await store.saveSession(`${job.channel}:${postTs}`, {
          sessionId,
          slackUserId: 'scheduled',
          vaultIds: config.sharedVaultId ? [config.sharedVaultId] : [],
        });
      }
      log.info('Scheduled job posted', { job: job.name, channel: job.channel });
      await recordRun(job, postEntry({ now: new Date(), timeZone: job.timezone, text: result.text }));
      return { posted: [job.channel] };
    } catch (err) {
      log.error('Scheduled job failed', { job: job.name, error: err.message });
      return { error: err.message };
    }
  }

  /** Add what a run sent to its log in the team memory. Never fails the job. */
  async function recordRun(job, entry) {
    if (!job.log || job.preview || !entry) return;
    if (!config.memoryStoreId) {
      log.warn('Job has a log but no team memory store is configured', { job: job.name });
      return;
    }
    try {
      const how = await appendRunLog(anthropic, config.memoryStoreId, job.log, entry);
      log.info('Run logged', { job: job.name, path: job.log.path, how });
    } catch (err) {
      log.error('Run log update failed', { job: job.name, path: job.log.path, error: err.message });
    }
  }

  /**
   * Deliver a multi-output job: the email, then each Slack route that has
   * action items. If the agent ignored the section format, nothing is lost:
   * the whole reply goes to the job's channel.
   */
  async function deliverJobOutputs(job, sessionId, text) {
    const out = parseJobOutput(text, job);
    const delivered = { emailed: false, posted: [] };

    if (!out.found) {
      log.warn('Scheduled job reply had no sections; posting it whole', { job: job.name });
      const ts = await postReply({ channel: job.channel, text });
      await deliverFiles({ sessionId, channel: job.channel, threadTs: ts });
      delivered.posted.push(job.channel);
      delivered.entry = postEntry({ now: new Date(), timeZone: job.timezone, text });
      return delivered;
    }

    // Preview: show the Slack action items in the email instead of posting them.
    let emailBody = out.email;
    if (job.preview && out.email) {
      const routeName = (name) => job.routes.find((r) => r.name === name);
      const previews = (job.routes ?? []).map((r) => {
        const item = out.slack.find((x) => x.route === r.name);
        return `### Slack: ${r.name}${routeName(r.name)?.about ? ` (${routeName(r.name).about})` : ''}\n\n${item ? item.text : '_Nothing for this channel today._'}`;
      });
      if (previews.length) emailBody = `${out.email}\n\n---\n\n## Slack action items (preview, not posted)\n\n${previews.join('\n\n')}`;
    }

    if (job.email) {
      if (!out.email) {
        log.warn('Scheduled job wrote no email section', { job: job.name });
      } else if (!mailer) {
        log.error('Scheduled job has an email but no mailer is configured (BRIDGE_EMAIL_FROM / AWS credentials)', { job: job.name });
      } else {
        try {
          await mailer.send({
            to: job.email.to,
            cc: job.email.cc,
            subject: out.subject ? `${job.email.subject}: ${out.subject}` : job.email.subject,
            html: emailDocument(emailBody, { footer: `Written by AltWire Insights (scheduled job "${job.name}"). Reply in Slack to ask follow-up questions.` }),
            text: emailText(emailBody),
          });
          delivered.emailed = true;
          log.info('Scheduled job emailed', { job: job.name, to: job.email.to.length, cc: job.email.cc.length });
        } catch (err) {
          log.error('Scheduled job email failed', { job: job.name, error: err.message });
        }
      }
    }

    let firstPost = null;
    for (const item of job.preview ? [] : out.slack) {
      try {
        const ts = await postReply({ channel: item.channel, text: item.text });
        firstPost ??= { channel: item.channel, ts };
        delivered.posted.push(item.channel);
      } catch (err) {
        log.error('Scheduled job Slack post failed', { job: job.name, route: item.route, error: err.message });
      }
    }
    if (firstPost) await deliverFiles({ sessionId, channel: firstPost.channel, threadTs: firstPost.ts });
    log.info('Scheduled job delivered', { job: job.name, emailed: delivered.emailed, posted: delivered.posted });
    delivered.entry = digestEntry({
      now: new Date(),
      timeZone: job.timezone,
      subject: out.subject,
      routes: job.routes,
      slack: out.slack,
      emailed: job.email ? delivered.emailed : undefined,
    });
    return delivered;
  }

  return {
    handleSlackEvent,
    handleHttp,
    runScheduledJob,
    setBotUserId: (id) => { botUserId = id; },
    idle: () => Promise.all([...queues.values()]),
  };
}
