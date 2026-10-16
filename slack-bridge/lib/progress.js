/**
 * Live progress for a Slack reply: while the agent works, the "Working on
 * it…" placeholder is edited into a short checklist of the steps it has
 * taken (searching the archive, checking Search Console, reading notes…),
 * so people can see it's making progress. The answer replaces it at the end.
 */

const quote = (s, max = 40) => {
  const text = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;
};
const base = (p) => String(p ?? '').split('/').filter(Boolean).pop() ?? '';

// Altus tools (and built-in agent tools) → [in progress, done]. A function
// gets the tool input and returns the pair.
const LABELS = {
  search_altwire_archive: (i) => i?.query ? [`Searching the archive for ${quote(i.query)}`, `Searched the archive for ${quote(i.query)}`] : ['Browsing the archive', 'Browsed the archive'],
  search_altwire: (i) => [`Searching AltWire for ${quote(i?.query)}`, `Searched AltWire for ${quote(i?.query)}`],
  get_content_by_url: (i) => [`Reading ${base(i?.url) || 'an article'}`, `Read ${base(i?.url) || 'an article'}`],
  get_archive_stats: ['Counting the archive', 'Counted the archive'],
  analyze_coverage_gaps: (i) => [`Checking coverage of ${quote(i?.topic ?? i?.query)}`, `Checked coverage of ${quote(i?.topic ?? i?.query)}`],
  reingest_altwire_archive: ['Re-syncing the archive', 'Re-synced the archive'],
  get_altwire_site_analytics: ['Checking site traffic (Matomo)', 'Checked site traffic (Matomo)'],
  get_altwire_traffic_sources: ['Checking traffic sources', 'Checked traffic sources'],
  get_altwire_top_pages: ['Finding the top pages', 'Found the top pages'],
  get_altwire_site_search: ['Checking on-site searches', 'Checked on-site searches'],
  get_altwire_search_performance: ['Checking Google search performance', 'Checked Google search performance'],
  get_altwire_search_opportunities: ['Looking for low-CTR searches', 'Looked for low-CTR searches'],
  get_altwire_opportunity_zone_queries: ['Checking searches ranking 5–30', 'Checked searches ranking 5–30'],
  get_altwire_page_performance: (i) => [`Checking Google results for ${base(i?.page_url) || 'a page'}`, `Checked Google results for ${base(i?.page_url) || 'a page'}`],
  get_altwire_news_search_performance: ['Checking Google News', 'Checked Google News'],
  get_altwire_sitemap_health: ['Checking the sitemaps', 'Checked the sitemaps'],
  get_altwire_combined_analytics: ['Combining traffic and search data', 'Combined traffic and search data'],
  get_altwire_seasonal_comparison: ['Comparing with last season', 'Compared with last season'],
  get_article_performance: ['Checking how new articles did', 'Checked how new articles did'],
  get_altwire_seo_state: ['Reading SEO fields', 'Read SEO fields'],
  update_altwire_seo_fields: ['Updating SEO fields on the site', 'Updated SEO fields on the site'],
  find_altwire_seo_candidates: ['Finding articles to optimize', 'Found articles to optimize'],
  get_altwire_seo_queue: ['Checking the SEO queue', 'Checked the SEO queue'],
  update_altwire_seo_queue_item: ['Updating the SEO queue', 'Updated the SEO queue'],
  get_altwire_seo_results: ['Checking results of past SEO changes', 'Checked results of past SEO changes'],
  get_story_opportunities: ['Checking story opportunities', 'Checked story opportunities'],
  update_story_opportunity: ['Updating a story opportunity', 'Updated a story opportunity'],
  get_altwire_morning_digest: ['Pulling the analytics snapshot', 'Pulled the analytics snapshot'],
  find_gift_guide_candidates: ['Finding gift guide picks', 'Found gift guide picks'],
  // Built-in agent tools.
  web_search: (i) => [`Searching the web for ${quote(i?.query)}`, `Searched the web for ${quote(i?.query)}`],
  web_fetch: (i) => [`Reading ${hostOf(i?.url) || 'a web page'}`, `Read ${hostOf(i?.url) || 'a web page'}`],
  read: (i) => fileLabel(i, 'Reading', 'Read'),
  write: (i) => fileLabel(i, 'Writing', 'Wrote'),
  edit: (i) => fileLabel(i, 'Updating', 'Updated'),
  glob: ['Looking through files', 'Looked through files'],
  grep: ['Searching files', 'Searched files'],
  bash: ['Running a calculation', 'Ran a calculation'],
};

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function fileLabel(input, doing, done) {
  const path = String(input?.file_path ?? input?.path ?? '');
  const name = base(path);
  const memory = /memory|memstore|\/mnt\//i.test(path) ? 'notes' : 'file';
  return name ? [`${doing} ${memory} (${name})`, `${done} ${memory} (${name})`] : [`${doing} a ${memory}`, `${done} a ${memory}`];
}

/** [in progress, done] labels for a tool call. */
export function describeStep(name, input) {
  const entry = LABELS[name];
  const pair = typeof entry === 'function' ? entry(input) : entry;
  if (pair) return pair.map((s) => s.replace(/\s+$/, '').replace(/ for $/, ''));
  const words = String(name ?? 'tool').replace(/^(get_altwire_|get_|altwire_)/, '').replace(/_/g, ' ').trim();
  return [`Using ${words}`, `Used ${words}`];
}

/**
 * The placeholder text for a list of steps: done steps with ✓ (✗ when the
 * tool failed), the running one with ⏳; consecutive repeats collapse
 * ("Searched the archive ×3"); only the last `maxLines` are shown.
 */
export function renderProgress(steps, { maxLines = 8 } = {}) {
  const lines = [];
  for (const step of steps) {
    const mark = step.status === 'running' ? '⏳' : step.status === 'error' ? '✗' : '✓';
    const label = step.status === 'running' ? step.running : step.done;
    const last = lines.at(-1);
    if (last && last.mark === mark && last.label === label && mark !== '⏳') last.count += 1;
    else lines.push({ mark, label, count: 1 });
  }
  const shown = lines.slice(-maxLines);
  const hidden = lines.length - shown.length;
  return [
    '_Working on it…_',
    ...(hidden > 0 ? [`_…${hidden} earlier step${hidden === 1 ? '' : 's'}_`] : []),
    ...shown.map((l) => `${l.mark} ${l.label}${l.count > 1 ? ` ×${l.count}` : ''}`),
  ].join('\n');
}

/**
 * Track steps and edit the placeholder, at most once per `minIntervalMs`,
 * one edit at a time. Call stop() before replacing the placeholder with the
 * answer so a late edit can't overwrite it.
 *
 * @param {(text: string) => Promise<unknown>} update  edits the placeholder
 */
export function createProgress(update, { minIntervalMs = 1500, logger = console } = {}) {
  const steps = [];
  const byId = new Map();
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  let lastSent = '';
  let lastAt = 0;

  const flush = () => {
    timer = null;
    if (stopped) return;
    const text = renderProgress(steps);
    if (text === lastSent) return;
    lastSent = text;
    lastAt = Date.now();
    inFlight = inFlight
      .then(() => (stopped ? null : update(text)))
      .catch((err) => logger.warn?.('Progress update failed', { error: err.message }));
  };
  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(flush, Math.max(0, minIntervalMs - (Date.now() - lastAt)));
  };

  return {
    start(id, name, input) {
      const [running, done] = describeStep(name, input);
      const step = { running, done, status: 'running' };
      steps.push(step);
      if (id) byId.set(id, step);
      schedule();
    },
    end(id, isError = false) {
      const step = byId.get(id);
      if (!step) return;
      step.status = isError ? 'error' : 'done';
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await inFlight;
    },
    get steps() { return steps.length; },
  };
}
