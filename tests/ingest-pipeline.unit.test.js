import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/altus-db.js', () => ({
  upsertContent: vi.fn(),
  getIndexedGalleryIds: vi.fn(async () => [99]),
}));

vi.mock('../lib/voyage.js', () => ({
  embedDocuments: vi.fn(),
}));

vi.mock('../lib/synthesizer.js', () => ({
  synthesizeGallery: vi.fn(),
  hasSynthesizableMaterial: vi.fn(),
  buildGallerySynthesisRequest: vi.fn((gallery) => ({
    model: 'claude-haiku-test',
    max_tokens: 150,
    messages: [{ role: 'user', content: `gallery-${gallery.id}` }],
  })),
}));

vi.mock('../batch-client.js', () => ({
  submitBatch: vi.fn(),
  waitForBatch: vi.fn(),
  logBatchUsage: vi.fn(),
  collectBatch: vi.fn(),
  isRefusal: vi.fn(),
  extractText: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { upsertContent, getIndexedGalleryIds } from '../lib/altus-db.js';
import { embedDocuments } from '../lib/voyage.js';
import { synthesizeGallery, hasSynthesizableMaterial } from '../lib/synthesizer.js';
import { submitBatch, waitForBatch, logBatchUsage } from '../batch-client.js';
import {
  embedAndUpsertPosts,
  embedAndUpsertGalleries,
  filterGalleriesForWindow,
  galleryTimestamp,
} from '../lib/ingest-pipeline.js';

const vec = (n) => Array.from({ length: n }, (_, i) => i / n);

describe('ingest-pipeline: embedAndUpsertPosts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('embeds post texts and upserts each with its embedding', async () => {
    embedDocuments.mockResolvedValue([vec(4), vec(4)]);
    upsertContent.mockResolvedValue(1);

    const result = await embedAndUpsertPosts([
      { wp_id: 1, content_type: 'post', title: 'A', categories: ['cat'], tags: ['tag'], raw_text: 'text a' },
      { wp_id: 2, content_type: 'post', title: 'B', categories: [], tags: [], raw_text: 'text b' },
    ]);

    expect(embedDocuments).toHaveBeenCalledWith([
      'A\n\ncat\ntag\n\ntext a',
      'B\n\n\n\n\ntext b',
    ]);
    expect(upsertContent).toHaveBeenCalledTimes(2);
    expect(upsertContent.mock.calls[0][0].embedding).toEqual(vec(4));
    expect(result).toEqual({ count: 2, errors: 0 });
  });

  it('counts per-row upsert failures without aborting the run', async () => {
    embedDocuments.mockResolvedValue([vec(4), vec(4)]);
    upsertContent.mockRejectedValueOnce(new Error('db exploded'));
    upsertContent.mockResolvedValueOnce(2);

    const result = await embedAndUpsertPosts([
      { wp_id: 1, content_type: 'post', title: 'A', categories: [], tags: [], raw_text: 'a' },
      { wp_id: 2, content_type: 'post', title: 'B', categories: [], tags: [], raw_text: 'b' },
    ]);

    expect(result).toEqual({ count: 1, errors: 1 });
  });

  it('returns the full error count when embedding fails', async () => {
    embedDocuments.mockResolvedValue({ error: 'rate limited' });

    const result = await embedAndUpsertPosts([
      { wp_id: 1, content_type: 'post', title: 'A', categories: [], tags: [], raw_text: 'a' },
      { wp_id: 2, content_type: 'post', title: 'B', categories: [], tags: [], raw_text: 'b' },
    ]);

    expect(upsertContent).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 0, errors: 2 });
  });
});

describe('ingest-pipeline: embedAndUpsertGalleries (direct mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('synthesizes all galleries then embeds and upserts', async () => {
    hasSynthesizableMaterial.mockReturnValue(true);
    synthesizeGallery.mockImplementation(async (g) => `Synth for ${g.title}`);
    embedDocuments.mockResolvedValue([vec(4), vec(4)]);
    upsertContent.mockResolvedValue(1);

    const result = await embedAndUpsertGalleries([
      { id: 1, title: 'Gallery One', tags: ['live'] },
      { id: 2, title: 'Gallery Two', tags: [] },
    ]);

    expect(synthesizeGallery).toHaveBeenCalledTimes(2);
    expect(embedDocuments).toHaveBeenCalledWith([
      'Gallery One\n\nPhoto gallery\nlive\n\nSynth for Gallery One',
      'Gallery Two\n\nPhoto gallery\n\n\nSynth for Gallery Two',
    ]);
    expect(upsertContent).toHaveBeenCalledTimes(2);
    expect(upsertContent.mock.calls[0][0]).toMatchObject({
      wp_id: 1,
      content_type: 'gallery',
      raw_text: 'Synth for Gallery One',
    });
    expect(result).toEqual({ count: 2, errors: 0, skipped: 0 });
  });

  it('reports galleries with no synthesizable material as skipped', async () => {
    hasSynthesizableMaterial.mockReturnValue(false);
    synthesizeGallery.mockImplementation(async (g) => `${g.title} — photo gallery with 0 images`);
    embedDocuments.mockResolvedValue([vec(4)]);
    upsertContent.mockResolvedValue(1);

    const result = await embedAndUpsertGalleries([{ id: 7, title: 'Empty', tags: [] }]);

    expect(result).toEqual({ count: 1, errors: 0, skipped: 1 });
    // Fallback text (no Claude call) still gets embedded and upserted
    expect(upsertContent.mock.calls[0][0].raw_text).toContain('Empty');
  });
});

describe('ingest-pipeline: embedAndUpsertGalleries (batch mode)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes synthesis through the Batch API for galleries with material', async () => {
    hasSynthesizableMaterial.mockReturnValue(true);
    embedDocuments.mockResolvedValue([vec(4)]);
    upsertContent.mockResolvedValue(1);
    submitBatch.mockResolvedValue('batch-123');
    waitForBatch.mockResolvedValue([
      {
        custom_id: 'gallery-1',
        result: {
          type: 'succeeded',
          message: { model: 'claude-haiku-4-5', usage: { input_tokens: 10 }, content: [{ type: 'text', text: 'Batched description.' }] },
        },
      },
    ]);

    const result = await embedAndUpsertGalleries(
      [{ id: 1, title: 'Gallery One', tags: ['live'] }],
      { useBatch: true },
    );

    expect(submitBatch).toHaveBeenCalledTimes(1);
    const submitted = submitBatch.mock.calls[0][0];
    expect(submitted[0].custom_id).toBe('gallery-1');
    expect(submitted[0].params.model).toBe('claude-haiku-test');
    expect(waitForBatch).toHaveBeenCalledWith('batch-123');
    expect(logBatchUsage).toHaveBeenCalledWith('batch-123', expect.any(Array), 'synthesize_gallery');
    expect(upsertContent.mock.calls[0][0].raw_text).toBe('Batched description.');
    expect(result).toEqual({ count: 1, errors: 0, skipped: 0 });
  });

  it('uses the free fallback (no batch request) for galleries without material', async () => {
    hasSynthesizableMaterial.mockImplementation((g) => g.id !== 5);
    synthesizeGallery.mockImplementation(async (g) => `${g.title} — photo gallery`);
    embedDocuments.mockResolvedValue([vec(4), vec(4)]);
    upsertContent.mockResolvedValue(1);
    submitBatch.mockResolvedValue('batch-empty');
    waitForBatch.mockResolvedValue([
      {
        custom_id: 'gallery-1',
        result: {
          type: 'succeeded',
          message: { model: 'claude-haiku-4-5', usage: {}, content: [{ type: 'text', text: 'Rich description.' }] },
        },
      },
    ]);

    const result = await embedAndUpsertGalleries(
      [
        { id: 5, title: 'Bare Gallery', tags: [] },
        { id: 1, title: 'Rich Gallery', tags: [] },
      ],
      { useBatch: true },
    );

    // Only the material gallery goes through the batch
    expect(submitBatch).toHaveBeenCalledTimes(1);
    expect(submitBatch.mock.calls[0][0]).toHaveLength(1);
    expect(submitBatch.mock.calls[0][0][0].custom_id).toBe('gallery-1');
    // The bare gallery still gets embedded via its fallback text
    expect(upsertContent).toHaveBeenCalledTimes(2);
    expect(upsertContent.mock.calls[0][0].raw_text).toContain('Bare Gallery');
    expect(result).toEqual({ count: 2, errors: 0, skipped: 1 });
  });

  it('counts chunk failures as errors instead of throwing', async () => {
    hasSynthesizableMaterial.mockReturnValue(true);
    embedDocuments.mockResolvedValue([]);
    submitBatch.mockRejectedValue(new Error('batch submit failed'));

    const result = await embedAndUpsertGalleries(
      [{ id: 1, title: 'Gallery One', tags: [] }],
      { useBatch: true },
    );

    expect(result.count).toBe(0);
    expect(result.errors).toBe(1);
    expect(upsertContent).not.toHaveBeenCalled();
  });
});

describe('ingest-pipeline: gallery window filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('galleryTimestamp parses supported timestamp fields', () => {
    expect(galleryTimestamp({ modified_at: '2026-01-02T00:00:00.000Z' })).toBeInstanceOf(Date);
    expect(galleryTimestamp({})).toBeNull();
    expect(galleryTimestamp({ modified_at: 'not-a-date' })).toBeNull();
  });

  it('keeps everything on a full run (no afterDate)', async () => {
    const galleries = [{ id: 1 }, { id: 99 }];
    expect(await filterGalleriesForWindow(galleries, null)).toHaveLength(2);
    expect(getIndexedGalleryIds).not.toHaveBeenCalled();
  });

  it('keeps timed galleries in-window and untimed galleries only when new', async () => {
    const now = new Date().toISOString();
    const galleries = [
      { id: 1, modified_at: now },          // in window
      { id: 2, modified_at: '2020-01-01T00:00:00.000Z' }, // too old
      { id: 3 },                             // untimed, new to archive
      { id: 99 },                            // untimed, already indexed
    ];

    const kept = await filterGalleriesForWindow(galleries, now);

    expect(kept.map((g) => g.id).sort()).toEqual([1, 3]);
  });
});