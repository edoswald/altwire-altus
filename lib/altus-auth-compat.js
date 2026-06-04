import { createHmac, timingSafeEqual } from 'node:crypto';

const WEB_KEY_ENV_VARS = [
  { envVar: 'HAL_KEY_ED_WEB', name: 'Ed' },
  { envVar: 'HAL_KEY_DEREK_WEB', name: 'Derek' },
];

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
  for (const { envVar, name } of WEB_KEY_ENV_VARS) {
    if (env[envVar] && token === env[envVar]) {
      return { name, interface: 'web', autonomous: false, scope: name === 'Ed' ? 'full' : 'operational' };
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
