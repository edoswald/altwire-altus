import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../handlers/altus-search.js', () => ({
  searchAltwireArchive: vi.fn(),
}));

vi.mock('../lib/editorial-helpers.js', () => ({
  loadEditorialContext: vi.fn(),
}));

vi.mock('../lib/safe-tool-handler.js', () => ({
  emitToolEvent: vi.fn(),
}));

vi.mock('../lib/altus-db.js', () => ({
  default: {
    query: vi.fn(),
  },
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { evaluateLinkFitness } from '../handlers/altus-link-evaluator.js';

describe('evaluateLinkFitness', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('blocks localhost and private-network targets before fetching', async () => {
    const result = await evaluateLinkFitness({ url: 'http://127.0.0.1:3000/private' });

    expect(result.fetch_error).toBe('private_url_blocked');
    expect(result.fit).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
