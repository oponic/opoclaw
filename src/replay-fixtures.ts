import type { ReplayEvent } from "./replay.ts";

/** Deterministic fixtures used to regression-test platform control flow. */
export const PLATFORM_REPLAY_FIXTURES: ReplayEvent[] = [
    { id: "toolset", at: "2000-01-01T00:00:00.000Z", kind: "tool_search", input: { query: "cron" }, output: { toolset: "scheduling" } },
    { id: "policy", at: "2000-01-01T00:00:01.000Z", kind: "policy", input: { tool: "edit_config", resource: "edit_config:config:cron.enabled" }, output: { approved: true } },
    { id: "delivery", at: "2000-01-01T00:00:02.000Z", kind: "delivery", input: { idempotencyKey: "fixture" }, output: { status: "delivered" } },
    { id: "budget", at: "2000-01-01T00:00:03.000Z", kind: "budget", input: { threshold: 1 }, output: { warned: true } },
];
