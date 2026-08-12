# Platform completion matrix

This document maps the requested agent-platform update to its implementation and verification.

| Capability | Implementation | Verification |
|---|---|---|
| Cron + durable scheduling | `src/jobs.ts`, `src/cron.ts`, `src/tools/cron-tools.ts` | cron syntax/range/timezone/lifecycle/due-job tests in `tests/platform-extensive.test.ts` |
| Any-channel automated delivery | `src/channels/delivery.ts`, Discord/Signal/IRC/core adapters | queue retry/recovery/artifact delivery and channel tests |
| Agent messages between tool calls | `AgentCallbacks.onToolProgress`, `onUsageAlert`, delivery queue | agent/channel/platform tests |
| Sandboxed Deno + bridge | `src/tools/code-tools.ts`, `src/deno.ts` | live Deno import/sandbox/bridge tests |
| No fixed tool-call cap | `src/agent.ts` | progress callback behavior and agent loop tests |
| Tool progress estimates | `src/agent.ts`, channel callbacks | platform/channel tests |
| Spend alerts and limits | `src/usage.ts`, `src/agent.ts`, config | threshold, hard/session/job budget tests |
| Minimal toolsets + discovery | `src/tools/index.ts`, `discovery-tools.ts` | tool visibility/search tests |
| Signal channel | `src/channels/signal/index.ts`, `src/signal/rpc.ts` | disabled startup + Unix-socket RPC test |
| Central policy + scoped approval | `src/policy.ts`, `src/agent.ts`, channel approval adapters | resource/expiry/scope tests |
| Jobs/recovery/cancellation/concurrency | `src/jobs.ts`, `src/job-runner.ts` | stale lease, cancellation, timer tests |
| Artifacts | `src/artifacts.ts`, artifact/file tools | dedupe/quota/delivery tests |
| Activity + doctor + status | `activity.ts`, CLI, `/activity`, `/health`, `platform-status.ts` | activity auth/filter and health tests |
| Config validation + atomic updates | `config-validation.ts`, gateway tool | config and tool tests |
| Replay | `replay.ts`, fixtures, agent runtime recording | replay fixture and redaction tests |
| Required default Deno | installers, Dockerfile, `src/deno.ts` | live Deno tests; Docker image build/runtime verified |
| Documentation search | `src/tools/docs-tools.ts` | documentation search/ranking/visibility tests |

## Verification gate

Run:

```sh
PATH="$HOME/.deno/bin:$PATH" bunx tsc --noEmit
PATH="$HOME/.deno/bin:$PATH" bun test
docker build -t opoclaw-integration-test .
docker run --rm --entrypoint deno opoclaw-integration-test --version
```

The test suite validates unit, policy, durable-state, channel, replay, and live Deno paths. Docker verifies the required Deno runtime is shipped in the production image.
