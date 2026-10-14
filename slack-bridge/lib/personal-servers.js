/**
 * Personal MCP servers for DM sessions.
 *
 * A vault credential is only used for an MCP server the session declares. A
 * person's linked accounts (Canva, their own Zoho MCP server, …) are declared
 * only in their DM sessions, as a session-local override on top of the
 * agent's own servers and tools. Channel sessions never see them.
 */

import { normalizeServerUrl } from './mcp-oauth.js';

function slug(label) {
  return String(label || 'account').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'account';
}

/** Active MCP credentials in a vault → [{ label, url }]. */
export function personalServersFromCredentials(credentials) {
  return credentials
    .filter((c) => !c.archived_at && c.auth?.mcp_server_url)
    .map((c) => ({ label: c.display_name || new URL(c.auth.mcp_server_url).hostname, url: c.auth.mcp_server_url }));
}

/**
 * Session override that adds personal servers to the agent's config.
 * Returns null when there is nothing to add.
 *
 * @param {{ id: string, version?: number, mcp_servers?: Array, tools?: Array }} agent
 * @param {Array<{ label: string, url: string }>} personal
 */
export function buildPersonalOverride(agent, personal) {
  const baseServers = (agent.mcp_servers ?? []).map(({ type, name, url }) => ({ type, name, url }));
  const known = new Set(baseServers.map((s) => normalizeServerUrl(s.url)));
  const names = new Set(baseServers.map((s) => s.name));

  const added = [];
  for (const p of personal) {
    const normalized = normalizeServerUrl(p.url);
    if (known.has(normalized)) continue;
    known.add(normalized);
    let name = `personal_${slug(p.label)}`;
    for (let i = 2; names.has(name); i += 1) name = `personal_${slug(p.label)}_${i}`;
    names.add(name);
    added.push({ type: 'url', name, url: p.url });
  }
  if (!added.length) return null;

  return {
    type: 'agent_with_overrides',
    id: agent.id,
    ...(agent.version != null && { version: agent.version }),
    mcp_servers: [...baseServers, ...added],
    tools: [
      ...(agent.tools ?? []),
      ...added.map((s) => ({
        type: 'mcp_toolset',
        mcp_server_name: s.name,
        default_config: { enabled: true, permission_policy: { type: 'auto' } },
      })),
    ],
  };
}
