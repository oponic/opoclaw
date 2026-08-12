import { describe, expect, test } from "bun:test";
import { deliverLastActive, registerDeliveryTarget } from "../src/channels/delivery.ts";
import { createJob, cancelJob, getJob } from "../src/jobs.ts";
import { getTools, searchToolsets } from "../src/tools/index.ts";
import { AgentSession } from "../src/agent.ts";

describe("platform services", () => {
  test("delivery routes to registered active conversation", async () => {
    let received = "";
    const ref = { channel: "terminal" as const, conversationId: "platform-test" };
    registerDeliveryTarget(ref, async (content) => {
      received = content;
      return { delivered: true };
    });
    // Terminal targets intentionally reject attachments, but ordinary text is delivered.
    await Bun.sleep(20);
    expect((await deliverLastActive("hello")).delivered).toBe(true);
    expect(received).toBe("hello");
  });

  test("jobs persist lifecycle updates", async () => {
    const job = await createJob({ type: "timer", label: "test", request: "wait" });
    expect((await getJob(job.id))?.status).toBe("pending");
    expect(await cancelJob(job.id)).toBe(true);
    expect((await getJob(job.id))?.status).toBe("cancelled");
  });

  test("tool search finds scheduling and enables session set", () => {
    expect(searchToolsets("cron").some((set) => set.toolset === "scheduling")).toBe(true);
    const session = new AgentSession("platform-tools");
    expect(getTools({} as any, new Set(session.getEnabledToolsets())).some((tool) => tool.schema.function.name === "create_cron")).toBe(false);
    session.enableToolset("scheduling");
    expect(getTools({} as any, new Set(session.getEnabledToolsets())).some((tool) => tool.schema.function.name === "create_cron")).toBe(true);
  });
});
