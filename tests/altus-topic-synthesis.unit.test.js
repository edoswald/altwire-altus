import { describe, it, expect } from 'vitest';
import { buildTopicSynthesisPrompt } from '../handlers/altus-topic-synthesis.js';

describe('Altus topic synthesis parity', () => {
  it('keeps the AltWire editorial framing in the synthesis prompt', () => {
    const prompt = buildTopicSynthesisPrompt({
      topic: 'AI and indie music publishing',
      findings: ['point a', 'point b'],
    });

    expect(prompt).toContain('AltWire');
    expect(prompt).toContain('editorial');
  });
});
