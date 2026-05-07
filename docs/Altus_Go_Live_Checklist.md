# Altus Go-Live Checklist

Step-by-step pre-launch checklist for putting a new Altus deployment live.
Work top-to-bottom — each section depends on the ones above it. Tick boxes
as you go.

> **Audience:** the operator/admin (you). Derek's day-to-day usage guide
> lives in `docs/Derek_Onboarding_Guide.md`.

---

## 1. Infrastructure

- [ ] Railway project created with the `altwire-altus` service.
- [ ] Postgres database provisioned and accessible from the service
      (`DATABASE_URL` or `ALTWIRE_DATABASE_URL` set).
- [ ] Domain `altus.altwire.net` (or your chosen `MCP_BASE_URL`) is
      pointed at the Railway service and TLS is healthy.
- [ ] `GET /health` returns `200 OK`.

## 2. Required environment variables

See spec §11 for the full list. Minimum to boot cleanly:

- [ ] `ALTWIRE_DATABASE_URL` (or `DATABASE_URL`)
- [ ] `ALTWIRE_WP_URL`, `ALTWIRE_WP_USER`, `ALTWIRE_WP_APP_PASSWORD`
- [ ] `VOYAGE_API_KEY`
- [ ] `ANTHROPIC_API_KEY`
- [ ] `HAL_KEY` (bearer token gating `/hal/*` and `/altwire/*` endpoints)

Once the service boots, the following schemas auto-init on first request
(check logs for `Schema init …`):

- [ ] `altus_content`, `altus_ai_usage`, OAuth tables, review tracker,
      watch list, writer pipeline, event log, heartbeat, action items.

## 3. OAuth (chat UI access)

For each operator who'll connect the Hal Chat UI:

- [ ] `OAUTH_CLIENT_ID_<OPERATOR>` set
- [ ] `OAUTH_CLIENT_SECRET_<OPERATOR>` set (hashed at runtime)
- [ ] `OAUTH_REDIRECT_URI` matches the chat UI host
- [ ] Optional: `OAUTH_CLIENT_TOOLS=clientId:tool1,tool2;…` to scope tools
- [ ] Test: log in from chat UI → tool list populates.

## 4. Analytics providers

### Matomo

- [ ] `ALTWIRE_MATOMO_URL`, `ALTWIRE_MATOMO_TOKEN_AUTH`,
      `ALTWIRE_MATOMO_SITE_ID` set.
- [ ] Quick smoke test:
      `curl -s "$ALTWIRE_MATOMO_URL?module=API&method=VisitsSummary.get&idSite=$ALTWIRE_MATOMO_SITE_ID&period=day&date=yesterday&format=JSON&token_auth=$ALTWIRE_MATOMO_TOKEN_AUTH"`
      returns visit data.

### Google Search Console

- [ ] Service account created in Google Cloud Console with
      `https://www.googleapis.com/auth/webmasters.readonly` scope.
- [ ] Service account email added as a verified user on the GSC
      property.
- [ ] `ALTWIRE_GSC_SERVICE_ACCOUNT_JSON` set (full JSON, single line).
- [ ] `ALTWIRE_GSC_SITE_URL` set (`https://altwire.net` or
      `sc-domain:altwire.net`).
- [ ] Run: `node scripts/test-gsc-connection.js` — should print
      "getSearchPerformance: OK".

## 5. Monitoring & Slack

- [ ] `BETTER_STACK_TOKEN` and `BETTERSTACK_STATUS_PAGE_ID` set.
- [ ] Better Stack monitors for `altwire.net` and the WordPress cron
      heartbeat configured.
- [ ] `SLACK_BOT_TOKEN_ALTUS`, `SLACK_SIGNING_SECRET_ALTUS` set.
- [ ] Channel IDs set: `SLACK_CHANNEL_ALTWIRE`,
      `SLACK_CHANNEL_ADMIN_ANNOUNCEMENTS`, `SLACK_CHANNEL_BUG_REPORTS`,
      `SLACK_CHANNEL_WATERCOOLER`.
- [ ] Bot installed in each channel (post a test message via
      `post_slack_status` from the chat UI).

## 6. Soul + corpus seed (one-time)

Run from a workspace that can reach the prod DB:

- [ ] `node scripts/seed-hal-soul-altwire.js` — writes
      `hal:soul:altwire` (idempotent; skips if already present).
- [ ] `node scripts/ingest.js` — initial WordPress + galleries ingest.
      Watch the log for "Ingest complete" and confirm
      `SELECT COUNT(*) FROM altus_content;` returns several thousand
      rows.
- [ ] `node scripts/analyze-rag-corpus.js` — generates
      `hal:altwire:editorial_context` and `hal:altwire:editorial_voice_profile`.

## 7. Historical analytics seeds

These pull max retention from each provider and write summarized memory
keys Hal will draw on. Run **once each**; the nightly reflection
re-runs them every 30 days afterward.

- [ ] Matomo (18 months): `MINIMAX_API_KEY=… node scripts/seed-altwire-historical-analytics.js`
- [ ] GSC (16 months): `node scripts/seed-altwire-historical-gsc.js`
      _(use `--no-llm` if you want raw rollups without the Sonnet pass)_

Verify with `query_altus_events` from the chat UI, or directly:

```sql
SELECT key FROM agent_memory
 WHERE agent='hal' AND key LIKE 'hal:altwire:%' ORDER BY key;
```

You should see at least:
`hal:altwire:analytics:traffic_summary`, `…:top_articles_18m`, `…:topic_trends`,
`hal:altwire:gsc:summary_16m`, `…:top_queries_16m`, `…:opportunities_16m`,
`hal:altwire:gsc:last_refreshed`.

## 8. Cron sanity

The four crons register at boot when `DATABASE_URL` is set. Confirm in logs:

- [ ] `cron registered: ingest (0 3 * * * UTC)`
- [ ] `cron registered: reflection (0 5 * * * America/New_York)`
- [ ] `cron registered: performance snapshot (0 6 * * * America/New_York)`
- [ ] `cron registered: news monitor (0 9 * * * America/New_York)`

After 24h, check `altus_event_log` for `cron_*` entries — each cron
should have fired at least once.

## 9. Tool surface smoke tests

From the chat UI (logged in as Derek), ask Hal to run these. Each should
return data, not an error:

- [ ] `get_altwire_morning_digest` — should populate uptime, traffic,
      and (after the seeds) a `combined_synthesis` block.
- [ ] `get_altwire_search_performance` for last 28 days — should return
      query rows with clicks/impressions/position.
- [ ] `get_altwire_combined_analytics` — should return `synthesis` with
      a non-null `headline`.
- [ ] `search_altwire_archive` for any topic — should return relevant
      article titles.
- [ ] `get_archive_stats` — should report several thousand documents
      indexed and a recent `last_ingested_at`.

## 10. Chat UI handshake

- [ ] hal-chat-ui deployed with `VITE_ALTUS_URL` pointing at the Altus
      service. Confirm the deployed version is at least the one
      currently set in `hal-chat-ui/package.json` (`version` field) /
      top entry of `hal-chat-ui/src/changelog.ts`.
- [ ] Open Altus tab → Settings drawer → **Analytics** tab. You should
      see Matomo and GSC sections both showing real numbers and no
      "not configured" warnings.
- [ ] Profile tab loads Derek's voice profile.

## 11. Hand-off to Derek

- [ ] Send Derek `docs/Derek_Onboarding_Guide.md`.
- [ ] Confirm his login works on web and iOS.
- [ ] Walk through the morning digest once together so he knows what
      "good" looks like.

---

### Recovery shortcuts

| Problem | Fix |
|---|---|
| Settings drawer says "Matomo not configured" but env vars are set | Hit `/altwire/digest` directly — `providers.matomo.last_error` will tell you the real cause (auth, network, etc.). |
| GSC tools return `gsc_not_configured` | Service account JSON didn't parse — re-paste single-line JSON and restart. |
| GSC seed fails partway | Re-run with `--force`; the script is idempotent and overwrites memory keys atomically. |
| Reflection cron didn't fire | `query_altus_events { event_type: 'cron_reflection' }` shows the last run. If empty, check `cron registered:` log line at boot. |
| Tool count looks low in Hal's tool list | `OAUTH_CLIENT_TOOLS` may be scoping tools per client — check the env var. |
