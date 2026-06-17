import { createHmac, timingSafeEqual } from 'node:crypto';

// Known primary admins and their fixed scopes.
// All other HAL_KEY_*_WEB env vars are discovered dynamically and assigned 'guest' scope.
// NOTE: scope is a permission tier and is carried in the signed session token,
// which is honored cross-service (Altus + Nimbus share HAL_SESSION_SECRET). Do
// NOT downgrade Ed to 'guest' here to "protect" Derek's memory — memory is
// isolated by admin_id namespace (hal:mem:{admin_id}:...), not by scope, so a
// full-scoped Ed still only writes to Ed's namespace. A guest scope here bleeds
// into Nimbus and locks Ed (the platform owner) out of his own admin tools.
const PRIMARY_ADMINS = new Map([
  ['HAL_KEY_ED_WEB',    { name: 'Ed',    scope: 'full' }],
  ['HAL_KEY_DEREK_WEB', { name: 'Derek', scope: 'operational' }],
]);

/**
 * Derive a display name from a HAL_KEY_*_WEB env var key.
 * HAL_KEY_TEST_WEB          → "Test"
 * HAL_KEY_ALTWIRE_BETA_WEB  → "AltwireBeta"
 */
function nameFromEnvVar(envVar) {
  const inner = envVar.slice('HAL_KEY_'.length, -'_WEB'.length); // e.g. "ALTWIRE_BETA"
  return inner
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

/**
 * Build the web key registry by scanning ALL HAL_KEY_*_WEB env vars.
 * Primary admins (Ed, Derek) get their fixed scopes; everything else is 'guest'.
 */
function buildWebKeyRegistry(env) {
  const entries = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('HAL_KEY_') || !key.endsWith('_WEB') || !value) continue;
    const primary = PRIMARY_ADMINS.get(key);
    entries.push({
      envVar: key,
      name: primary?.name ?? nameFromEnvVar(key),
      scope: primary?.scope ?? 'guest',
    });
  }
  return entries;
}

function getSessionSecret(env) {
  return env.HAL_SESSION_SECRET || '';
}

function toBase64url(str) {
  return Buffer.from(str).toString('base64url');
}

function fromBase64url(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

export function validateHalWebApiKey(token, env = process.env) {
  if (!token) return null;
  for (const { envVar, name, scope } of buildWebKeyRegistry(env)) {
    if (env[envVar] && token === env[envVar]) {
      return { name, interface: 'web', autonomous: false, scope };
    }
  }
  return null;
}

export function signHalWebSessionToken(identity, env = process.env) {
  const secret = getSessionSecret(env);
  if (!secret) throw new Error('HAL_SESSION_SECRET missing');
  const header = toBase64url(JSON.stringify({ alg: 'HS256', typ: 'HAL' }));
  const exp = Math.floor(Date.now() / 1000) + 8 * 60 * 60;
  const payload = toBase64url(JSON.stringify({ ...identity, exp }));
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyHalWebSessionToken(token, env = process.env) {
  if (!token || typeof token !== 'string') return null;
  const secret = getSessionSecret(env);
  if (!secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expected = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  try {
    const sigBuf = Buffer.from(signature, 'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
  } catch {
    return null;
  }

  try {
    const decoded = JSON.parse(fromBase64url(payload));
    const now = Math.floor(Date.now() / 1000);
    if (!decoded.exp || decoded.exp < now) return null;
    if (decoded.interface !== 'web') return null;
    return {
      name: decoded.name,
      interface: decoded.interface,
      autonomous: decoded.autonomous,
      scope: decoded.scope ?? 'full',
    };
  } catch {
    return null;
  }
}

export function authenticateHalWebToken(token, env = process.env) {
  return validateHalWebApiKey(token, env) || verifyHalWebSessionToken(token, env);
}

export function resolveCompatibleClientId(identity, env = process.env) {
  if (!identity?.name) return null;
  const envKey = `OAUTH_CLIENT_ID_${identity.name.toUpperCase()}`;
  return env[envKey] || `hal-web:${identity.name.toLowerCase()}`;
}

export function identifyCompatibleHalClient(token, env = process.env) {
  const identity = authenticateHalWebToken(token, env);
  if (!identity) return null;
  return resolveCompatibleClientId(identity, env);
}

export function isAllowedAltusRestToken(
  token,
  { allowHalKey = false, allowAltusAdminToken = false } = {},
  env = process.env,
) {
  if (!token) return false;
  if (allowHalKey && env.HAL_KEY && token === env.HAL_KEY) return true;
  if (allowAltusAdminToken && env.ALTUS_ADMIN_TOKEN && token === env.ALTUS_ADMIN_TOKEN) return true;
  return !!authenticateHalWebToken(token, env);
}
