# Hal + Altus — Derek's Day-to-Day Guide

A short tour of what Hal can do for you on the AltWire side. The focus
here is what to ask for and where to look — not the engineering
underneath.

> Lead with the question. Hal is good at editorial judgement when you
> point him at a specific decision ("should I run this?", "what's
> moving?", "what's missing?") rather than asking for a generic dump.

---

## 1. Your morning ritual (~2 min)

Open the **Altus** tab. The prompt page shows a welcome card with the
current digest summary. Ask Hal:

> "Run the morning digest."

You'll get back, in one block:

- **Uptime** — altwire.net + WordPress cron heartbeat
- **Open incidents** — Better Stack
- **News alerts** — Google News matches against your watch list
- **Story opportunities** — search-demand-vs-coverage gaps
- **Review deadlines** — anything due in the next 7 days
- **Overdue loaners** — gear that should have come back
- **Yesterday's traffic** vs. the 18-month monthly average
- **AI cost** — yesterday + 7d + 30d
- **Combined synthesis headline** — the one-sentence "what mattered last
  28 days" line, plus an editorial recommendation (this is new — it
  fuses Matomo + Google Search Console).

If anything's red, ask Hal to dig in: _"Tell me more about the open
incident,"_ or _"Show me the top 3 story opportunities."_

---

## 2. Editorial pipeline (AI Writer)

Hal can move an article from idea → outline → draft → posted. Tell him
what you want and he'll pick the right tool.

Common asks:

- **Assign yourself an article**
  > "Create an assignment: review of the new Wednesday album."
- **Get an outline**
  > "Draft an outline for assignment 47."
- **Approve / revise an outline**
  > "Approve outline 47 with this change: lead with the live-show angle."
- **Generate a draft from an approved outline**
  > "Generate the draft for 47."
- **Fact-check before posting**
  > "Fact-check draft 47."
- **Post to WordPress**
  > "Post 47 to WordPress as draft" (or `as published` if you trust it).
- **Status check**
  > "What assignments are pending action from me?"

The **Settings drawer → Profile** tab holds your editorial voice profile
(tone, sentence patterns, what to preserve in AI drafts). Edit that
profile any time the AI is producing copy that doesn't sound like you —
the writer pipeline reads it on every draft.

---

## 3. Analytics — what's actually working

Two providers, one synthesis:

- **Matomo** = on-site behavior (pageviews, top articles, internal
  search, referrer mix).
- **GSC** = organic search visibility (queries, impressions, CTR,
  position).
- **Combined synthesis** (new) cross-references the two — _"which
  articles win on both sides? where is search demand high but
  coverage thin?"_

Things to ask:

- **Big picture (28d)**
  > "Run combined analytics for the last 28 days." → returns dual
  > winners, underperformers, content gaps, and one-sentence
  > recommendation.
- **Long-term context (16–18 months)**
  > "What's our peak month?" or "Are we trending up or down?" — Hal
  > pulls from the historical memory keys, no fresh API call needed.
- **Search-demand gaps**
  > "Show me the top opportunity-zone queries we don't have coverage
  > for." → uses GSC opportunity-zone × on-site search × archive.
- **Per-article post-publish check**
  > "How is `<URL>` performing in search at 7 days?" → uses
  > `get_altwire_page_performance` with the GSC 2-day lag baked in.
- **Site search / reader intent**
  > "What are readers searching for on AltWire this week?"

The **Settings drawer → Analytics** tab summarizes Matomo + GSC + the
last combined synthesis at a glance.

---

## 4. Story discovery

For ideas, not metrics:

- **Story opportunities** — GSC opportunity-zone queries where the
  archive is thin. Hal returns ranked pitches with rationale.
  > "What are today's top story opportunities?"
- **News opportunities** — GSC News data crossed against your watch
  list, so artists/topics you actively track surface first.
  > "Anything new in News for my watch list?"
- **Coverage gaps**
  > "Where are we under-covered relative to traffic demand?"
- **Manage the watch list**
  > "Add Mannequin Pussy to my watch list."
  > "Remove `<artist>` from the watch list."

---

## 5. Reviews & loaners (gear)

Lightweight tracker for review assignments and loaner units.

- > "Create a review for the Audio-Technica AT-LP120 due July 15."
- > "List my open reviews."
- > "Show me overdue loaners."
- > "Log a loaner: Yamaha HS5 from Sweetwater, expected back Sept 1."
- > "Add a note to review 12: the bass response is uneven below 60Hz."

---

## 6. Slack + status

Hal can post on your behalf when something noteworthy happens — or
when you tell him to.

- > "Post a status update: review of X is live."
- > "Send a Slack DM to Ed: heads up, the WP cron is flapping."
- > "Schedule a Slack message for tomorrow at 9am: …"
- > "What status posts have I made this week?"

Routing is automatic by post type — alerts go to
`#admin-announcements`, dave digests to `#bug-reports`, and so on. You
can override with a specific channel if needed.

---

## 7. Settings drawer cheat-sheet

The gear icon in the Altus tab opens five tabs:

| Tab | What's there |
|---|---|
| **Profile** | Edit your writing voice profile — tone, sentence patterns, first-person usage, humor, what to preserve in AI drafts. Saves to `hal:altwire:editorial_voice_profile`. |
| **Context** | Toggle which editorial context signals (competitor analysis, news alerts, product updates, seasonal) Hal weights when planning. |
| **Digest** | Compact-timestamps and warning-badge preferences for the morning digest. |
| **Analytics** | Live Matomo, GSC, and Combined Synthesis snapshots — 18-month pageviews, peak month, trend direction, 16-month clicks/impressions/position, search-traffic share, and the latest editorial recommendation. |
| **MCP** | Add/remove MCP servers powering custom tool capabilities. |

If a panel says "Matomo not configured" or "GSC not configured," that's
real — flag it to Ed; the env vars on the server need attention.

---

## 8. Asking Hal effectively

A few patterns that work well:

1. **State the decision, not the data.** _"Should I commission a piece
   on shoegaze revival?"_ beats _"Show me shoegaze metrics."_
2. **Time-box.** _"…last 28 days"_ or _"…vs last quarter"_ keeps the
   answer focused.
3. **Ask for the headline first, details on demand.** Hal already knows
   you prefer concise summaries; if you want to go deeper just say
   _"more detail"_ or _"break that out by category."_
4. **Chain.** _"Top 3 story opportunities → for the first one, draft an
   outline."_ Hal will use the right tools in sequence.
5. **Memory matters.** Ask _"What do you remember about my voice?"_ or
   _"What's in my soul?"_ — Hal will read from `hal:soul:altwire` and
   the editorial context. If something's wrong, ask him to update it.

---

## 9. When something looks off

| Symptom | Try |
|---|---|
| Digest says "no data available for today" | The cron may not have fired yet — it runs at 5am ET. Ask: _"When did the last reflection run?"_ |
| Numbers look stale | Ask Hal to refresh: _"Pull fresh combined analytics for the last 7 days."_ |
| AI Writer draft sounds wrong | Open Profile tab and tighten the voice fields, then regenerate. |
| Tool returns a config error | Tell Ed — most config issues are env-var or service-account problems on the server side. |

---

That's the whole surface. You don't need to memorize the tool names —
just describe the editorial decision you're trying to make and Hal
will pick the right ones.
