import { Readable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { handleAltwireOpportunityAssignRoute } from '../handlers/altus-opportunity-routes.js';

function makeReq({ method = 'POST', body = {}, token = 'hal-token' } = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = method;
  req.headers = { authorization: `Bearer ${token}` };
  return req;
}

function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += chunk;
    },
  };
}

describe('AltWire opportunity assignment route', () => {
  it('promotes an opportunity through the writer-assignment handoff', async () => {
    const assignStoryOpportunity = vi.fn().mockResolvedValue({
      success: true,
      opportunity_id: 12,
      assignment: { id: 44, topic: 'radiohead tour news', status: 'outline_ready' },
    });
    const req = makeReq({ body: { article_type: 'feature' } });
    const res = makeRes();

    const handled = await handleAltwireOpportunityAssignRoute({
      url: new URL('https://altwire.example.com/altwire/opportunities/12/assign'),
      req,
      res,
      setCors: vi.fn(),
      isAllowedToken: vi.fn(() => true),
      assignStoryOpportunity,
      logger: { error: vi.fn() },
    });

    expect(handled).toBe(true);
    expect(assignStoryOpportunity).toHaveBeenCalledWith({
      id: 12,
      article_type: 'feature',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      opportunity_id: 12,
      assignment: { id: 44, topic: 'radiohead tour news', status: 'outline_ready' },
    });
  });
});
