# Altus Hal SEO Action Layer Implementation Plan

## Objective

Add a thin Altus integration over the existing `cirrusly-seo` SEO action API so Hal can inspect and update content-level SEO state for AltWire content.

## Scope

In scope:

- read current SEO state from WordPress
- update allowed content-level SEO fields
- use shared `X-Agent-Token` auth
- preserve clear error behavior
- add basic tests for success and failure paths

Out of scope:

- redirects
- site-level SEO settings changes
- sitemap or schema module toggles
- duplicating SEO state logic in Altus

## Task 1: Extend Altus WordPress Client

File:

- `lib/wp-client.js`

Changes:

- add a small generic helper for authenticated plugin requests
- add `getSeoState({ objectType, objectId, taxonomy })`
- add `updateSeoFields({ objectType, objectId, taxonomy, fields, reason })`
- send `X-Agent-Token` from environment or configured Altus token source
- preserve structured error details where possible

Expected result:

- Altus has reusable client methods for the plugin SEO action API

## Task 2: Register Altus SEO Tools

File:

- `index.js`

Changes:

- register `get_altwire_seo_state`
- register `update_altwire_seo_fields`
- validate inputs with the same editorial-first expectations used elsewhere in Altus
- return clean JSON payloads for Hal

Expected result:

- Hal can call explicit Altus tools for SEO inspection and SEO updates

## Task 3: Align Auth And Config

Files:

- `lib/wp-client.js`
- any env/config helpers already used by Altus

Changes:

- decide the exact Altus env var for the plugin agent token
- use shared token auth through `X-Agent-Token`
- keep existing WordPress application-password behavior intact for ingestion/posting flows
- do not replace or interfere with current Basic-auth posting helpers

Expected result:

- SEO action calls use scoped agent-token auth
- existing post-ingestion and draft-posting flows remain unchanged

## Task 4: Add Tests

Likely files:

- `tests/wp-client.test.js` or a new focused test file
- tool-level test file if Altus already has a pattern for MCP tool handler tests

Changes:

- test SEO state request success path
- test SEO update success path
- test auth or plugin-disabled failure path
- test validation or not-found error shaping

Expected result:

- the new client and tools have lightweight regression coverage

## Task 5: Document Operator Expectations

Files:

- relevant docs if Altus keeps tool documentation in repo

Changes:

- document new SEO tools briefly
- note that Altus handles discovery and recommendation while `cirrusly-seo` remains the source of truth for SEO state

Expected result:

- future operators understand the ownership split

## Verification

Runtime checks:

1. Call `get_altwire_seo_state` for a known AltWire post.
2. Confirm response includes:
   - stored fields
   - effective fields
   - schema summary
   - sitemap state
   - mode
   - score and recommendations
3. Call `update_altwire_seo_fields` with a small title or description change.
4. Confirm:
   - write succeeds
   - `changed_fields` is populated
   - follow-up state reflects the update
5. Confirm failed auth or disabled-write cases return readable errors.

Static checks:

- run relevant Node test file(s)
- run any syntax checks already used in Altus

## Implementation Notes

- keep the integration thin
- do not reimplement SEO scoring, schema logic, or field mapping in Altus
- preserve the plugin as the only SEO state authority
- keep this slice content-level only so the safety boundary stays simple
