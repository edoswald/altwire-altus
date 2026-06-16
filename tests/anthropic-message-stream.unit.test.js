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

  it('returns an async iterable that can carry a long text response', async () => {
    const chunks = Array.from({ length: 250 }, (_, index) => `chunk-${index} `);
    const fakeStream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
        for (const text of chunks) {
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
        }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
      },
    };
    const anthropic = {
      messages: {
        create: vi.fn(async () => fakeStream),
        stream: vi.fn(() => {
          throw new Error('broken helper should not be used');
        }),
      },
    };

    const responseStream = await createAnthropicMessageStream(anthropic, {
      model: 'claude-sonnet-4-5',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'write a long answer' }],
    });

    let streamed = '';
    for await (const event of responseStream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        streamed += event.delta.text;
      }
    }

    expect(streamed).toBe(chunks.join(''));
    expect(anthropic.messages.stream).not.toHaveBeenCalled();
  });
});
