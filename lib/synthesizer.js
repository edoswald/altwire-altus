/**
 * Claude Haiku gallery description synthesizer.
 * Used during ingestion to generate embeddings-friendly text for NGG galleries.
 * Falls back to a template string if Anthropic API is unavailable.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';

const MODEL = 'claude-haiku-4-5-20251001';

/**
 * Generate a 2-3 sentence description for a NextGEN gallery.
 * Returns a string. Never throws — returns fallback on any error.
 *
 * @param {{ title: string, description: string, image_count: number, images: Array<{alt:string,caption:string}> }} gallery
 * @returns {Promise<string>}
 */
export async function synthesizeGallery(gallery) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return fallback(gallery);
  }

  try {
    const client = new Anthropic();
    const imageLines = gallery.images
      .slice(0, 20)
      .map((img) => `- ${img.alt || '(untitled)'}: ${img.caption || '(no caption)'}`)
      .join('\n');

    const userPrompt = [
      `Gallery title: ${gallery.title}`,
      `Gallery description: ${gallery.description || 'none provided'}`,
      `Image count: ${gallery.image_count}`,
      imageLines ? `Image titles/captions (up to 20):\n${imageLines}` : '',
      '',
      'Write a 2-3 sentence description of what this gallery covers.',
    ]
      .filter(Boolean)
      .join('\n');

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 150,
      temperature: 0,
      system:
        'You are summarizing a photo gallery for a music publication called AltWire. Write 2-3 sentences describing this gallery based on the metadata provided. Be factual and specific. Do not invent details not present in the data.',
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    if (text.trim()) return text.trim();
    return fallback(gallery);
  } catch (err) {
    logger.warn('Gallery synthesis failed — using fallback', {
      title: gallery.title,
      error: err.message,
    });
    return fallback(gallery);
  }
}

function fallback(gallery) {
  const parts = [
    `${gallery.title} — photo gallery with ${gallery.image_count} images`,
  ];
  if (gallery.description && gallery.description.trim()) {
    parts.push(gallery.description.trim());
  }
  return parts.join('. ');
}
