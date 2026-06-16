/**
 * Create an Anthropic Messages stream using the raw create API.
 *
 * The @anthropic-ai/sdk 0.39.0 messages.stream() helper can fail at runtime
 * because it expects messages.create(...).withResponse(). The raw create API
 * returns an async iterable stream directly when stream: true is set.
 */
export async function createAnthropicMessageStream(anthropic, params) {
  return anthropic.messages.create({
    ...params,
    stream: true,
  });
}
