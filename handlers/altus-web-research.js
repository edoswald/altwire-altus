import { searchAltwirePublic } from './altwire-search.js';

const BINARY_EXTENSIONS = ['.pdf', '.zip', '.exe', '.dmg', '.iso', '.tar', '.gz'];

export function isPrivateUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
      return true;
    }
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function isBinaryUrl(url) {
  const lower = (url || '').toLowerCase();
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function altusWebResearch({ query, limit = 5 } = {}) {
  const result = await searchAltwirePublic({ query, limit });
  return {
    success: !result.error,
    query,
    answer: result.answer ?? '',
    citations: result.citations ?? [],
    results: result.results ?? [],
    error: result.error ?? null,
    count: result.results?.length ?? 0,
  };
}
