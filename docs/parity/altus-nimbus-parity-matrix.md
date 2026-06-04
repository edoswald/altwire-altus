# Altus Nimbus Parity Matrix

| Capability | Nimbus Files | Altus Files | Status | Classification | Admin Risk If Missing | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Shared Hal memory tools | `index.js`, `hal-db.js`, `hal-memory-scope.js` | `index.js`, `handlers/hal-memory.js`, `handlers/altus-memory-scope.js` | present | baseline | high | Altus already exposes read, write, and list memory operations plus AltWire-specific scope routing. |
| Onboarding and perch agenda | `hal-onboarding.js`, `index.js` | `handlers/altus-onboarding.js`, `index.js` | present | baseline | high | Altus already has multi-admin onboarding, stored preferences, and a shared perch agenda. |
| Event log and audit narrative | `hal-event-log.js`, `index.js` | `altus-event-log.js`, `index.js` | partial | must-port | high | Altus has queryable events and synthesized audits, but not a dedicated session-trace surface or richer parity tests. |
| Heartbeat scheduler core | `hal-heartbeat.js`, `index.js` | `handlers/altus-heartbeat.js`, `index.js` | partial | must-port | high | Altus has scheduled-task storage and a heartbeat loop, but queue semantics and action-item management are still mixed into one file. |
| Reflection cron | `hal-reflection.js`, `index.js` | `handlers/altus-reflection.js`, `index.js` | partial | must-port | high | Altus has nightly reflection, but recent Nimbus batching and catch-up semantics need explicit parity review. |
| Scoping and registry guardrails | `hal-scoping.js`, `tests/tool-registry.property.test.js`, `tests/onboarding-tool-registration.*` | `index.js`, `handlers/altus-memory-scope.js` | partial | must-port | high | Altus relies on `scopedRegister()` and client restrictions, but lacks dedicated parity tests around registration and scope behavior. |
| Action item lifecycle | `hal-action-items.js`, `tests/hal-action-items.*` | `handlers/altus-action-items.js`, `handlers/altus-heartbeat.js`, `index.js` | present | must-port | high | Altus now has a dedicated action-item module plus explicit admin tools for listing, managing, and summarizing action items; heartbeat uses shared helpers instead of owning the whole lifecycle inline. |
| Scheduled task queue semantics | `hal-task-queue.js` | `handlers/altus-heartbeat.js` | partial | must-port | high | Altus can schedule, list, and cancel tasks in code, but those helpers are not yet exposed as a clean shared-Hal parity layer. |
| Session traces | `hal-session-traces.js`, `tests/hal-session-traces.*` | `handlers/altus-session-traces.js`, `altus-event-log.js`, `index.js` | present | must-port | high | Altus now exposes a dedicated session-trace query surface backed by `altus_events`, with either per-session event streams or summarized recent traces. |
| Web research | `hal-web-research.js`, `tests/hal-web-research.*` | `handlers/altus-web-research.js`, `handlers/altwire-search.js`, `index.js` | present | must-port | medium | Altus now has a generic shared-Hal research surface that reuses AltWire public search while keeping the implementation domain-safe. |
| Topic synthesis | `hal-topic-synthesis.js` | `handlers/altus-topic-synthesis.js`, `handlers/altus-topic-discovery.js`, `handlers/altus-combined-analytics.js`, `index.js` | present | adapt-for-altwire | medium | Altus now has an explicit editorial synthesis prompt/tool with AltWire framing instead of a verbatim Nimbus copy. |
| Skill library | `hal-skill-library.js`, `tests/hal-skill-library.*` | `handlers/altus-skill-library.js`, `index.js` | present | must-port | medium | Altus now has the first shared skill-library surface via schema init plus searchable admin skill discovery. Read/list/create parity is still future work if usage justifies it. |
| Commitments and watch items | `hal-commitments.js` | `handlers/altus-weekly-brief.js`, `handlers/altus-watch-list.js` | partial | adapt-for-altwire | medium | Altus already has watch-list concepts and commitment-like weekly outputs, but not a unified commitment surface. |
| Document generation surfaces | `hal-document.js`, `hal-documents.js` | none | absent | review | low | Could matter for admin workflows, but there is no clear AltWire need yet beyond existing editorial pipelines. |
| Chat history | `hal-chat-history.js` | SSE/session plumbing in `index.js` | partial | review | medium | Altus has session transport and SSE streams, but not shared persisted history behavior. |
| Chat presence | `hal-chat-presence.js` | SSE/session plumbing in `index.js`, `handlers/slack-altus.js` | partial | review | low | Presence could help, but current admin pain is lower than action-item, trace, and research gaps. |
| Autonomy policy | `hal-autonomy-policy.js` | client/tool restrictions in `index.js` | partial | review | medium | Altus has practical gating but not a named policy module or explicit admin-facing policy tooling. |
| Inbox split behavior | `workmail-client.js`, `index.js` | `handlers/slack-altus.js` only indirectly | absent | do-not-port | low | Nimbus inbox split logic is tightly tied to shared support inbox operations and is not an AltWire admin requirement. |
| Guided daily digest composition | `hal-digest-composer.js`, `digest-mailer.js` | `handlers/altus-digest.js`, `handlers/altus-weekly-brief.js` | partial | adapt-for-altwire | medium | The concept is relevant, but the specific digest shape is commerce/support oriented and should be editorialized if ported. |

## Recent Fix Review

- `c9e97c7` `fix: route remaining heartbeat skips`
  Decision: `shared -> must-port`
  Reason: This is real shared-Hal behavior. Nimbus broadened heartbeat action-item routing by classifying on description and signal source instead of title-only matching, and by attaching richer task parameters when queueing work. Altus has the same “heartbeat chooses whether and how to act” seam in `handlers/altus-heartbeat.js`, so skip-routing drift would create real admin regressions.

- `0ee78a9` `fix: align Hal inbox split audit coverage`
  Decision: `nimbus-specific -> do-not-port`
  Reason: This commit is about WorkMail/SES inbox semantics, reply-to defaults, and audit coverage for Cirrusly’s `help@`, `orders@`, and `hal@` split. Altus does not expose an equivalent shared inbox surface today, so this should be tracked as explicitly skipped rather than parity debt.

- `b9295b6` `feat batch nightly reflection processing`
  Decision: `shared -> must-port`
  Reason: The batching pattern is generic shared-Hal reflection infrastructure: separate snapshot collection from analysis execution, support submitted/pending/complete states, and add collection cron behavior. Altus already has a nightly reflection cron, so this is a serious parity candidate even if the specific Nimbus inputs differ.

- `c8c22be` `fix Hal SES inbox classification and ingest target`
  Decision: `nimbus-specific -> do-not-port`
  Reason: This is still inbox-ingest infrastructure, not shared AltWire admin brain behavior. There is no matching Altus ingestion target to keep in sync.

- `e4283cf` `feat add guided daily digest composition`
  Decision: `adapt-for-altwire`
  Reason: The underlying idea, using Hal to compose a narrative memo and prioritize sections, is generic enough to matter. The actual Nimbus implementation is tightly tied to Cirrusly’s workmail/store/operations digest, so Altus should only port this if it becomes an editorial digest or admin briefing surface.

## Initial Port Order

1. `hal-scoping` / tool-registry guardrails
2. `hal-action-items`
3. `hal-task-queue`
4. `hal-session-traces`
5. `hal-reflection` batching behavior
6. `hal-web-research`
7. `hal-skill-library`
8. `hal-topic-synthesis`
9. `hal-commitments`

## Current Recommendation

Proceed immediately on the `must-port` items above. Keep `hal-document`, `hal-documents`, `hal-chat-history`, `hal-chat-presence`, and `hal-autonomy-policy` in the review bucket until the first parity slice lands and AltWire admin usage clarifies whether they are worth the extra surface area.

## `hal-chat-ui` Rollout Readiness

| Surface | Current State | Risk | Status | Notes |
| --- | --- | --- | --- | --- |
| Shared login flow | Nimbus `POST /hal/auth` remains the single admin sign-in path | medium | compatible | Altus now accepts Hal web API keys and Nimbus session tokens for the mixed-mode pilot instead of requiring a separate UI auth story first. |
| Altus chat streaming | `useAltwireChat` now relies on authenticated `/mcp` SSE only | high | fixed | Removed the separate unauthenticated browser `EventSource(/events/:sessionId)` dependency because tool events already arrive over the authenticated response stream. |
| Altus prompt shell REST access | Prompt shell expects `/altwire/digest` and `/altwire/opportunities` | medium | compatible | Altus digest access now accepts compatible UI tokens, and `/altwire/opportunities` is exposed as a compatibility alias for the current prompt shell. |
| Mode naming | UI had mixed `altus` and `altwire` storage/selector semantics | medium | partial | Canonical persisted mode is now `altwire`, with legacy `altus` values normalized on load so existing local state does not strand admins. |
| Admin pilot usability | Shared shell, shared settings, and Altus writer surfaces already exist | medium | ready for pilot | Remaining work is polish and broader rollout confidence, not missing foundational UI surfaces. |

## Altus-Only Coverage Inventory

| Tool Family | Handler | Focused Tests Present | Gaps |
| --- | --- | --- | --- |
| Link evaluator | `handlers/altus-link-evaluator.js` | `tests/altus-link-evaluator.unit.test.js` | No end-to-end fetch parsing coverage yet; current test covers the private URL safety regression. |
| Reingest | `handlers/altus-reingest.js` | `tests/altus-reingest.unit.test.js` | Recent-mode gallery filtering is covered; dry-run and embed/upsert failure paths still deserve expansion later. |
| Content fetch | `handlers/altus-fetch.js` | `tests/altus-fetch.unit.test.js` | Ambiguous fuzzy fallback is covered; exact-match happy path and DB error shaping could use one additional unit test later. |
| Editorial memory tools | `handlers/altus-editorial-tools.js` | `tests/altus-editorial-tools.unit.test.js` | Total-count semantics are covered; create/update behavior is still relying on broader suite confidence. |
| Writer summary | `handlers/altus-writer-summary.js` | `tests/get-writer-summary.unit.test.js` | Degraded upstream reporting is covered; success-path aggregation could use one direct happy-path unit later. |
| Auth compatibility for pilot UI | `lib/altus-auth-compat.js` | `tests/altus-auth-compat.unit.test.js` | Current tests cover Hal web key/session compatibility; route-level HTTP assertions would be the next hardening step if pilot traffic surfaces issues. |
