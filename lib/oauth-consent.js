/**
 * OAuth consent + redirect policy for the Altus authorization server.
 *
 * /authorize used to issue a code to any registered client without a human in
 * the loop, and /oauth/register accepted any redirect_uri. Together that let
 * anyone who found the URL mint a token for the full tool set. This module
 * gates both:
 *
 *   - registration only accepts Claude's hosted callbacks, loopback callbacks
 *     (Claude Code / Desktop), or URIs on the OAUTH_ALLOWED_REDIRECT_URIS list
 *   - /authorize renders a consent page; a code is only issued after the
 *     operator enters ALTUS_OAUTH_CONSENT_PASSPHRASE. Unset → fail closed.
 *
 * Exports are pure (env passed in) so they can be unit tested without
 * booting index.js.
 */

import crypto from 'crypto';

const LOOPBACK_REDIRECT_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

export function isLoopbackRedirect(uri) {
  return typeof uri === 'string' && LOOPBACK_REDIRECT_RE.test(uri);
}

/**
 * Validate the redirect_uris a client asks to register via RFC 7591 DCR.
 * Returns { ok: true, redirectUris } or { ok: false, rejected: [...] }.
 */
export function validateRegistrationRedirects(redirectUris, allowedRedirectUris) {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return { ok: false, rejected: [] };
  }
  const rejected = redirectUris.filter(
    (uri) => typeof uri !== 'string' || !(isLoopbackRedirect(uri) || allowedRedirectUris.has(uri)),
  );
  return rejected.length ? { ok: false, rejected } : { ok: true, redirectUris };
}

export function isConsentConfigured(env = process.env) {
  return Boolean(env.ALTUS_OAUTH_CONSENT_PASSPHRASE);
}

/** Constant-time passphrase check. False when no passphrase is configured. */
export function verifyConsentPassphrase(presented, env = process.env) {
  const expected = env.ALTUS_OAUTH_CONSENT_PASSPHRASE;
  if (!expected || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Authorization request params carried from GET /authorize through the
// consent form to POST /authorize.
export const AUTHORIZE_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
];

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const CONSENT_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  // No form-action directive: Chrome applies it to the post-submit redirect,
  // which would block the hop back to the client's redirect_uri.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

/**
 * Render the consent page. `params` is a plain object of AUTHORIZE_PARAMS.
 */
export function renderConsentPage({ params, clientName, redirectHost, error = null }) {
  const hidden = AUTHORIZE_PARAMS
    .filter((k) => params[k] != null && params[k] !== '')
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k])}">`)
    .join('\n      ');
  const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Altus</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f6f6f4; color: #1d1d1b; margin: 0; padding: 48px 16px; }
    main { max-width: 420px; margin: 0 auto; background: #fff; border-radius: 10px; padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    h1 { font-size: 1.25rem; margin: 0 0 12px; }
    p { line-height: 1.45; }
    label { display: block; font-weight: 600; margin: 16px 0 6px; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: 10px; font-size: 1rem; border: 1px solid #c8c8c4; border-radius: 6px; }
    button { margin-top: 16px; width: 100%; padding: 10px; font-size: 1rem; border: 0; border-radius: 6px; background: #1d1d1b; color: #fff; cursor: pointer; }
    .error { color: #a4161a; font-weight: 600; }
    code { background: #f0f0ec; padding: 1px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <h1>Connect to Altus</h1>
    <p><strong>${escapeHtml(clientName || 'An MCP client')}</strong> is requesting access to the AltWire Altus tools and will be redirected to <code>${escapeHtml(redirectHost)}</code>.</p>
    ${errorBlock}
    <form method="post" action="/authorize">
      ${hidden}
      <label for="passphrase">Altus admin passphrase</label>
      <input id="passphrase" name="passphrase" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>`;
}
