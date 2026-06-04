# Altus Hal SEO Action Layer Design

## Goal

Enable Hal on AltWire, via `altwire-altus`, to inspect and update content-level SEO state through the existing `cirrusly-seo` WordPress plugin action layer.

The design should:

- reuse the existing `cirrusly-seo` REST API instead of duplicating SEO mutation logic in Altus
- fit AltWire's editorial workflow rather than WooCommerce-first assumptions
- preserve the shared `X-Agent-Token` auth and scoping model already used elsewhere
- keep the first implementation limited to content-level SEO writes

## Architecture

### Source of truth

`cirrusly-seo` remains the source of truth for:

- stored SEO fields
- rendered effective title, description, canonical, and robots state
- schema summary
- sitemap inclusion state
- SEO scoring and recommendations

`altwire-altus` should not store or compute a second copy of SEO state.

### Role split

- `altwire-altus` owns discovery, analytics, and editorial decision-making
- `cirrusly-seo` owns WordPress SEO state and content-level mutations
- Hal uses Altus tools to inspect current state and apply allowed changes

## Altus Tool Surface

Add two explicit tools in `altwire-altus`.

### `get_altwire_seo_state`

Purpose:

- inspect current WordPress SEO state for an article, page, podcast episode, or supported taxonomy object before changes

Input:

- `object_type`
- `object_id`
- optional `taxonomy`

Behavior:

- calls `GET /wp-json/cirrusly/v1/seo/state`
- returns stored fields, effective fields, schema summary, sitemap state, mode, score, checks, and recommendations

### `update_altwire_seo_fields`

Purpose:

- apply content-level SEO updates from Hal after an editorial or search-driven recommendation

Input:

- target object identity
- allowlisted SEO field patch
- optional `reason`, required when the plugin setting enforces it

Behavior:

- calls `POST /wp-json/cirrusly/v1/seo/update-fields`
- returns changed fields plus updated effective state

## Allowed Field Patch

The first implementation should only expose content-level fields already supported by the plugin:

- `seo_title`
- `meta_description`
- `canonical`
- `focus_keyword`
- `noindex`
- `nofollow`
- `social_title`
- `social_description`
- `social_image_id`

No site-level SEO mutations should be exposed from Altus in this slice.

## Auth And Scoping

Altus should use the same auth model already supported by the plugin:

- header: `X-Agent-Token`
- read operations use the shared read token
- write operations use the shared write token

The plugin remains responsible for:

- validating token scope
- honoring plugin-local Hal Integration toggles
- enforcing "reason required" policy for writes

Altus should not introduce a second SEO-specific auth scheme.

## Error Behavior

Altus should preserve clear error categories when calling the plugin:

- auth failure
- write disabled by plugin settings
- validation failure
- object not found
- WordPress/network failure

Tool output should make these failures readable to Hal and operators, rather than flattening everything into a generic failure string.

## Editorial Workflow

The intended usage pattern is:

1. Hal identifies a search or CTR opportunity through Altus analytics or GSC tools.
2. Hal calls `get_altwire_seo_state` for the relevant object.
3. Hal inspects current title, description, canonical, social fields, score, and recommendations.
4. Hal applies a content-level patch via `update_altwire_seo_fields`.
5. Hal receives the updated effective state and changed field list.

This keeps discovery in Altus and state mutation in the plugin.

## Out Of Scope For This Slice

- redirects
- sitemap toggles
- schema module toggles
- global SEO settings changes
- direct Search Console transport through the plugin
- automatic self-applying recommendation loops without explicit tool use

Those can be added later behind stronger gating if needed.

## Files Expected To Change

Primary Altus files:

- `lib/wp-client.js`
- `index.js`
- test files for the WP client or tool handlers

No new SEO mutation logic should be added outside those Altus integration points.

## Acceptance Criteria

- Altus exposes a read tool for current SEO state
- Altus exposes a write tool for allowed content-level SEO fields
- both tools use the shared `X-Agent-Token` model
- Altus can round-trip a title or description update against the plugin
- failures return clear operationally useful errors
- editorial workflows can move from GSC/search opportunity detection to SEO action without leaving Altus
