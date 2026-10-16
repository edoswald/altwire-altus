/**
 * Run one turn of a Managed Agents session: send a user message, stream the
 * agent's events until it finishes, and return the text it wrote.
 *
 * Follows the documented client patterns: open the stream before sending,
 * keep streaming through `requires_action` idles, and answer any tool call
 * that pauses for approval. Nobody can approve calls from Slack, so paused
 * calls are denied with a reason the agent sees.
 */

const DENY_MESSAGE = 'No one is available to approve tool calls from Slack. Continue without this call, or explain what you would need.';

/**
 * @param {string|object} agent  agent id, or an `agent_with_overrides` object
 * @param {Array<object>} [resources]  session resources (e.g. the shared memory store)
 */
export async function createSession(client, { agent, environmentId, vaultIds, resources = [], title }) {
  const session = await client.beta.sessions.create({
    agent,
    environment_id: environmentId,
    vault_ids: vaultIds,
    ...(resources.length ? { resources } : {}),
    title,
  });
  return session.id;
}

/**
 * @returns {Promise<{ text: string, stopReason: string, toolCalls: number }>}
 */
export async function runTurn(client, sessionId, text, { timeoutMs = 10 * 60 * 1000, logger = console, onStep = null } = {}) {
  // Progress callbacks are best-effort: they must never break the turn.
  const step = (fn) => {
    if (!onStep) return;
    try { fn(onStep); } catch (err) { logger.warn?.('progress callback failed', { error: err.message }); }
  };
  const stream = await client.beta.sessions.events.stream(sessionId);
  await client.beta.sessions.events.send(sessionId, {
    events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
  });

  const messages = [];
  let stopReason = 'unknown';
  let toolCalls = 0;
  let timedOut = false;
  const timer = setTimeout(async () => {
    timedOut = true;
    try {
      await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] });
    } catch (err) {
      logger.warn?.('interrupt failed', { sessionId, error: err.message });
    }
  }, timeoutMs);

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'agent.message': {
          const blockText = (event.content ?? [])
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text)
            .join('');
          if (blockText.trim()) messages.push(blockText.trim());
          break;
        }
        case 'agent.tool_use':
        case 'agent.mcp_tool_use':
          toolCalls += 1;
          step((cb) => cb.start?.(event.id, event.name, event.input));
          if (event.evaluated_permission === 'ask') {
            await client.beta.sessions.events.send(sessionId, {
              events: [{ type: 'user.tool_confirmation', tool_use_id: event.id, result: 'deny', deny_message: DENY_MESSAGE }],
            });
          }
          break;
        case 'agent.tool_result':
          step((cb) => cb.end?.(event.tool_use_id, Boolean(event.is_error)));
          break;
        case 'agent.mcp_tool_result':
          step((cb) => cb.end?.(event.mcp_tool_use_id, Boolean(event.is_error)));
          break;
        case 'agent.custom_tool_use':
          // The agent has no custom tools; answer so the session never hangs.
          await client.beta.sessions.events.send(sessionId, {
            events: [{
              type: 'user.custom_tool_result',
              custom_tool_use_id: event.id,
              is_error: true,
              content: [{ type: 'text', text: `Tool ${event.name} is not available.` }],
            }],
          });
          break;
        case 'session.status_terminated':
          stopReason = 'terminated';
          return finish();
        case 'session.status_idle':
          if (event.stop_reason?.type === 'requires_action') break;
          stopReason = event.stop_reason?.type ?? 'end_turn';
          return finish();
        default:
          break;
      }
    }
    stopReason = 'stream_closed';
    return finish();
  } finally {
    clearTimeout(timer);
  }

  function finish() {
    return {
      text: replyText(messages, { stopReason, timedOut }),
      stopReason: timedOut ? 'timeout' : stopReason,
      toolCalls,
    };
  }
}

/**
 * The reply to post: the agent's last message (its answer), or an
 * explanation when it ended without one.
 */
export function replyText(messages, { stopReason, timedOut = false }) {
  const last = messages.at(-1);
  if (timedOut) return `${last ? `${last}\n\n` : ''}_(Stopped after 10 minutes. Ask again with a narrower question.)_`;
  if (last) return last;
  if (stopReason === 'retries_exhausted') return '_The agent hit an error and could not finish. Try again in a minute._';
  if (stopReason === 'budget_reached') return '_This conversation reached its spending limit. Start a new thread._';
  return '_The agent finished without a reply._';
}
