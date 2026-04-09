import { describe, it, expect } from 'vitest';
import { safeToolHandler } from '../lib/safe-tool-handler.js';

describe('safeToolHandler', () => {
  it('returns handler result on success', async () => {
    const handler = safeToolHandler(async () => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
    }));
    const result = await handler({});
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });

  it('catches thrown error and returns structured exit_reason tool_error', async () => {
    const handler = safeToolHandler(async () => {
      throw new Error('database exploded');
    });
    const result = await handler({});
    const body = JSON.parse(result.content[0].text);
    expect(body.exit_reason).toBe('tool_error');
    expect(body.success).toBe(false);
  });

  it('passes params through to the handler', async () => {
    const handler = safeToolHandler(async ({ query }) => ({
      content: [{ type: 'text', text: query }],
    }));
    const result = await handler({ query: 'hello' });
    expect(result.content[0].text).toBe('hello');
  });
});
