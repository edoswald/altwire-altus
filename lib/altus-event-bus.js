/**
 * altus-event-bus.js
 *
 * Simple per-session in-memory event bus for SSE tool events.
 * Key: sessionId, Value: Array of SSE-formatted event strings.
 *
 * Used by GET /events/:sessionId to stream tool_start/tool_done/thinking_done
 * events to the Chat UI in real-time.
 *
 * Events format:
 *   data: {"event":"tool_start","tool":"generate_article_draft","label":"Generate article draft","iteration":1}\n\n
 *   data: {"event":"tool_done","tool":"generate_article_draft","success":true,"summary":"..."}\n\n
 */

const bus = new Map();

function formatEvent(eventObj) {
  return `data: ${JSON.stringify(eventObj)}\n\n`;
}

export function emitEvent(sessionId, eventObj) {
  if (!bus.has(sessionId)) {
    bus.set(sessionId, []);
  }
  bus.get(sessionId).push(formatEvent(eventObj));
}

export function getEvents(sessionId) {
  if (!bus.has(sessionId)) {
    return '';
  }
  const events = bus.get(sessionId);
  bus.set(sessionId, []);
  return events.join('');
}

export function clearBus(sessionId) {
  bus.delete(sessionId);
}

export function hasEvents(sessionId) {
  const events = bus.get(sessionId);
  return events && events.length > 0;
}