import { describe, expect, it, vi } from 'vitest';
import { createAnthropicMessageStream } from '../lib/anthropic-message-stream.js';

describe('createAnthropicMessageStream', () => {
  it('uses the raw streaming create API instead of the SDK stream helper', async () => {
    const fakeStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start' };
      },
    };
    const create = vi.fn(async () => fakeStream);
    const stream = vi.fn(() => {
      throw new Error('broken helper should not be used');
    });
    const anthropic = { messages: { create, stream } };

    const result = await createAnthropicMessageStream(anthropic, {
      model: 'claude-sonnet-4-5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toBe(fakeStream);
    expect(stream).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    });
  });
});
