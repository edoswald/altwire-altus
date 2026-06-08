# Story Opportunities GSC Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align story opportunities with Altus's lag-aware GSC date window and add a lightweight manual refresh path for pre-release verification.

**Architecture:** Reuse one shared GSC date-window helper instead of letting `getStoryOpportunities()` calculate its own live-date window. Keep the operator-facing smoke path small by extending the existing `/hal/writer/opportunities` endpoint with an explicit refresh flag rather than adding a separate trigger surface.

**Tech Stack:** Node.js, native HTTP routing in `index.js`, Vitest, PostgreSQL-backed agent memory cache

---

### Task 1: Add failing tests for the date window contract

**Files:**
- Modify: `tests/topic-discovery.unit.test.js`

- [ ] **Step 1: Write the failing tests**

Add focused tests that assert:
- default story-opportunities calls GSC with a 28-day window ending 3 days ago
- manual refresh bypasses the cache read path

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/topic-discovery.unit.test.js`
Expected: FAIL because the handler still uses today's date window and always consults cache first.

- [ ] **Step 3: Write minimal implementation**

Update `getStoryOpportunities()` to accept a refresh option and to consume the shared lag-aware window helper.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/topic-discovery.unit.test.js`
Expected: PASS

### Task 2: Wire the manual smoke path into the existing writer endpoint

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add route-level expectation**

Support `GET /hal/writer/opportunities?refresh=1` so operators can force a fresh run without waiting for cron or clearing cache manually.

- [ ] **Step 2: Verify with a focused route test or lightweight request harness if one exists**

Run the most focused verification available after implementation.
Expected: refresh requests call `getStoryOpportunities({ refresh: true })`.

### Task 3: Add or reuse shared lag-aware window logic

**Files:**
- Modify: `handlers/altus-combined-analytics.js`
- Modify: `handlers/altus-topic-discovery.js`
- Create: `lib/gsc-date-window.js` if extraction is cleaner than duplicating helper code

- [ ] **Step 1: Keep the helper small**

Expose a helper that returns:
- default end date: 3 days ago
- default 28-day start date: 31 days ago
- optional generic lookback support for story opportunities

- [ ] **Step 2: Use it from topic discovery**

Keep the returned `date_range` in the response so the manual smoke path shows the exact window used.

- [ ] **Step 3: Re-run focused tests**

Run: `npx vitest run tests/topic-discovery.unit.test.js`
Expected: PASS

### Task 4: Verify the smoke path contract

**Files:**
- Modify: `index.js` or add a tiny test harness only if needed

- [ ] **Step 1: Run focused verification**

Run the handler test suite and one additional check that confirms the refresh contract is reachable through the existing route shape.

- [ ] **Step 2: Document the operator command in the final handoff**

Include the exact request shape for pre-release smoke testing.
