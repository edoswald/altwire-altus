import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('synthesizer.js', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('synthesizeGallery returns fallback string when ANTHROPIC_API_KEY is missing', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { synthesizeGallery } = await import('../lib/synthesizer.js');
    const result = await synthesizeGallery({
      title: 'Test Gallery',
      description: '',
      image_count: 10,
      images: [],
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('Test Gallery');
    expect(result).toContain('10');
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  });

  it('synthesizeGallery uses description in fallback when provided', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { synthesizeGallery } = await import('../lib/synthesizer.js');
    const result = await synthesizeGallery({
      title: 'My Gallery',
      description: 'A great show',
      image_count: 5,
      images: [],
    });
    expect(result).toContain('A great show');
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  });

  it('synthesizeGallery calls Anthropic with haiku model and returns text', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'This is a synthesized gallery description.' }],
    });
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: class Anthropic {
        constructor() { this.messages = { create: mockCreate }; }
      },
    }));
    const { synthesizeGallery } = await import('../lib/synthesizer.js');
    const result = await synthesizeGallery({
      title: 'Live at Coachella',
      description: 'Highlight reel',
      image_count: 30,
      images: [{ alt: 'Band on stage', caption: 'Opening night' }],
    });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(10);
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    expect(call.max_tokens).toBe(150);
    delete process.env.ANTHROPIC_API_KEY;
  });
});
