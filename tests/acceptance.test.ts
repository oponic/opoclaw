import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import net from "net";
import { join } from "path";
import { tmpdir } from "os";
import { AgentSession } from "../src/agent.ts";
import { handleCoreRequest } from "../src/channels/core.ts";
import { validateConfig } from "../src/config-validation.ts";
import { provider } from "../src/provider/index.ts";
import { getTools } from "../src/tools/index.ts";
import { handleToolCall } from "../src/tools/index.ts";
import { createArtifact } from "../src/artifacts.ts";
import { deliver, drainDeliveryQueue, registerDeliveryTarget } from "../src/channels/delivery.ts";
import { createJob, getJob } from "../src/jobs.ts";
import { runDueJobs } from "../src/job-runner.ts";
import { runDueCronJobs } from "../src/cron.ts";
import { getPolicyDecision, grantApproval } from "../src/policy.ts";
import { recordReplay, replay } from "../src/replay.ts";
import { searchDocumentation } from "../src/tools/docs-tools.ts";
import { SignalRpc } from "../src/signal/rpc.ts";

const config: any = {
  provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } },
  cron: { enabled: true, timezone: "UTC", max_jobs: 10 },
  tools: { deno_enabled: true },
  usage_alerts: { thresholds: [1, 2] },
};

describe("platform acceptance", () => {
  test("executes the integrated agent platform workflow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opoclaw-acceptance-"));
    const configPath = join(dir, "config.toml");
    await writeFile(configPath, `[provider]\nactive = "openrouter"\n[provider.openrouter]\napi_key = "k"\nmodel = "m"\nbase_url = "http://localhost"\n[cron]\nenabled = true\ntimezone = "UTC"\n[activity]\nenabled = true\ntoken = "acceptance-token"\n`);
    const oldConfig = process.env.OPOCLAW_CONFIG_PATH;
    process.env.OPOCLAW_CONFIG_PATH = configPath;
    const originalProvider = provider.generateCompletion;
    let delivered = "";
    const ref = { channel: "discord" as const, conversationId: `acceptance-${Date.now()}` };
    registerDeliveryTarget(ref, async (content, attachments) => {
      delivered += content;
      if (attachments?.length) delivered += `:${attachments.length} attachment`;
      return { delivered: true };
    });

    try {
      // Toolset visibility and documentation discovery.
      const session = new AgentSession(`acceptance-session-${Date.now()}`);
      session.deliveryTarget = ref;
      expect(getTools(config, new Set(session.getEnabledToolsets())).some((tool) => tool.schema.function.name === "search_docs")).toBe(true);
      expect((await searchDocumentation("Deno required", 1)).toLowerCase()).toContain("deno");

      // Exact-resource policy scope.
      const sensitive = getTools(config).find((tool) => tool.schema.function.name === "edit_config")!;
      expect((await getPolicyDecision(sensitive, session.sessionId, { key: "cron.enabled" })).requiresApproval).toBe(true);
      await grantApproval(session.sessionId, "edit_config", "session", "edit_config:config:cron.enabled");
      expect((await getPolicyDecision(sensitive, session.sessionId, { key: "cron.enabled" })).requiresApproval).toBe(false);

      // Artifact-backed durable delivery.
      const artifact = await createArtifact("acceptance artifact", { name: "acceptance.txt", sessionId: session.sessionId });
      expect((await deliver(ref, "artifact", [artifact.id])).delivered).toBe(true);
      expect(delivered).toContain("attachment");

      // Durable timer job execution.
      const timer = await createJob({ type: "timer", label: "acceptance timer", request: "timer", target: ref, nextRunAt: new Date(Date.now() - 1_000).toISOString() });
      await runDueJobs();
      expect((await getJob(timer.id))?.status).toBe("completed");

      // Cron agent -> queued delivery integration.
      provider.generateCompletion = async () => ({ text: "cron acceptance", toolCalls: [], usage: null, reasoning: "" });
      const cron = await createJob({ type: "cron", label: "acceptance cron", request: "run", schedule: "* * * * *", target: ref, nextRunAt: new Date(Date.now() - 1_000).toISOString() });
      await runDueCronJobs();
      await Bun.sleep(10);
      await drainDeliveryQueue(new Date(Date.now() + 2_000));
      expect((await getJob(cron.id))?.status).toBe("pending");
      expect(delivered).toContain("cron acceptance");

      // Live required Deno sandbox and explicit bridge.
      const deno = await handleToolCall("deno", { description: "acceptance bridge", allowed_tools: ["get_time"], code: `console.log(await (globalThis as any).opoclaw.call("get_time"))` }, { config, session });
      expect(deno).toContain("Deno exited with code 0");

      // Signal daemon JSON-RPC bridge using the same local Unix socket protocol.
      const signalSocket = join(dir, "signal.sock");
      const signalServer = net.createServer((socket) => socket.on("data", (chunk) => {
        const request = JSON.parse(chunk.toString().trim());
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }) + "\n");
      }));
      await new Promise<void>((resolve) => signalServer.listen(signalSocket, resolve));
      const signal = new SignalRpc({ socket: signalSocket });
      expect(await signal.request("ping")).toEqual({ ok: true });
      signal.close();
      await new Promise<void>((resolve) => signalServer.close(() => resolve()));

      // Authenticated activity API, configuration validation, and complete health snapshot.
      const activityConfig = { ...config, activity: { enabled: true, token: "acceptance-token" } };
      expect(validateConfig(activityConfig).filter((issue) => issue.path === "activity.token")).toEqual([]);
      const unauthorized = await handleCoreRequest(new Request("http://127.0.0.1:6112/activity"));
      expect(unauthorized.status).toBe(401);
      const authorized = await handleCoreRequest(new Request("http://127.0.0.1:6112/activity?type=tool", { headers: { Authorization: "Bearer acceptance-token" } }));
      expect(authorized.status).toBe(200);

      // Redacted replay trajectory is executable deterministically.
      const event = await recordReplay("acceptance", { token: "secret", step: "done" }, { result: "ok" });
      expect(JSON.stringify(event)).not.toContain("secret");
      expect(await replay([event], async (item) => (item.input as any).step)).toEqual(["done"]);
    } finally {
      provider.generateCompletion = originalProvider;
      if (oldConfig === undefined) delete process.env.OPOCLAW_CONFIG_PATH; else process.env.OPOCLAW_CONFIG_PATH = oldConfig;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
