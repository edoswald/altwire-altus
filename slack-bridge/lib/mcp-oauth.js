/**
 * OAuth client for connecting a person's account on a remote MCP server
 * (Zoho MCP, Canva, …) into their Managed Agents vault.
 *
 * Follows the MCP authorization spec: protected-resource metadata (RFC 9728)
 * → authorization-server metadata (RFC 8414 / OIDC) → dynamic client
 * registration (RFC 7591) → authorization code + PKCE with `resource`
 * (RFC 8707). The resulting tokens become an `mcp_oauth` vault credential,
 * which Anthropic refreshes from then on.
 */

import crypto from 'node:crypto';

// Connections people can name instead of pasting a URL.
export const KNOWN_SERVERS = {
  canva: { label: 'Canva', url: 'https://mcp.canva.com/mcp' },
};

export const UNSUPPORTED = {
  gmail: 'Gmail has no public MCP server that can sign in to an agent vault. Forward the AltWire mail you want the agent to see into Zoho, or ask Ed about adding a Gmail tool to Altus.',
  zoho: 'Zoho needs your own server URL. Create a server with Zoho Mail tools at https://www.zoho.com/mcp/, then send: connect <that URL>',
};

/** Resolve a `connect` argument to { label, url } or { error }. */
export function resolveServer(arg) {
  const key = String(arg ?? '').trim().toLowerCase();
  if (KNOWN_SERVERS[key]) return { ...KNOWN_SERVERS[key] };
  if (UNSUPPORTED[key]) return { error: UNSUPPORTED[key] };
  let url;
  try {
    url = new URL(String(arg).trim());
  } catch {
    return { error: `I don't know "${arg}". Use canva, or paste an https MCP server URL.` };
  }
  if (url.protocol !== 'https:') return { error: 'MCP server URLs must use https.' };
  url.hash = '';
  const label = url.hostname.includes('zoho') ? 'Zoho' : url.hostname;
  return { label, url: url.toString() };
}

function wellKnownCandidates(base, name) {
  const u = new URL(base);
  const path = u.pathname.replace(/\/+$/, '');
  const list = [];
  if (path) list.push(`${u.origin}/.well-known/${name}${path}`);
  list.push(`${u.origin}/.well-known/${name}`);
  return list;
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Discover the authorization server for an MCP server URL.
 * @returns {Promise<{ resource: string, scopes: string[], authorizationEndpoint: string, tokenEndpoint: string, registrationEndpoint: string|null }>}
 */
export async function discover(serverUrl, { fetchImpl = fetch } = {}) {
  let prm = null;
  for (const candidate of wellKnownCandidates(serverUrl, 'oauth-protected-resource')) {
    prm = await getJson(fetchImpl, candidate);
    if (prm) break;
  }
  const issuer = prm?.authorization_servers?.[0] ?? new URL(serverUrl).origin;

  let as = null;
  const asCandidates = [
    ...wellKnownCandidates(issuer, 'oauth-authorization-server'),
    ...wellKnownCandidates(issuer, 'openid-configuration'),
  ];
  const issuerUrl = new URL(issuer);
  if (issuerUrl.pathname.replace(/\/+$/, '')) {
    asCandidates.push(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  }
  for (const candidate of asCandidates) {
    as = await getJson(fetchImpl, candidate);
    if (as?.authorization_endpoint && as?.token_endpoint) break;
    as = null;
  }
  if (!as) throw new Error(`Could not find OAuth metadata for ${serverUrl}`);

  return {
    resource: prm?.resource ?? serverUrl,
    scopes: Array.isArray(prm?.scopes_supported) ? prm.scopes_supported : [],
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint ?? null,
    codeChallengeMethods: as.code_challenge_methods_supported ?? null,
  };
}

/** RFC 7591 dynamic client registration. */
export async function registerClient(registrationEndpoint, { redirectUri, clientName, fetchImpl = fetch }) {
  if (!registrationEndpoint) throw new Error('This server does not support automatic client registration.');
  const res = await fetchImpl(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.client_id) throw new Error(`Client registration failed (${res.status}): ${data.error ?? 'no client_id'}`);
  return {
    clientId: data.client_id,
    clientSecret: data.client_secret ?? null,
    authMethod: data.token_endpoint_auth_method ?? (data.client_secret ? 'client_secret_basic' : 'none'),
  };
}

export function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl({ authorizationEndpoint, clientId, redirectUri, state, codeChallenge, resource, scopes }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (resource) url.searchParams.set('resource', resource);
  if (scopes?.length) url.searchParams.set('scope', scopes.join(' '));
  return url.toString();
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode({ tokenEndpoint, code, redirectUri, clientId, clientSecret, authMethod, codeVerifier, resource, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  if (resource) body.set('resource', resource);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (clientSecret && authMethod === 'client_secret_post') body.set('client_secret', clientSecret);
  if (clientSecret && authMethod === 'client_secret_basic') {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
  }
  const res = await fetchImpl(tokenEndpoint, { method: 'POST', headers, body: body.toString() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Token exchange failed (${res.status}): ${data.error_description ?? data.error ?? 'no access_token'}`);
  return data;
}

/** Build the `auth` block of an `mcp_oauth` vault credential. */
export function buildVaultAuth({ serverUrl, tokens, clientId, clientSecret, authMethod, tokenEndpoint, resource, scopes, now = Date.now() }) {
  const auth = {
    type: 'mcp_oauth',
    mcp_server_url: serverUrl,
    access_token: tokens.access_token,
  };
  if (tokens.expires_in) auth.expires_at = new Date(now + Number(tokens.expires_in) * 1000).toISOString();
  if (tokens.refresh_token) {
    let tokenEndpointAuth = { type: 'none' };
    if (clientSecret && authMethod === 'client_secret_post') tokenEndpointAuth = { type: 'client_secret_post', client_secret: clientSecret };
    else if (clientSecret) tokenEndpointAuth = { type: 'client_secret_basic', client_secret: clientSecret };
    auth.refresh = {
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      token_endpoint: tokenEndpoint,
      token_endpoint_auth: tokenEndpointAuth,
      ...(resource && { resource }),
      ...((tokens.scope || scopes?.length) && { scope: tokens.scope ?? scopes.join(' ') }),
    };
  }
  return auth;
}

/** Normalize a server URL the way vault matching does (host lowercased, trailing slash dropped). */
export function normalizeServerUrl(url) {
  const u = new URL(url);
  u.hash = '';
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}
