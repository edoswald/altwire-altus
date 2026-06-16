# Altus QA Smoke Test

A manual test script for verifying Altus (Hal's "brain" for AltWire) functionality
through the Hal Chat UI test account in **altwire mode**.

For each item: send the prompt in the chat, watch the `tool_start` / `tool_done`
chips to confirm the expected tool fired, and check the response against the pass
criteria. Tick the box when it passes.

> **Preconditions**
> - Archive ingested (`get_archive_stats` returns a non-zero count) — needed for Phase 1.
> - Matomo + GSC credentials present (`ALTWIRE_MATOMO_*`, `ALTWIRE_GSC_*`) — Phases 2 & 7.
> - WordPress app password set (`ALTWIRE_WP_URL`, `ALTWIRE_WP_USER`, `ALTWIRE_WP_APP_PASSWORD`) — step 4.7.
> - Historical analytics seed has run at least once (Anthropic or deterministic fallback) — step 7.1.
> - At least two assignments and ≥3 logged feedback signals to exercise Phase 5.

---

## Phase 0 — Smoke test (is Altus alive & wired?)

- [ ] **0.1** "Hey Hal, what can you help me with for AltWire?"
  - Tool: _none (chat only)_
  - Pass: identifies as the AltWire/Altus assistant; **answer streams token-by-token**, no stuck "thinking".
- [ ] **0.2** "How many articles are in the AltWire archive right now?"
  - Tool: `get_archive_stats`
  - Pass: real count + last-ingested info, not an error.
- [ ] **0.3** "Give me AltWire's traffic for yesterday."
  - Tool: `get_altwire_site_analytics`
  - Pass: pageviews/visits returned (also proves `period`/`date` are now optional).

---

## Phase 1 — Content intelligence (RAG archive)

- [ ] **1.1** "Search our archive for anything we've written about [known artist/topic]."
  - Tool: `search_altwire_archive`
  - Pass: ranked, relevant past articles with URLs/titles; recency-weighted.
- [ ] **1.2** "Pull up the article at [a real altwire.net URL]."
  - Tool: `get_content_by_url`
  - Pass: returns that article's content/metadata.
- [ ] **1.3** "Where are our biggest coverage gaps right now?"
  - Tool: `analyze_coverage_gaps`
  - Pass: lists topics with reader demand but little/no coverage.
- [ ] **1.4** "Search the archive for 'asdfqwerzxcv-nonsense'."
  - Tool: `search_altwire_archive`
  - Pass: graceful "no results" — not a crash/stack trace.

---

## Phase 2 — Analytics & SEO

- [ ] **2.1** "What are our top pages this week?"
  - Tool: `get_altwire_top_pages` — Pass: ranked pages with pageviews.
- [ ] **2.2** "Where is our traffic coming from?"
  - Tool: `get_altwire_traffic_sources` — Pass: direct/search/social/referral breakdown.
- [ ] **2.3** "What are people searching for on the site?"
  - Tool: `get_altwire_site_search` — Pass: keyword list.
- [ ] **2.4** "How are we doing in Google Search — show search performance for the last 28 days, by query and page."
  - Tool: `get_altwire_search_performance` — Pass: accepts **multiple dimensions** (proves the array fix); returns clicks/impressions/CTR.
- [ ] **2.5** "What SEO opportunities should we chase?"
  - Tool: `get_altwire_search_opportunities` / `get_altwire_opportunity_zone_queries` — Pass: queries ranking ~5–20 with upside.
- [ ] **2.6** "Is our sitemap healthy?"
  - Tool: `get_altwire_sitemap_health` — Pass: status summary.

---

## Phase 3 — Editorial intelligence & opportunities

- [ ] **3.1** "What story opportunities do we have right now?"
  - Tool: `get_story_opportunities` — Pass: queue of candidate topics.
- [ ] **3.2** "Any breaking news opportunities from the monitor?"
  - Tool: `get_news_opportunities` — Pass: watch-list news matches (daily GSC-news monitor).
- [ ] **3.3** "Which past articles performed best, and what's the pattern?"
  - Tool: `get_article_performance` / `get_news_performance_patterns` — Pass: performance data + a pattern insight.

---

## Phase 4 — AI Writer end-to-end (run in sequence)

The headline scenario. Run as a conversation; note each tool firing.

- [ ] **4.1** "Assign me a new article: a feature on [topic]."
  - Tool: `create_article_assignment` — Pass: returns an assignment ID; status `researching`; kicks off RAG + web research.
- [ ] **4.2** "Generate the outline for that assignment."
  - Tool: `generate_article_outline` — Pass: structured outline (title, sections, angle, est. words); status → `outline_ready`.
- [ ] **4.3** "The outline looks good — approve it."
  - Tool: `approve_outline` — Pass: status → `outline_approved` (human-approval gate).
- [ ] **4.4** "Now write the draft." *(also try on a SECOND, un-approved assignment to test the gate)*
  - Tool: `generate_article_draft` — Pass: refuses on an un-approved assignment (`assignment_not_ready_for_draft`); writes the draft on the approved one → `draft_ready`.
- [ ] **4.5** "Fact-check the draft."
  - Tool: `fact_check_draft` — Pass: flags issues; reruns only flagged sections; status `ready_to_post` or `needs_revision`.
- [ ] **4.6** "Give me the draft as HTML."
  - Tool: `get_draft_as_html` — Pass: clean HTML for copy/paste.
- [ ] **4.7** "Post it to WordPress as a draft."
  - Tool: `post_to_wordpress` — Pass: creates a **draft** (never publishes) and returns the WP URL. _Requires WP creds; if absent it must fail clearly, not silently._
- [ ] **4.8** "Show me all my current assignments."
  - Tool: `list_article_assignments` — Pass: lists them with statuses.

---

## Phase 5 — Self-improving loop

- [ ] **5.1** "Log feedback on assignment [id]: drafts are too long and use too many clichés."
  - Tool: `log_editorial_decision` — Pass: records the feedback.
- [ ] **5.2** "Learn from recent editorial feedback and update the writer's directives."
  - Tool: `adjust_writer_system_prompt` — Pass: returns distilled directives (or `insufficient_feedback` if <3 signals — a valid pass).
- [ ] **5.3** "What writing directives is the writer currently using?"
  - Tool: `get_writer_directives` — Pass: returns the persisted directive list.
- [ ] **5.4** *(After 5.2 succeeds)* Generate a new outline/draft.
  - Tool: outline/draft tools — Pass: new output visibly respects the learned directives.

---

## Phase 6 — Reviews / loaners (if used by AltWire)

- [ ] **6.1** "Log a loaner: [product] from [company], due [date]."
  - Tool: `altus_log_loaner` — Pass: created.
- [ ] **6.2** "Any overdue loaners?"
  - Tool: `altus_get_overdue_loaners` — Pass: correct overdue list.
- [ ] **6.3** "Create a review assignment for [product]."
  - Tool: `altus_create_review` — Pass: created; appears in `altus_list_reviews`.

---

## Phase 7 — Regression checks for recent fixes

- [ ] **7.1 Matomo seeded analytics** — Open settings drawer → Analytics tab, or ask "What's our 18-month traffic summary?"
  - Pass: shows pageviews / peak month / trend — **not** "No historical data seeded yet" (once the seed has run).
- [ ] **7.2 Chat streams, no stuck "thinking"** — Ask any non-trivial question.
  - Pass: answer text streams progressively; reasoning (if any) is a separate collapsed block.
- [ ] **7.3 Autoscroll** — Send several messages / a long answer.
  - Pass: transcript stays pinned to bottom while streaming; scrolling up pauses it; returning to bottom resumes.
- [ ] **7.4 Alert bar placement** — Trigger/allow an alert.
  - Pass: appears as a top-of-screen bar, doesn't cover the chat; dismiss (X) works.
- [ ] **7.5 No Nimbus leakage** — In altwire mode, watch network/console.
  - Pass: no calls to `/hal/tasks` or `/hal/action-items` (Nimbus-only); no broken MCP tab in the AltWire settings drawer.

---

## Negative / robustness checks

- [ ] **N.1** "Issue a refund for order 12345."
  - Pass: politely declines / no such tool — Altus is editorial, not e-commerce.
- [ ] **N.2** "Approve the outline for assignment 999999."
  - Pass: clean `assignment_not_found`, not a crash.
- [ ] **N.3** "Post assignment [id] to WordPress" before it's `ready_to_post`.
  - Pass: refuses with a clear status error.

---

_Last updated: 2026-06-16_
