import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createArtifact, getArtifact, listArtifacts } from "../src/artifacts.ts";
import { deliver, drainDeliveryQueue, enqueueDelivery, listOutboundDeliveries, registerDeliveryTarget } from "../src/channels/delivery.ts";
import { validateConfig } from "../src/config-validation.ts";
import { cancelJob, createJob, cronMatches, getJob, nextCronRun, recoverStaleJobs, updateJob, validateCron } from "../src/jobs.ts";
import { runDueJobs } from "../src/job-runner.ts";
import { runDueCronJobs, startCronScheduler, stopCronScheduler } from "../src/cron.ts";
import { provider } from "../src/provider/index.ts";
import { runMaintenancePass } from "../src/operations.ts";
import { getPolicyDecision, grantApproval } from "../src/policy.ts";
import { getToolWithName, getTools } from "../src/tools/index.ts";
import { searchDocumentation } from "../src/tools/docs-tools.ts";
import { getRollingCost, recordUsage } from "../src/usage.ts";
import { handleToolCall } from "../src/tools/index.ts";
import { AgentSession } from "../src/agent.ts";

const context: any = { config: { tools: { deno_timeout_ms: 5_000 } }, session: new AgentSession(`platform-extensive-${Date.now()}`) };

describe("platform validation and scheduling", () => {
  test("validates cron syntax and finds future schedules", () => {
    expect(validateCron("*/15 9-17 * * 1-5")).toBe(true);
    expect(validateCron("bad cron")).toBe(false);
    expect(validateCron("61 * * * *")).toBe(false);
    const next = nextCronRun("0 9 * * *", new Date(2026, 0, 1, 8, 59));
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(0);
    expect(cronMatches("0 9 * * *", new Date(2026, 0, 1, 9, 0))).toBe(true);
    expect(cronMatches("0 9 * * *", new Date(2026, 0, 1, 9, 1))).toBe(false);
    // 14:00 UTC is 09:00 in New York during standard time.
    expect(cronMatches("0 9 * * *", new Date("2026-01-01T14:00:00Z"), "America/New_York")).toBe(true);
  });

  test("recovers expired durable job leases", async () => {
    const job = await createJob({ type: "timer", label: "stale", request: "timer", nextRunAt: new Date().toISOString() });
    await updateJob(job.id, { status: "running", leaseUntil: new Date(Date.now() - 1_000).toISOString() });
    expect(await recoverStaleJobs()).toBeGreaterThan(0);
    expect((await getJob(job.id))?.status).toBe("pending");
  });

  test("cancels durable jobs before execution", async () => {
    const job = await createJob({ type: "timer", label: "cancelled", request: "timer", nextRunAt: new Date(Date.now() - 1_000).toISOString() });
    expect(await cancelJob(job.id)).toBe(true);
    await runDueJobs();
    expect((await getJob(job.id))?.status).toBe("cancelled");
  });

  test("runs a due durable timer exactly once", async () => {
    const job = await createJob({ type: "timer", label: "due timer", request: "timer", nextRunAt: new Date(Date.now() - 1_000).toISOString() });
    await runDueJobs();
    expect((await getJob(job.id))?.status).toBe("completed");
    await runDueJobs();
    expect((await getJob(job.id))?.status).toBe("completed");
  });

  test("executes due cron work and delivers its result", async () => {
    const original = provider.generateCompletion;
    provider.generateCompletion = async () => ({ text: "scheduled result", toolCalls: [], usage: null, reasoning: "" });
    const ref = { channel: "terminal" as const, conversationId: `cron-delivery-${Date.now()}` };
    let delivered = "";
    registerDeliveryTarget(ref, async (content) => { delivered = content; return { delivered: true }; });
    const job = await createJob({ type: "cron", label: "cron delivery", request: "do scheduled work", schedule: "* * * * *", nextRunAt: new Date(Date.now() - 1_000).toISOString(), target: ref });
    const originalConfig = process.env.OPOCLAW_CONFIG_PATH;
    const dir = await mkdtemp(join(tmpdir(), "opoclaw-cron-"));
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, `[cron]\nenabled = true\n[provider]\nactive = "openrouter"\n[provider.openrouter]\napi_key = "k"\nmodel = "m"\nbase_url = "http://localhost"\n`);
    process.env.OPOCLAW_CONFIG_PATH = configPath;
    try {
      await runDueCronJobs();
      await Bun.sleep(20);
      await drainDeliveryQueue(new Date(Date.now() + 2_000));
      expect(delivered).toBe("scheduled result");
      expect((await getJob(job.id))?.status).toBe("pending");
    } finally {
      provider.generateCompletion = original;
      if (originalConfig === undefined) delete process.env.OPOCLAW_CONFIG_PATH; else process.env.OPOCLAW_CONFIG_PATH = originalConfig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cron scheduler can be cleanly restarted and stopped", () => {
    expect(startCronScheduler()).toBeDefined();
    stopCronScheduler();
    expect(startCronScheduler()).toBeDefined();
    stopCronScheduler();
  });

  test("runs a complete deterministic operations maintenance pass", async () => {
    await expect(runMaintenancePass(1)).resolves.toBeUndefined();
  });

  test("reports enabled channel and provider configuration errors", () => {
    const issues = validateConfig({ provider: { active: "openrouter" }, channel: { discord: { enabled: true } } } as any);
    expect(issues.some((issue) => issue.path === "provider.openrouter.api_key")).toBe(true);
    expect(issues.some((issue) => issue.path === "channel.discord.token")).toBe(true);
    expect(validateConfig({ cron: { max_jobs: 0 }, usage_alerts: { thresholds: [-1] } } as any).length).toBeGreaterThan(0);
  });
});

describe("delivery and policy", () => {
  test("delivers queued artifacts through registered capable targets", async () => {
    const artifact = await createArtifact("attachment", { name: "attachment.txt", sessionId: `delivery-${Date.now()}` });
    let attachments: string[] = [];
    const ref = { channel: "discord" as const, conversationId: `attachments-${Date.now()}` };
    registerDeliveryTarget(ref, async (_content, paths) => { attachments = paths || []; return { delivered: true }; });
    expect((await deliver(ref, "artifact", [artifact.id])).delivered).toBe(true);
    expect(attachments).toContain(artifact.path);
  });

  test("recovers queued delivery after a target becomes available", async () => {
    const ref = { channel: "terminal" as const, conversationId: `recover-${Date.now()}` };
    const queued = await enqueueDelivery(ref, "recover", undefined, `recover-key-${Date.now()}`);
    await drainDeliveryQueue();
    expect((await listOutboundDeliveries()).find((item) => item.id === queued.id)?.status).toBe("pending");
    let delivered = "";
    registerDeliveryTarget(ref, async (content) => { delivered = content; return { delivered: true }; });
    await Bun.sleep(20);
    await drainDeliveryQueue(new Date(Date.now() + 2_000));
    expect(delivered).toBe("recover");
    expect((await listOutboundDeliveries()).find((item) => item.id === queued.id)?.status).toBe("delivered");
  });

  test("deduplicates outbound delivery requests by idempotency key", async () => {
    let sends = 0;
    const ref = { channel: "terminal" as const, conversationId: `dedupe-${Date.now()}` };
    registerDeliveryTarget(ref, async () => { sends++; return { delivered: true }; });
    const first = await enqueueDelivery(ref, "one", undefined, "dedupe-key");
    const second = await enqueueDelivery(ref, "two", undefined, "dedupe-key");
    expect(second.id).toBe(first.id);
    await deliver(ref, "deliver-now");
    expect(sends).toBeGreaterThan(0);
    expect((await listOutboundDeliveries()).some((item) => item.id === first.id)).toBe(true);
  });

  test("enforces exact resource scope and expiry", async () => {
    const tool = getToolWithName("edit_config")!, session = `scope-${Date.now()}`;
    await grantApproval(session, "edit_config", "duration", "edit_config:config:enabled", -1);
    expect((await getPolicyDecision(tool, session, { key: "enabled" })).requiresApproval).toBe(true);
    await grantApproval(session, "edit_config", "session", "edit_config:config:enabled");
    expect((await getPolicyDecision(tool, session, { key: "other" })).requiresApproval).toBe(true);
    expect((await getPolicyDecision(tool, session, { key: "enabled" })).requiresApproval).toBe(false);
  });

  test("requires and grants session policy approval", async () => {
    const tool = getToolWithName("edit_config")!;
    const session = `policy-${Date.now()}`;
    expect((await getPolicyDecision(tool, session)).requiresApproval).toBe(true);
    await grantApproval(session, "edit_config", "session", "edit_config:global");
    expect((await getPolicyDecision(tool, session)).requiresApproval).toBe(false);
  });
});

describe("artifacts and usage", () => {
  test("rejects artifact quota overflow", async () => {
    await expect(createArtifact("too large", { name: "quota.txt", maxBytes: 1 })).rejects.toThrow("quota");
  });

  test("deduplicates identical artifact content within provenance", async () => {
    const sessionId = `artifact-${Date.now()}`;
    const one = await createArtifact("same bytes", { name: "first.txt", sessionId });
    const two = await createArtifact("same bytes", { name: "second.txt", sessionId });
    expect(two.id).toBe(one.id);
    expect((await getArtifact(one.id))?.sha256).toBe(one.sha256);
    expect((await listArtifacts(sessionId)).some((artifact) => artifact.id === one.id)).toBe(true);
  });

  test("records only fresh crossed usage thresholds", async () => {
    const threshold = (await getRollingCost()) + 1_000_000_000_000_000_000;
    const crossed = await recordUsage({ prompt_tokens: 1, completion_tokens: 1, cost: 1_000_000_000_000_000_001 }, `usage-${Date.now()}`, [threshold]);
    expect(crossed).toContain(threshold);
  });
});

describe("documentation search", () => {
  test("searches bundled documentation with line references", async () => {
    const result = await searchDocumentation("sandboxed Deno", 3);
    expect(result).toContain("README.md:");
    expect(result.toLowerCase()).toContain("deno");
    expect(result.split("\n\n").length).toBeLessThanOrEqual(3);
  });

  test("search_docs is available in the default information toolset", () => {
    expect(getTools({} as any).some((tool) => tool.schema.function.name === "search_docs")).toBe(true);
  });
});

describe("Deno enablement", () => {
  test("exposes Deno by default and supports explicit opt-out", () => {
    expect(getTools({} as any).some((tool) => tool.schema.function.name === "deno")).toBe(true);
    expect(getTools({ tools: { deno_enabled: false } } as any).some((tool) => tool.schema.function.name === "deno")).toBe(false);
  });
});

describe("Deno sandbox", () => {
  test("rejects imports outside its configured allowlist", async () => {
    await expect(handleToolCall("deno", { description: "bad import", code: `import x from "https://example.com/x.ts"; console.log(x)` }, context)).rejects.toThrow("Imports are restricted");
  });

  test("runs restricted TypeScript and captures output", async () => {
    const result = await handleToolCall("deno", { description: "calculate", code: `console.log(2 + 3)` }, context);
    expect(result).toContain("Deno exited with code 0");
    expect(result).toContain("5");
  }, 30_000);

  test("loads an allowed Deno library", async () => {
    const result = await handleToolCall("deno", { description: "validate data", code: `import { z } from "npm:zod"; console.log(z.string().parse("ok"))` }, context);
    expect(result).toContain("Deno exited with code 0");
    expect(result).toContain("ok");
  }, 30_000);

  test("bridges an explicitly allowed visible Opoclaw tool", async () => {
    const result = await handleToolCall("deno", {
      description: "read current time",
      allowed_tools: ["get_time"],
      code: `console.log(await (globalThis as any).opoclaw.call("get_time"))`,
    }, context);
    expect(result).toContain("Deno exited with code 0");
    expect(result).toContain("iso");
  }, 30_000);
});
