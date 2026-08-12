import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { buildClientOptions } from "../src/provider/openai.ts";
import { getToolWithName, handleToolCall, type ToolContext } from "../src/tools/index.ts";
import { AgentSession } from "../src/agent.ts";
import { provider } from "../src/provider/index.ts";
import type { CompletionResult } from "../src/provider/index.ts";
import { runHeartbeat } from "../src/channels/heartbeat.ts";
import { runDreamerBacklog } from "../src/channels/dreamer.ts";
import { readInteractionsForDate, utcDateString } from "../src/interactions.ts";

const INTERACTIONS_DIR = resolve(import.meta.dir, "../data/interactions");

function textResult(text: string): CompletionResult {
  return { text, toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, reasoning: "" };
}

function toolCallResult(name: string, args: Record<string, any>): CompletionResult {
  return {
    text: null,
    toolCalls: [{ id: "tc1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    reasoning: "",
  };
}

const DUMMY_TOOL_CONTEXT: ToolContext = { config: {} as any, session: new AgentSession("test-session") };

function configFor(provider: string): any {
  return {
    provider: {
      active: provider,
      [provider]: { api_key: "k", model: "m", base_url: "http://localhost" },
    },
  };
}

describe("OpenRouter attribution", () => {
  test("openrouter requests include attribution headers", () => {
    const options = buildClientOptions(configFor("openrouter"));
    expect(options.defaultHeaders).toEqual({
      "HTTP-Referer": "https://github.com/oponic/opoclaw",
      "X-Title": "opoclaw",
    });
  });

  test("non-openrouter providers omit attribution headers", () => {
    const options = buildClientOptions(configFor("ollama"));
    expect(options.defaultHeaders).toBeUndefined();
  });
});

describe("create_thread tool", () => {
  test("is registered with the expected schema", () => {
    const tool = getToolWithName("create_thread");
    expect(tool).toBeDefined();
    expect(tool!.schema.function.name).toBe("create_thread");
    expect(tool!.schema.function.parameters.required).toEqual(["name"]);
    expect(Object.keys(tool!.schema.function.parameters.properties)).toEqual([
      "name",
      "message_id",
      "initial_message",
    ]);
  });

  test("default handler reports it is Discord-only", async () => {
    await expect(
      handleToolCall("create_thread", { name: "x" }, DUMMY_TOOL_CONTEXT)
    ).rejects.toThrow("only available in Discord");
  });
});

describe("subagent tools", () => {
  test("subagent receives the full tool set, not just a dummy tool", async () => {
    const original = provider.generateCompletion;
    let capturedSubagentTools: string[] = [];
    let call = 0;
    provider.generateCompletion = async (_messages, _config, onFirstToken, tools) => {
      onFirstToken();
      call++;
      if (call === 1) return toolCallResult("run_subagent", { request: "do it", include_context: false });
      if (call === 2) {
        // This is the subagent's own model call — capture the tools it was given.
        capturedSubagentTools = tools.map((t) => t.schema.function.name);
        return textResult("subagent done");
      }
      return textResult("main done");
    };

    try {
      const session = new AgentSession("test-subagent-tools");
      session.addMessage({ role: "user", content: "delegate" });
      await session.evaluate("system", configFor("openrouter"), { onFirstToken: () => {} });
      expect(capturedSubagentTools).toContain("read_file");
      expect(capturedSubagentTools).toContain("shell");
      // Recursive spawn + interactive Discord-only tools are excluded.
      expect(capturedSubagentTools).not.toContain("run_subagent");
      expect(capturedSubagentTools).not.toContain("poll");
      expect(capturedSubagentTools).not.toContain("dummy_tool");
    } finally {
      provider.generateCompletion = original;
    }
  });
});

describe("heartbeat", () => {
  const WORKSPACE_DIR = resolve(import.meta.dir, "../workspace");

  async function withHeartbeatConfig(enabled: boolean, fn: () => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "opoclaw-hb-"));
    const path = join(dir, "config.toml");
    const body = enabled
      ? "[heartbeat]\nenabled = true\n\n[provider]\nactive = \"openrouter\"\n  [provider.openrouter]\n  api_key = \"k\"\n  model = \"m\"\n  base_url = \"http://localhost\"\n"
      : "[provider]\nactive = \"openrouter\"\n  [provider.openrouter]\n  api_key = \"k\"\n  model = \"m\"\n";
    await writeFile(path, body, "utf-8");
    process.env.OPOCLAW_CONFIG_PATH = path;
    const heartbeatFile = join(WORKSPACE_DIR, "HEARTBEAT.md");
    const hadHeartbeatFile = existsSync(heartbeatFile);
    await mkdir(WORKSPACE_DIR, { recursive: true });
    await writeFile(heartbeatFile, "Check in on things.\n", "utf-8");
    try {
      await fn();
    } finally {
      delete process.env.OPOCLAW_CONFIG_PATH;
      await rm(dir, { recursive: true, force: true });
      if (!hadHeartbeatFile) await rm(heartbeatFile, { force: true });
    }
  }

  test("does nothing when disabled", async () => {
    const original = provider.generateCompletion;
    let called = false;
    provider.generateCompletion = async () => { called = true; return textResult("x"); };
    try {
      await withHeartbeatConfig(false, async () => {
        await runHeartbeat();
      });
      expect(called).toBe(false);
    } finally {
      provider.generateCompletion = original;
    }
  });

  test("when enabled, runs the agent with HEARTBEAT.md and offers send_message", async () => {
    const original = provider.generateCompletion;
    let sawSendMessage = false;
    let sawHeartbeatPrompt = false;
    let call = 0;
    provider.generateCompletion = async (messages, _config, onFirstToken, tools) => {
      onFirstToken();
      call++;
      if (call === 1) {
        sawSendMessage = tools.some((t) => t.schema.function.name === "send_message");
        sawHeartbeatPrompt = messages.some(
          (m) => typeof m.content === "string" && m.content.includes("Heartbeat trigger")
        );
        return toolCallResult("send_message", { content: "checking in" });
      }
      return textResult("heartbeat done");
    };
    try {
      await withHeartbeatConfig(true, async () => {
        await runHeartbeat();
      });
      expect(sawSendMessage).toBe(true);
      expect(sawHeartbeatPrompt).toBe(true);
    } finally {
      provider.generateCompletion = original;
    }
  });
});

describe("interaction logging", () => {
  test("top-level sessions are logged, subagents are not", async () => {
    const original = provider.generateCompletion;
    provider.generateCompletion = async (_m, _c, onFirstToken) => {
      onFirstToken();
      return textResult("logged reply");
    };
    const topId = `opoclaw-test-top-${Date.now()}`;
    const subId = `opoclaw-test-sub-${Date.now()}`;
    try {
      const top = new AgentSession(topId);
      top.addMessage({ role: "user", content: "hello dreamer test" });
      await top.evaluate("system", configFor("openrouter"), { onFirstToken: () => {} });

      const sub = new AgentSession(subId, true);
      sub.addMessage({ role: "user", content: "subagent should not log" });
      await sub.evaluate("system", configFor("openrouter"), { onFirstToken: () => {} });

      const events = await readInteractionsForDate(utcDateString());
      const topEvents = events.filter((e) => e.session === topId);
      const subEvents = events.filter((e) => e.session === subId);
      expect(topEvents.some((e) => e.kind === "user" && e.content.includes("hello dreamer test"))).toBe(true);
      expect(topEvents.some((e) => e.kind === "assistant" && e.content.includes("logged reply"))).toBe(true);
      expect(subEvents.length).toBe(0);
    } finally {
      provider.generateCompletion = original;
    }
  });
});

describe("dreamer", () => {
  async function withDreamerConfig(enabled: boolean, fn: () => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "opoclaw-dream-"));
    const path = join(dir, "config.toml");
    const dreamerBlock = enabled ? "[dreamer]\nenabled = true\n\n" : "";
    await writeFile(
      path,
      `${dreamerBlock}[provider]\nactive = "openrouter"\n  [provider.openrouter]\n  api_key = "k"\n  model = "m"\n  base_url = "http://localhost"\n`,
      "utf-8",
    );
    process.env.OPOCLAW_CONFIG_PATH = path;
    try {
      await fn();
    } finally {
      delete process.env.OPOCLAW_CONFIG_PATH;
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("reflects over a past day's log and clears it", async () => {
    const pastDate = "2000-01-02";
    const pastFile = join(INTERACTIONS_DIR, `${pastDate}.jsonl`);
    await mkdir(INTERACTIONS_DIR, { recursive: true });
    await writeFile(
      pastFile,
      JSON.stringify({ ts: `${pastDate}T10:00:00.000Z`, session: "opoclaw-discord-x", kind: "user", content: "remember my cat is named Mochi" }) + "\n",
      "utf-8",
    );

    const original = provider.generateCompletion;
    let sawTranscript = false;
    provider.generateCompletion = async (messages, _c, onFirstToken) => {
      onFirstToken();
      sawTranscript ||= messages.some(
        (m) => typeof m.content === "string" && m.content.includes("Mochi") && m.content.includes(pastDate)
      );
      return textResult("memory updated");
    };

    try {
      await withDreamerConfig(true, async () => {
        await runDreamerBacklog();
      });
      expect(sawTranscript).toBe(true);
      expect(existsSync(pastFile)).toBe(false);
    } finally {
      provider.generateCompletion = original;
      await rm(pastFile, { force: true }).catch(() => {});
    }
  });

  test("does nothing when disabled", async () => {
    const pastDate = "2000-01-03";
    const pastFile = join(INTERACTIONS_DIR, `${pastDate}.jsonl`);
    await mkdir(INTERACTIONS_DIR, { recursive: true });
    await writeFile(pastFile, JSON.stringify({ ts: `${pastDate}T10:00:00.000Z`, session: "s", kind: "user", content: "x" }) + "\n", "utf-8");

    const original = provider.generateCompletion;
    let called = false;
    provider.generateCompletion = async () => { called = true; return textResult("x"); };
    try {
      await withDreamerConfig(false, async () => {
        await runDreamerBacklog();
      });
      expect(called).toBe(false);
      expect(existsSync(pastFile)).toBe(true);
    } finally {
      provider.generateCompletion = original;
      await rm(pastFile, { force: true }).catch(() => {});
    }
  });
});
