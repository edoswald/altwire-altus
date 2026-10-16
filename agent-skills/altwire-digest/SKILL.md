---
name: altwire-digest
description: Write AltWire's daily analytics digest (a detailed email for the editor plus short Slack action items per channel) from Altus data. Use for the scheduled daily digest, or when asked for a digest, a daily or weekly briefing, or "how did we do yesterday".
---

# AltWire daily digest

The digest has two readers. The **email** is for the editor reading over coffee: detailed enough to understand what happened and why. The **Slack posts** are for the team channels: only the things someone should act on today.

## Gather (in this order)

1. `get_altwire_morning_digest`: the numbers snapshot. Yesterday vs. the same weekday last week (Matomo), page movers, Search Console totals and query/page movers, new opportunity-zone queries, Google News, articles from the last 14 days, story opportunities, and `seo_queue` (SEO items waiting in WordPress under SEO Workflow → Queued for Work). **This is the source of truth for every figure in the digest.**
2. The team memory, if mounted: `decisions.md` (standing preferences), `holiday-2026.md` (from October to December: guides in progress, last week's priority), and `digest-log.md` (what recent digests recommended; the bridge keeps it). Don't repeat an action item from the last few days unless it's still open and still matters; if one looks done, you can say so in a line.
3. Only when something needs explaining: `search_altwire_archive` or `get_content_by_url` to see what a page that moved is about, or `get_altwire_page_performance` for one page's search detail. Don't run broad extra analysis every day.

## Rules for numbers

- Report figures exactly as the tools return them. Never estimate, recompute, or round in a way that changes meaning; percentages to whole numbers are fine.
- Say which source a number comes from: **Matomo** for on-site visits and pageviews, **Search Console** for Google clicks, impressions, and position. They measure different things and won't match.
- Search Console data lags about 3 days; say "in Search Console (through <date>)".
- Use article titles, not URLs or slugs; link the title.
- If a cause is a guess, label it as one ("likely because…"). Don't invent explanations.
- If a section's data is missing or a tool failed, say so in one line and move on.

## Email structure

Subject: the single most important thing today, specific (for example: "Search clicks up 18% as the Deftones review climbs").

1. **The short version**: 3 bullets. What happened, the one thing that matters most, and the top action.
2. **Traffic (Matomo)**: a small table (metric, yesterday, same day last week, change) for visits, pageviews, and unique visitors, then 2–4 sentences on what drove the change.
3. **What moved**: the biggest page gainers and losers with titles and one line each on why, if known.
4. **Search and discovery (Search Console)**: queries and pages gaining or losing clicks or position, new opportunity-zone queries (positions 5–30) worth targeting, and Google News appearances.
5. **Recent articles**: how the last two weeks of articles are doing. Call out a breakout or a dud.
6. **Story opportunities**: the top 3–5, each with why now.
7. **SEO queue**: only when `seo_queue.new_since_yesterday` is above 0. One line per new item: the search, the article, the reason, who queued it (a person in WordPress or the agent), and their note. End with how many are waiting in total and that the agent works them in the Tuesday SEO batch, or sooner if someone asks in the team channel ("work the SEO queue"). Skip the section when nothing is new.
8. **Holiday season** (October 1 to December 31 only): one short paragraph on where the plan stands against the calendar, from the tracker.
9. **Action items**: a numbered list. Each item is concrete and doable today, and names its channel (team or holiday).

Length: roughly 800–1,100 words on a normal day; shorter on a quiet one. Scannable: short paragraphs, bold the key number in each section. No filler, no restating the obvious ("traffic changes day to day").

## Slack action items

- One short post per channel, only items from the email's action list that belong there. Write exactly `none` for a channel with nothing actionable; quiet days are fine.
- Routing: anything about holiday gift guides or seasonal content goes to **holiday**; everything else (SEO fixes, pages to update, stories to assign, search opportunities) goes to **team**.
- Each item: one line, starting with a verb, with the article linked and the reason in a few words. At most 5 items per channel.
- New SEO queue items get one team item at most, for example "Review 2 newly queued SEO fixes (MicroFreak review, …), or reply "work the SEO queue" to start now". Don't propose the rewrites in the digest; that's the SEO batch's job.
- Don't repeat yesterday's items unless they're still open and still matter.

## Don't

- Don't write to the team memory from the digest. It's a read of the day, not a decision.
- Don't pad a slow day. If nothing notable happened, say so in the short version and keep the email short.
