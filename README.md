# opoclaw
opoclaw is an OpenClaw alternative built in Bun made to be fast and sandboxed. It is entirely safe to run by default, simple and easy to use, and a polished experience.
|                       | **Opoclaw**          | OpenClaw   | NanoClaw   | PicoClaw |
|-----------------------|----------------------|------------|------------|----------|
| Language              | **Bun (TypeScript)** | TypeScript | TypeScript | Go       |
| RAM                   | **<100 MB**           | <1 GB      | <500 MB    | <10 MB   |
| Startup (0.8GHz core) | **1.5s**              | <500s      | <30s       | <1s      |
## Getting Started
You can find the installation scripts in the Releases tab, or copy one of these for your operating system:

macOS and Linux: `curl -fsSL https://raw.githubusercontent.com/oponic/opoclaw/refs/heads/main/installers/setup.sh | bash`

Windows: `irm https://raw.githubusercontent.com/oponic/opoclaw/refs/heads/main/installers/setup.ps1 | iex`

## Platform capabilities

- **Focused tools:** agents begin with a minimal safe toolset and use `tool_search` to enable focused capabilities for the current session. `search_docs` is available by default for searching bundled Opoclaw documentation with file/line snippets.
- **Durable jobs:** timers, background work, and cron jobs are persisted and inspectable through job tools.
- **Delivery:** automated messages use the conversation that originated the work; failures are recorded in the activity log.
- **Deno (required):** the sandboxed `deno` TypeScript tool is enabled by default. Opoclaw requires Deno at gateway startup and installers/Docker provide it. Set `tools.deno_enabled = false` only to explicitly disable the feature and bypass the startup prerequisite.
- **Activity and diagnostics:** run `opoclaw activity` for redacted recent events and `opoclaw doctor` to check configuration, writable workspace, Deno, and optional Signal prerequisites.
- **Budgets:** `usage_alerts.thresholds` sends rolling-24-hour alerts; set `usage_alerts.hard_limit` to pause new model calls at a spending ceiling.
- **Replay:** runtime trajectories can be recorded and replayed with redacted inputs for deterministic regression tests.
- **Signal:** configure `[channel.signal]` with a signal-cli account and endpoint. The gateway can start `signal-cli daemon` when `autostart = true`.

### Configuration examples

```toml
[cron]
enabled = true
max_jobs = 100

[usage_alerts]
thresholds = [1, 2]
hard_limit = 10
session_limit = 2
job_limit = 1.5

[artifacts]
retention_days = 7
max_bytes = 104857600

[activity]
enabled = true
token = "replace-with-a-local-secret"
```

When activity is enabled, query `GET /activity` on the core listener with `Authorization: Bearer <token>`. It supports `limit`, `type`, `session`, and `job` query parameters.

### Signal

Signal uses the local `signal-cli` daemon. During onboarding choose **Signal**, provide the linked/registered account number, then install and link `signal-cli` (for example `signal-cli link -n "opoclaw"`). Configure `channel.signal.socket` or `channel.signal.host`/`port` when using a non-default daemon endpoint. Signal supports replies, approvals, questions, reactions, attachments, queued delivery, progress, and usage alerts; group messages must mention the configured `channel.signal.bot_name`.

## Operations

- `opoclaw doctor --json` validates configuration, Deno, workspace access, and enabled optional channel prerequisites.
- `opoclaw activity --json` prints redacted activity events. Filter with `--type=`, `--session=`, `--job=`, and `--limit=`.
- Durable jobs can be inspected by agents with `list_jobs` / `get_job` and cancelled with `cancel_job`.
- `search_docs` lets agents search this bundled documentation safely; it returns project-relative file and line references.
- `tools.deno_enabled` defaults to `true`; disabling it is the only supported way to run without the required Deno runtime.

## Docker

Deno is installed in the supplied image because sandboxed TypeScript execution is enabled by default. `signal-cli` remains an optional host/container addition when enabling Signal.
Build and run with Docker (network access is enabled by default, required for search/web fetch):

```bash
docker build -t opoclaw .
docker run --rm -it \
  -v "$PWD/config.toml:/app/config.toml" \
  -v "$PWD/workspace:/app/workspace" \
  -v "$PWD/usage.json:/app/usage.json" \
  opoclaw
```

Or with Docker Compose:

```bash
docker compose up --build -d
```
