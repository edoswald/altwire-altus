# Altus / Nimbus Hal Parity Design

## Goal

Bring `altwire-altus` to feature and bugfix parity with the non-WooCommerce, non-Cirrusly-Weather portions of `cirrusly-nimbus` so Altus can serve as Hal's primary brain for AltWire without regressions for AltWire admins.

This pass is not a generic cross-repo cleanup. It is specifically about shared Hal behavior, missing generic tools, and bugfix parity in the admin-facing and autonomy-facing layers.

## Scope

We will treat Nimbus as the reference implementation for shared Hal capabilities and evaluate Altus against it.

Included:

- Shared Hal memory and scoping behavior
- Onboarding and admin-context state
- Heartbeat, scheduled tasks, action-item, and autonomous task behavior
- Event log, audit, trace, and visibility tooling
- Generic research, synthesis, skill, document, and session-state tools
- Generic Slack/Hal admin interaction capabilities
- Generic bugfixes in shared Hal logic

Excluded by default:

- WooCommerce-specific tools and workflows
- Cirrusly Weather-specific tools and workflows
- Merchant, supplier, outbound-call, weather, and CW business-domain logic
- AltWire-only editorial tools that do not exist in Nimbus and are not intended to be shared

Review-required gray area:

- New Nimbus tools that are not explicitly WooCommerce/CW-specific but may still be tightly coupled to Nimbus operating assumptions
- Generic-seeming support modules whose current implementation is entangled with Nimbus-only data or business processes

## Repo Evidence

### Altus current shape

Altus already includes several adapted shared Hal capabilities:

- `handlers/altus-heartbeat.js`
- `handlers/altus-onboarding.js`
- `handlers/altus-memory-scope.js`
- `handlers/altus-mountaineering.js`
- `handlers/hal-memory.js`
- `altus-event-log.js`
- `handlers/slack-altus.js`

Altus registers tools directly through `scopedRegister()` in [index.js](/Users/edoswald/Dev/altwire-altus/index.js), using context restrictions rather than a more formal shared registry model.

Altus also adds substantial AltWire editorial-specific capabilities such as archive search, writer workflows, content ideas, coverage analysis, watch lists, link evaluation, and editorial analytics memory.

### Nimbus current shape

Nimbus has a broader shared Hal surface, including generic modules that Altus does not yet clearly expose:

- `hal-tools.js`
- `hal-task-queue.js`
- `hal-action-items.js`
- `hal-session-traces.js`
- `hal-chat-history.js`
- `hal-chat-presence.js`
- `hal-web-research.js`
- `hal-skill-library.js`
- `hal-document.js`
- `hal-documents.js`
- `hal-topic-synthesis.js`
- `hal-commitments.js`
- `hal-autonomy-policy.js`
- `hal-scoping.js`
- `hal-heartbeat.js`
- `hal-reflection.js`

Nimbus also has explicit registry-oriented logic in [index.js](/Users/edoswald/Dev/cirrusly-nimbus/index.js) and dedicated tests around tool registration parity such as:

- `tests/tool-registry.property.test.js`
- `tests/onboarding-tool-registration.unit.test.js`
- `tests/onboarding-tool-registration.property.test.js`

### Recent Nimbus signal

Recent Nimbus commits indicate active shared-Hal bugfix and behavior work:

- `0ee78a9 fix: align Hal inbox split audit coverage`
- `c9e97c7 fix: route remaining heartbeat skips`
- `c8c22be fix Hal SES inbox classification and ingest target`
- `b9295b6 feat batch nightly reflection processing`
- `e4283cf feat add guided daily digest composition`

These should be reviewed for whether the underlying fix is generic Hal behavior, even if the user-facing workflow is not directly AltWire-specific.

## Problem Statement

Altus currently contains some shared-Hal adaptations but not a clearly maintained parity contract with Nimbus. As Nimbus evolves, shared Hal capabilities can improve or receive bugfixes without those changes reaching Altus. That creates three failure modes:

1. AltWire admins lose capabilities that Hal has elsewhere.
2. Shared Hal behaviors diverge, causing confusing cross-environment differences.
3. Altus accumulates one-off editorial adaptations without a stable shared core, making future parity increasingly expensive.

The fix is not to copy all Nimbus code blindly. The fix is to define a shared Hal parity boundary and make Altus conform to it while keeping AltWire editorial specialization on top.

## Design Principles

### Shared core first

If a capability is part of Hal's generic brain, state model, autonomy model, or admin-support layer, Altus should either:

- implement the same capability directly, or
- provide an AltWire-adapted implementation with equivalent behavior and user affordances.

### Domain adapters second

WooCommerce/CW logic stays out of Altus. AltWire editorial workflows stay in Altus. Shared Hal layers should sit beneath those domain adapters instead of being rewritten independently.

### Behavior parity over line parity

We are not aiming for identical files. We are aiming for equivalent behaviors:

- same tool availability where applicable
- same constraints and safety behavior
- same state semantics
- same background-task semantics
- same admin-facing outcomes

### Bugfix parity is part of feature parity

Recent Nimbus fixes count as parity work if they affect shared Hal infrastructure, even when they arrived under a Nimbus-specific feature branch.

## Parity Classification Model

Every Nimbus capability discovered in this pass will be classified into one of three buckets.

### `must-port`

Generic Hal capability or bugfix missing in Altus and needed to avoid regression.

Examples likely to land here:

- shared task/action-item infrastructure gaps
- trace/audit/session visibility gaps
- generic research or skill-library functionality
- heartbeat or reflection bugfixes with shared semantics

### `adapt-for-altwire`

Generic Hal capability that should exist in Altus, but not necessarily in the exact Nimbus shape because it needs editorial naming, AltWire data sources, or AltWire-specific persistence keys.

Examples likely to land here:

- reflection/digest support tools
- commitments/watch-item tooling
- session/context helpers
- document-generation helpers where Altus needs editorial output forms

### `do-not-port`

Capability that is genuinely Nimbus-domain-specific, even if it is technically generic code.

Examples likely to land here:

- merchant and pricing workflows
- supplier invoice workflows
- weather/location logic
- outbound call and customer-support infrastructure

## Recommended Approach

Use a shared-core alignment pass rather than a simple backport pass.

That means:

1. Build a parity matrix from Nimbus to Altus.
2. Identify shared Hal layers that Altus should expose or mirror.
3. Port or adapt those layers in a way that preserves Altus editorial specialization.
4. Add parity tests or parity-check scaffolding so future drift is easier to detect.

This is larger than a one-off feature port, but smaller and safer than extracting a shared package right now.

## Workstreams

### 1. Tool Surface Audit

Compare registered/admin-exposed capabilities in both repos.

Artifacts:

- Nimbus tool/module inventory
- Altus tool/module inventory
- Missing-tool gap list

Primary focus areas:

- memory and scoping tools
- task/action queue tools
- chat/session/state tools
- research/document/skill tools
- audit/event/trace tools
- heartbeat/reflection companion tools

### 2. Shared Behavior Audit

Review recent Nimbus fixes and behavior changes for shared Hal semantics.

Artifacts:

- recent-fix review table
- generic bugfix candidates for Altus

Primary focus areas:

- heartbeat skip routing
- reflection batching
- audit coverage
- inbox or classification bugfixes only if underlying infra is shared

### 3. AltWire Adaptation Audit

Determine where Altus should intentionally diverge in wording, persistence keys, content models, or workflows while still retaining shared Hal behavior.

Artifacts:

- adaptation notes per must-port tool
- explicit non-goals for Altus

### 4. Parity Test Strategy

Add or adapt tests so parity drift becomes visible.

Preferred coverage:

- tool registration parity assertions for approved shared tools
- memory-scope behavior tests
- heartbeat/action-item lifecycle tests
- event/audit/trace behavior tests
- shared Hal safety/scope gating tests

## Likely Candidate Areas To Review First

These are the highest-signal likely gaps based on the current repo scan.

### High priority

- `hal-action-items.js` vs Altus heartbeat/task follow-through
- `hal-task-queue.js` vs Altus scheduled task behavior
- `hal-session-traces.js` vs Altus event-log-only visibility
- `hal-commitments.js` vs Altus admin commitments/watch tracking
- `hal-skill-library.js` vs Altus lack of shared skill memory/tooling
- `hal-web-research.js` and `hal-topic-synthesis.js` vs Altus research surface
- Nimbus tool registration/property tests vs Altus’s much lighter registration safety net

### Medium priority

- `hal-chat-history.js`
- `hal-chat-presence.js`
- `hal-document.js` / `hal-documents.js`
- `hal-autonomy-policy.js`
- `hal-scoping.js`

### Review-only / possible skip

- inbox/email support layers
- business-goals/session-economics layers
- security and ops modules unless they clearly inform shared Hal admin behavior

## Implementation Shape

The implementation should proceed in phases.

### Phase 1: Parity matrix

Build a concrete table:

- Nimbus capability
- File(s)
- Purpose
- Altus equivalent
- Status: present / partial / absent
- Classification: must-port / adapt / skip
- Risk if omitted

### Phase 2: Shared-core parity fixes

Implement missing shared behavior in Altus for the approved `must-port` items.

### Phase 3: AltWire adaptation layer

Wrap or adapt shared behavior where Altus needs editorial naming, editorial memory keys, or AltWire-specific persistence/data source logic.

### Phase 4: Regression guardrails

Add tests or parity assertions so future Nimbus changes are easier to evaluate systematically.

## Risks

### Over-porting Nimbus-specific assumptions

Risk:
We copy support or commerce assumptions that do not fit AltWire.

Mitigation:
Use the classification model and require an explicit reason for every port.

### Under-porting shared Hal logic

Risk:
We keep Altus “editorial only” and miss generic Hal brain regressions.

Mitigation:
Treat Nimbus shared modules as the default reference and require an explicit reason to skip.

### Hidden behavioral drift

Risk:
Altus appears to have a feature but behaves differently in edge cases.

Mitigation:
Review recent Nimbus bugfix commits and add regression tests, not just tool-count checks.

### Scope explosion

Risk:
Parity work turns into a full platform unification effort.

Mitigation:
Do not extract shared packages in this pass. Align behavior first.

## Success Criteria

This work is successful when:

- Altus has no missing generic Hal admin-facing capability that would create a regression relative to Nimbus for AltWire use.
- Shared Hal bugfixes that matter to Altus behavior are ported or intentionally waived.
- All newly discovered non-WooCommerce/non-CW Nimbus tools are explicitly classified.
- Altus remains the primary Hal brain for AltWire, with editorial-specific tools layered on top of a more parity-aligned shared core.
- Future parity checks can be repeated with less manual effort because the gap matrix and tests exist.

## Non-Goals

- Extracting a shared multi-repo Hal package in this pass
- Porting WooCommerce, merchant, or Cirrusly Weather business logic into Altus
- Replacing Altus editorial-specific workflows with Nimbus workflows
- Refactoring unrelated Altus modules just because Nimbus has a different structure
