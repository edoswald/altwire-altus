const HAL_UI_ROUTE_PREFIXES = [
  '/hal/chat-sessions',
  '/hal/writer/',
  '/altwire/',
];

export function getHalUiRateLimitBucket(method, pathname) {
  if (method === 'OPTIONS') return null;
  if (pathname === '/hal/chat') return 'chat';
  if (HAL_UI_ROUTE_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix))) {
    return 'ui';
  }
  return null;
}
