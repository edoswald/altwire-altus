import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  isConsentConfigured,
  isLoopbackRedirect,
  renderConsentPage,
  validateRegistrationRedirects,
  verifyConsentPassphrase,
} from '../lib/oauth-consent.js';

const allowed = new Set([
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]);

describe('validateRegistrationRedirects', () => {
  it('accepts Claude hosted callbacks and loopback callbacks', () => {
    const uris = ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:53123/callback', 'http://127.0.0.1:8080/'];
    expect(validateRegistrationRedirects(uris, allowed)).toEqual({ ok: true, redirectUris: uris });
  });

  it('rejects arbitrary third-party hosts', () => {
    const result = validateRegistrationRedirects(['https://claude.ai/api/mcp/auth_callback', 'https://evil.example/cb'], allowed);
    expect(result.ok).toBe(false);
    expect(result.rejected).toEqual(['https://evil.example/cb']);
  });

  it('rejects look-alike loopback hosts', () => {
    expect(isLoopbackRedirect('http://localhost.evil.example/cb')).toBe(false);
    expect(isLoopbackRedirect('http://127.0.0.1.evil.example/cb')).toBe(false);
  });

  it('rejects missing or empty redirect_uris', () => {
    expect(validateRegistrationRedirects(undefined, allowed).ok).toBe(false);
    expect(validateRegistrationRedirects([], allowed).ok).toBe(false);
    expect(validateRegistrationRedirects([42], allowed).ok).toBe(false);
  });
});

describe('consent passphrase', () => {
  const env = { ALTUS_OAUTH_CONSENT_PASSPHRASE: 'correct horse' };

  it('fails closed when no passphrase is configured', () => {
    expect(isConsentConfigured({})).toBe(false);
    expect(verifyConsentPassphrase('anything', {})).toBe(false);
    expect(verifyConsentPassphrase('', {})).toBe(false);
  });

  it('accepts only the exact passphrase', () => {
    expect(isConsentConfigured(env)).toBe(true);
    expect(verifyConsentPassphrase('correct horse', env)).toBe(true);
    expect(verifyConsentPassphrase('correct horse ', env)).toBe(false);
    expect(verifyConsentPassphrase(null, env)).toBe(false);
  });
});

describe('renderConsentPage', () => {
  it('escapes client-controlled values', () => {
    const html = renderConsentPage({
      params: { client_id: 'dyn_1', redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code', state: '"><script>x</script>' },
      clientName: '<img src=x onerror=alert(1)>',
      redirectHost: 'claude.ai',
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain(escapeHtml('"><script>x</script>'));
    expect(html).toContain('name="passphrase"');
  });

  it('carries authorize params as hidden fields and omits empty ones', () => {
    const html = renderConsentPage({
      params: { client_id: 'dyn_1', redirect_uri: 'https://claude.ai/api/mcp/auth_callback', response_type: 'code', code_challenge: 'abc', state: null },
      clientName: 'Claude',
      redirectHost: 'claude.ai',
    });
    expect(html).toContain('name="code_challenge" value="abc"');
    expect(html).not.toContain('name="state"');
  });
});
