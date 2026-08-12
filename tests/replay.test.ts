import { describe, expect, test } from "bun:test";
import { recordReplay, replay } from "../src/replay.ts";
import { PLATFORM_REPLAY_FIXTURES } from "../src/replay-fixtures.ts";

describe("replay", () => {
  test("records redacted trajectories and replays deterministically", async () => {
    const event = await recordReplay("tool", { api_key: "secret", action: "search" }, { token: "hidden", result: "ok" });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("hidden");
    const out = await replay([event], async (item) => `${item.kind}:${(item.input as any).action}`);
    expect(out).toEqual(["tool:search"]);
  });

  test("replays platform control-flow fixtures deterministically", async () => {
    const out = await replay(PLATFORM_REPLAY_FIXTURES, async (event) => `${event.kind}:${(event.output as any).status || "ok"}`);
    expect(out).toEqual(["tool_search:ok", "policy:ok", "delivery:delivered", "budget:ok"]);
  });
});
