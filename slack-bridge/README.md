# AltWire Insights: Slack bridge

A small service that puts the **AltWire Insights** managed agent in Slack as its own app.

```
Slack ── AltWire Insights app ──► this bridge ──► Claude Managed Agents session ──► reply in Slack
                                      │                 ├─ Altus (shared vault)
                                      │                 └─ Canva / Zoho (personal vault, DMs only)
                                      └─ scheduled jobs (weekly recap, …)
```

- **@mention in an allowed channel** → the bridge replies in a thread; one agent session per thread, and follow-ups in that thread continue it.
- **DM the app** → a private conversation. Your linked accounts (Canva, your Zoho Mail server) are added **only** here, never in channels.
- **The agent has no Slack access.** The bridge posts every reply itself, and only to DMs or the channels in `BRIDGE_ALLOWED_CHANNELS`, so the agent cannot post anywhere else.
- **Files the agent creates** (reports, spreadsheets, slide decks from its document skills) are attached to the same thread after the reply, each one once. Needs the `files:write` scope.
- **Scheduled jobs** start a fresh session and post the result to their channel.
- Altus stays a plain MCP server. Nothing here depends on Anthropic's own Claude Slack app.

## DM commands

| Command | What it does |
|---|---|
| `help` | What the app can do |
| `new` | Start a fresh conversation in this DM |
| `connect canva` | Sends a one-time sign-in link; Canva is then available in your DMs |
| `connect <MCP server URL>` | Same, for any MCP server that supports OAuth sign-in (e.g. your Zoho MCP server URL) |
| `disconnect <canva or URL>` | Unlinks it |
| `connections` | Lists your linked accounts |
| `memory` | Lists the files in your personal memory and the team memory |

Only Slack users in `BRIDGE_CONNECT_USERS` can link accounts. Gmail can't be linked: it has no public MCP server that supports this sign-in, so forward the mail you want the agent to see into Zoho.

## Setup

### 1. Railway service

In the **AltWire Altus** project: **New service → GitHub repo → this repo**, then in its settings:

- **Root Directory:** `/slack-bridge` (it builds from `slack-bridge/package.json` and `railway.toml`)
- **Networking → Generate domain.** That URL is `BRIDGE_PUBLIC_URL`.

### 2. Slack app

1. Go to <https://api.slack.com/apps> → **Create New App → From an app manifest**, pick the workspace, and paste `slack-app-manifest.yaml` with `BRIDGE_URL` replaced by the Railway domain.
2. **Install to Workspace**. Copy the **Bot User OAuth Token** (`xoxb-…`) into `SLACK_BOT_TOKEN` and **Basic Information → Signing Secret** into `SLACK_SIGNING_SECRET`.
3. Invite the app to `#team-altwire` (`/invite @AltWire Insights`). Leave it out of channels it shouldn't answer in.

Slack verifies the events URL when you save the manifest, so deploy the bridge with its variables first. If verification fails, re-save **Event Subscriptions** once the bridge is up.

### 3. Anthropic

- **API key**: Console → API keys, in the same workspace as the agent → `ANTHROPIC_API_KEY`.
- **Agent and environment IDs** (`agent_…`, `env_…`) from the Console → `BRIDGE_AGENT_ID`, `BRIDGE_ENVIRONMENT_ID`.
- **Shared vault**: the vault holding the Altus sign-in (`vlt_…`) → `BRIDGE_SHARED_VAULT_ID`.
- **Agent config**: remove the `slack` MCP server and its toolset (the bridge posts now), and replace the Slack posting rules in the system prompt with:

  > Your reply is posted to Slack by the AltWire Insights app, in the conversation where you were asked. Write it as the message itself: Slack-friendly formatting (short paragraphs, bullets, *bold*), no Markdown headings or tables. In DMs you may also have the person's own linked accounts (for example Canva or their Zoho Mail); never mention or quote their mail outside that DM.

### 4. Environment variables

| Variable | Required | Value |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Anthropic API key |
| `BRIDGE_AGENT_ID` | yes | `agent_…` |
| `BRIDGE_ENVIRONMENT_ID` | yes | `env_…` |
| `BRIDGE_SHARED_VAULT_ID` | recommended | `vlt_…` with the Altus credential (sessions without it can't reach Altus) |
| `SLACK_BOT_TOKEN` | yes | `xoxb-…` |
| `SLACK_SIGNING_SECRET` | yes | From the Slack app |
| `BRIDGE_PUBLIC_URL` | yes | `https://<bridge domain>` (used for the sign-in callback) |
| `DATABASE_URL` | yes | Postgres; the bridge creates `bridge_*` tables. Altus's database is fine (Railway reference: `${{Altus (Admin MCP).ALTWIRE_DATABASE_URL}}`) |
| `BRIDGE_ALLOWED_CHANNELS` | yes | Comma-separated channel IDs, e.g. `C0AVAMXP17Y` |
| `BRIDGE_CONNECT_USERS` | for linking | Comma-separated Slack user IDs allowed to link accounts (Derek's) |
| `BRIDGE_SCHEDULES` | no | JSON array of scheduled jobs (below) |
| `BRIDGE_DM_SESSION_IDLE_MINUTES` | no | A DM conversation restarts after this much quiet (default 120) |
| `BRIDGE_MEMORY_STORE_ID` | no | `memstore_…`: shared team memory mounted in every session (below) |
| `BRIDGE_MEMORY_DM_ACCESS` | no | `read_only` (default) or `read_write`: the shared memory's access in DMs |
| `BRIDGE_PERSONAL_MEMORY` | no | `false` turns off per-person memory (on by default) |
| `BRIDGE_USER_NAMES` | no | `U0B0T1RH5SL=ed,U0B0UF0QHKJ=derek`: names personal stores (`altwire-ed`) instead of using Slack IDs |

### 5. Scheduled jobs

```json
[
  {
    "name": "weekly-recap",
    "cron": "45 8 * * 1",
    "timezone": "America/New_York",
    "channel": "C0AVAMXP17Y",
    "prompt": "Write the weekly AltWire analytics recap for #team-altwire: what moved, why, and the one story we should write next. Use get_altwire_morning_digest first."
  }
]
```

To run a job only part of the year, use the cron month field. The live holiday check-in posts Mondays at 8:50 ET from October through December (`"cron": "50 8 * 10-12 1"`, channel `C0C8DSN1BP0`), and its prompt asks for a season wrap-up after December 25.

Each job's channel must be in `BRIDGE_ALLOWED_CHANNELS`. A run that doesn't finish cleanly is logged and not posted.

### 6. Shared team memory (optional)

A Managed Agents memory store gives the agent a memory that outlasts a thread: editorial decisions, preferences, and project state such as the holiday tracker. Create one in the Console (**Memory stores → New**) and put its ID in `BRIDGE_MEMORY_STORE_ID`.

- **Mounted as files** at `/mnt/memory/<store name>/`; the agent reads and edits them with its file tools. Every change is versioned in the Console, so a bad entry can be reviewed, rolled back, or redacted.
- **Read-write in channels and scheduled jobs, read-only in DMs** by default. DMs can include someone's own mail, and read-only means none of it can be written into memory the whole team shares. Set `BRIDGE_MEMORY_DM_ACCESS=read_write` to change that.
- **What gets saved** is set by the instructions in `lib/memory.js`: decisions, preferences, project state, and corrections; never email content, credentials, or analytics numbers.
- **Starter files** (`holiday-2026.md`, `decisions.md`) are created on startup if they don't exist. Existing files are never overwritten.
- A store attaches when a session starts, so threads that began before it was configured don't see it; new ones do.

**Personal memory.** Each person who DMs the app gets their own store, created on their first DM (`altwire-<name>`, from `BRIDGE_USER_NAMES`, or their Slack ID) and seeded with a `preferences.md`. It's mounted read-write in **their DMs only**: never in channels, scheduled jobs, or anyone else's DMs. It holds how they like answers, what they work on, and their ongoing tasks, apart from the team memory. `memory` in a DM lists what's in both.

## Development

Logic lives in `lib/` (`app.js` wires it; `index.js` only reads config and starts the server). Tests are in the repo's root `tests/slack-bridge*.unit.test.js` and run with the main suite (`npm test` at the root).
