export async function handleAltwireOpportunityAssignRoute({
  url,
  req,
  res,
  setCors,
  isAllowedToken,
  assignStoryOpportunity,
  logger,
}) {
  const opportunityAssignMatch = url.pathname.match(/^\/altwire\/opportunities\/(\d+)\/assign$/);
  if (!opportunityAssignMatch || req.method !== 'POST') return false;

  setCors(req, res);
  const authToken = req.headers.authorization?.replace('Bearer ', '');
  if (!isAllowedToken(authToken, { allowHalKey: true, allowAltusAdminToken: true })) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return true;
  }

  try {
    const id = parseInt(opportunityAssignMatch[1], 10);
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = body ? JSON.parse(body) : {};
    const result = await assignStoryOpportunity({
      id,
      article_type: params.article_type ?? 'article',
    });
    if (result?.error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    logger.error('AltWire opportunity assign endpoint failed', { error: err.message });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'assign_failed', message: 'Opportunity could not be assigned' }));
  }

  return true;
}
