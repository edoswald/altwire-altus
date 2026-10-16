---
name: altwire-seo-refresh
description: Improve the Google titles and meta descriptions of existing AltWire articles, a few at a time, with approval, and learn from the results. Use when asked to optimize SEO, fix titles or meta descriptions, work the SEO queue, improve click-through, or "what should we fix in search", and for the scheduled SEO batch.
---

# AltWire SEO refresh

Many AltWire articles have no meta description or a title nobody would click. This is steady, ongoing work: each session, pick the few changes that will gain the most clicks, get them approved, apply them, and check later what they did. Quality and judgment matter more than volume.

## 1. See what's already happened

- `get_altwire_seo_results`: changes made so far and their outcomes. Read the `summary` and any `improved` or `declined` changes before proposing more; repeat what works and stop doing what doesn't.
- Team memory `seo-playbook.md`, if mounted: patterns learned on earlier runs (step 6).

## 2. Pick the work (in this order)

1. `get_altwire_seo_queue`: queued items. People queue them in WordPress, and you queue them too (step 5). These come first; work the oldest first, and read each item's `notes`.
2. `find_altwire_seo_candidates`: the articles with the most clicks to gain. Work from the top.
3. Skip, and say why in one line:
   - Articles published in the last 7 days (titles of fresh news are still settling in Google and Google News).
   - Pages where the only issue is `no_focus_keyword`.
   - Anything changed in the last 45 days (the tool already leaves these out).

Take about 5 per batch unless asked for more.

## 3. Understand each article before writing

- `get_altwire_seo_state`: the stored fields, and `rendered`, which is what Google sees now.
- `top_queries` from the candidate (or `get_altwire_page_performance` for one URL): the searches it actually shows up for. **Write for those searches.** Don't drop a query that already brings clicks.
- `get_content_by_url` when you need to know what the article says. A title or description must never promise something the article doesn't deliver.

## 4. Write

**Title** (`seo_title`): the title part only; the site adds " - AltWire".
- 30–55 characters, so the full title stays under about 60.
- Lead with the words people search: the artist, band or product name, then what the piece is (review, interview, live photos, news).
  - Reviews: the full product name and "Review" (for example, "Arturia MicroFreak Review: A Weird, Brilliant Synth").
  - Interviews: the person's name first, then the subject people want to hear about.
- Plain and accurate in AltWire's voice: no clickbait, no ALL CAPS, no "You won't believe".
- If the current title already ranks well (position 1–3 with a normal CTR), leave it.

**Meta description** (`meta_description`): 120–155 characters.
- Say what the reader gets: the verdict, the news, what the interview covers.
- Use the main search phrase once, naturally.
- Write a full sentence, not a keyword list. No quotation marks around the whole thing.

**Focus keyword** (`focus_keyword`): the main search phrase from `top_queries`, when it's clear.

**Never** change `noindex` or `canonical` unless someone explicitly asks.

**Judgment calls:**
- Some searches are about a person's private life (gender, age, health, relationships). Don't rewrite titles to chase those. Note the query and keep the title about the work.
- If a query shows the article doesn't really cover what people want, don't paper over it with a title. Say "needs a content update" and suggest it as a story idea instead.

## 5. Propose, get approval, apply

Post one message with the batch, numbered:

> **1. Arturia MicroFreak Review** (1,955 impressions, 0.3% CTR at #11 in 28 days; ~19 clicks to gain)
> Searches: arturia microfreak, microfreak review, microfreak
> Title: "Arturia MicroFreak Review" → "Arturia MicroFreak Review: A Weird, Brilliant Synth"
> Description: (none) → "Our hands-on Arturia MicroFreak review: …"
> Why: no description and a low CTR for its position; leads with the product name people search.

Then ask which to apply ("all", "1, 3, 5", or edits).

**Only apply what was approved in this conversation.** For each approved item:
1. Call `update_altwire_seo_fields` with a one-line `reason` that gives the evidence (for example, "CTR 0.3% at #11; added description, title leads with model name").
2. If it came from the queue, call `update_altwire_seo_queue_item` with status `done` and a note on what changed. If it was rejected, mark it `dismissed` with the reason.

Confirm at the end what was applied, with links.

**Queue what isn't done now** with `queue_altwire_seo_item`. It shows up in WordPress under SEO Workflow → Queued for Work, marked as queued by the agent:
- Proposals someone wants to keep for later ("not now", "queue the rest"). Queue each one with a note saying what you proposed.
- A clear opportunity you notice in another conversation (a slipping article, a search with lots of impressions and few clicks) when there's no batch in progress. Don't queue things you're about to propose anyway.
- Pass the article `url` exactly as `find_altwire_seo_candidates` returns it, the search, the reason, and a one-line note ("Title should lead with 'MicroFreak review'; CTR 0.3% at #11").
- Don't queue rejected proposals. Leave them out, and if one came from the queue, mark it `dismissed`.

## 6. Learn

When `get_altwire_seo_results` shows a pattern across several measured changes (not one), add a dated line to `seo-playbook.md` in team memory. For example: "2026-11: review titles with 'Review:' + verdict raised CTR on 5 of 7 gear reviews." Keep it to patterns that change what you'll propose next.

- Seasonality, news and Google updates move numbers too. One result is a hint, not proof.
- When reporting results, say "clicks went from X to Y in the 28 days after", not "this change caused".

## Reporting a backlog

When asked how much is left: `find_altwire_seo_candidates` returns `backlog`, counts of reviewed pages with each problem (pages with Google traffic, most-viewed first). Present it as rough scope, not an exact total of AltWire's archive.
