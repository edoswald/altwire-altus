# AltWire Altus AI Writer: Intended vs Implemented

Source concept: `/Users/edoswald/Downloads/AI Writer.pdf`

## Intended Flow From The PDF

- Selected topics are monitored for news on a recurring cron.
- Derek or another admin can assign the writer a topic.
- Hal hands the work to an AI Writer agent with an AltWire-specific system prompt.
- Research happens before topic/story selection is finalized.
- Research combines AltWire RAG context, web story context, and a topic backgrounder.
- The writer produces an initial summary outline before drafting.
- Derek approves the outline through Hal before story generation.
- The story generator writes only after outline approval.
- The fact checker validates the generated story.
- Incorrect research or factual issues rerun only the incorrect portions.
- Hal creates a WordPress draft post.
- A human admin edits and posts the final article.
- Content feedback adjusts future system prompts.

## Implemented Before This Pass

- `getStoryOpportunities()` pulled GSC opportunity-zone queries and synthesized pitch text.
- `getNewsOpportunities()` pulled Google News search type rows and matched the watch list.
- A weekday `story_opportunities` cron called `getStoryOpportunities()`.
- A daily `news_monitor` cron wrote `altus:news_alert:<date>` memory rows.
- The writer pipeline existed from assignment through research, outline, draft, fact check, and WordPress post.
- `hal-chat-ui` expected an `/altwire/opportunities` feed, but the backend did not expose that route.
- Story opportunities were cached in `agent_memory`, but they were not a durable actionable queue.
- No backend route promoted an opportunity into a writer assignment.

## Wired In This Pass

- Added `altus_story_opportunities`, a durable queue for discovered story opportunities.
- Added queue upsert logic so GSC opportunity results become stable pending items.
- Added queue listing logic that returns the shape expected by the AltWire opportunities UI.
- Added supervised assignment logic: a pending opportunity can be promoted into the existing writer pipeline.
- Added `GET /altwire/opportunities` to refresh signals and return queued opportunities.
- Added `POST /altwire/opportunities/:id/assign` to create a writer assignment from an opportunity.
- Updated the story-opportunities cron to persist discovered items into the queue.
- Updated the Google News monitor to persist watch-list matches into the same durable opportunity queue.
- Updated DB guards to honor `ALTWIRE_DATABASE_URL` as well as `DATABASE_URL`.
- Added event-log entries and proper awaiting for the news/story cron paths.
- Normalized digest watch-list matches into the shape the UI renders.
- Hardened fact-check correction so unresolved issues stay in `needs_revision` instead of advancing to `ready_to_post`.

## Still Missing

- The active AltWire sidebar UI still needs an Assign action wired to `POST /altwire/opportunities/:id/assign`.
- Topic backgrounder is not a distinct first-class pipeline step; current assignment research uses archive search plus web research.
- Outline correction and partial research rerun are not modeled as structured operations.
- Fact-check correction regenerates flagged sections and blocks unresolved issues, but there is no explicit correction queue visible to Derek.
- Content feedback does not yet adjust the writer system prompt in a durable, supervised way.
- WordPress draft creation exists, but the human edit/post feedback loop is not yet connected back to the prompt adjuster.

## Recommended Next Slice

Build the supervised assignment UX end to end:

1. Add an Assign button to the active AltWire opportunities UI.
2. Call `POST /altwire/opportunities/:id/assign`.
3. Refresh opportunities and writer assignments after success.
4. Show assigned opportunities as linked to their writer assignment instead of disappearing without explanation.
5. Add a backend test for assigning through the HTTP route once the server exports a testable handler or route module.
