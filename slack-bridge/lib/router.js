/**
 * Routing rules for Slack events: which ones the bridge handles, which agent
 * session they belong to, which vaults that session may use, and where the
 * reply may be posted. Pure functions; no I/O.
 */

/**
 * Turn a Slack Events API `event` into a routed request, or null to ignore it.
 *
 * - app_mention in a channel → reply in a thread (one session per thread)
 * - message in a 1:1 DM → reply in the DM; threaded DMs get one session per
 *   thread, top-level DM messages share a rolling per-DM session
 * - message in a channel thread → only a follow-up (caller checks the thread
 *   already has a session), never a new conversation
 */
export function routeEvent(event, { botUserId }) {
  if (!event || typeof event !== 'object') return null;
  if (event.bot_id || event.user === botUserId) return null;
  if (event.subtype && event.subtype !== 'thread_broadcast') return null; // edits, joins, deletes, bot posts
  if (!event.user || !event.channel) return null;

  const text = stripMention(event.text ?? '', botUserId).trim();
  const threadTs = event.thread_ts ?? null;

  if (event.type === 'app_mention') {
    const replyThreadTs = threadTs ?? event.ts;
    return {
      kind: 'mention',
      channel: event.channel,
      user: event.user,
      text,
      isDm: false,
      sessionKey: `${event.channel}:${replyThreadTs}`,
      replyThreadTs,
    };
  }

  if (event.type !== 'message') return null;

  if (event.channel_type === 'im') {
    return {
      kind: 'dm',
      channel: event.channel,
      user: event.user,
      text,
      isDm: true,
      sessionKey: threadTs ? `${event.channel}:${threadTs}` : `${event.channel}:dm`,
      replyThreadTs: threadTs,
      rolling: !threadTs,
    };
  }

  // Channel messages: thread follow-ups only, and not ones that @mention the
  // bot (those also arrive as app_mention and are handled there).
  if (threadTs && !mentions(event.text ?? '', botUserId)) {
    return {
      kind: 'thread_followup',
      channel: event.channel,
      user: event.user,
      text,
      isDm: false,
      sessionKey: `${event.channel}:${threadTs}`,
      replyThreadTs: threadTs,
    };
  }
  return null;
}

function mentions(text, botUserId) {
  return Boolean(botUserId) && text.includes(`<@${botUserId}>`);
}

export function stripMention(text, botUserId) {
  if (!botUserId) return text;
  return text.split(`<@${botUserId}>`).join('').replace(/\s{2,}/g, ' ');
}

/**
 * Vaults a session may use. Personal vaults (mail, Canva) are attached only
 * in a 1:1 DM with their owner, so a personal inbox never reaches a channel.
 */
export function vaultsFor({ isDm, user, sharedVaultId, personalVaultId }) {
  const vaults = [];
  if (sharedVaultId) vaults.push(sharedVaultId);
  if (isDm && user && personalVaultId) vaults.push(personalVaultId);
  return vaults;
}

/** Whether the bridge may post in this channel (DMs always; channels only if allowlisted). */
export function canPostIn(channel, { isDm, allowedChannels }) {
  if (isDm) return true;
  return allowedChannels.has(channel);
}

/**
 * Bridge commands, recognized only in DMs. Everything else goes to the agent.
 *   help | connections | new
 *   connect <name or https URL> | disconnect <name or https URL>
 */
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim();
  const m = trimmed.match(/^(help|connections|new|connect|disconnect|memory|run)\b\s*(.*)$/i);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const arg = m[2].trim().replace(/^<(https?:\/\/[^|>]+)(\|[^>]*)?>$/, '$1'); // Slack wraps URLs as <url|label>
  const takesArg = name === 'connect' || name === 'disconnect' || name === 'run';
  if (takesArg && !arg) return name === 'run' ? null : { name: 'help' };
  if (name === 'run' && !/^[\w-]+$/.test(arg)) return null; // "run the numbers for me" is a question
  if (!takesArg && arg) return null; // "new album ideas?" is a question, not a command
  return arg ? { name, arg } : { name };
}

export function parseCsvSet(value) {
  return new Set(String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}
