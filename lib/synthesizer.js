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

/**
 * Generate a plain-English coverage assessment for an artist or topic.
 * Returns a string. Never throws — returns 'Assessment unavailable.' on any error.
 *
 * @param {string} subject - artist, band, or topic
 * @param {string} contextLines - formatted archive data context
 * @returns {Promise<string>}
 */
export async function synthesizeCoverageAssessment(subject, contextLines) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return 'Assessment unavailable.';
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      temperature: 0,
      system: `You are an editorial assistant for AltWire, an alternative music publication.
You analyze the publication's content archive to assess coverage of artists and topics.
Write in plain, direct language. Be specific about what exists and what's missing.
Do not use bullet points. Write 2-4 sentences maximum.`,
      messages: [{
        role: 'user',
        content: `Summarize AltWire's coverage of "${subject}" based on this archive data:\n\n${contextLines}\n\nWrite a 2-4 sentence assessment of what coverage exists and what editorial opportunities remain.`,
      }],
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    return text.trim() || 'Assessment unavailable.';
  } catch (err) {
    logger.warn('Coverage assessment synthesis failed', { subject, error: err.message });
    return 'Assessment unavailable.';
  }
}
