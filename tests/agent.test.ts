import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { resolve } from "path";
import { runAgent, AgentSession } from "../src/agent.ts";
import { WORKSPACE_DIR } from "../src/workspace.ts";

function sseResponse(payload: string): Response {
  return new Response(payload, { status: 200 });
}

function toolCallResponse(name: string, args: Record<string, any>, id = "tc1"): Response {
  const toolChunk = JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  return new Response(`data: ${toolChunk}\n\ndata: [DONE]\n\n`, { status: 200 });
}

function textResponse(text: string): Response {
  const textChunk = JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  return new Response(`data: ${textChunk}\n\ndata: [DONE]\n\n`, { status: 200 });
}

const dummyCallbacks = { onFirstToken: () => {}, onToolCall: () => {}, onToolCallError: () => {} };

describe("agent", () => {
  test("runAgent returns assistant text", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n` +
        "data: [DONE]\n\n";
      return sseResponse(payload);
    }) as any;

    try {
      const result = await runAgent(
        [{ role: "user", content: "hi" }],
        "system",
        {
          provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } },
        } as any,
        dummyCallbacks,
      );
      expect(result.text).toBe("Hello");
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });

  test("AgentSession.pendingFileSend is set when model calls send_file", async () => {
    const testDir = resolve(WORKSPACE_DIR, "__agent_test__");
    await rm(testDir, { recursive: true, force: true });
    await mkdir(testDir, { recursive: true });
    await writeFile(resolve(testDir, "out.txt"), "data", "utf-8");

    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        // First iteration: model calls send_file
        const toolChunk = JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: "tc1", function: { name: "send_file", arguments: JSON.stringify({ path: "__agent_test__/out.txt", caption: "here" }) } }],
            },
            finish_reason: "tool_calls",
          }],
        });
        return new Response(`data: ${toolChunk}\n\ndata: [DONE]\n\n`, { status: 200 });
      }
      // Second iteration: model produces final text
      const textChunk = JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] });
      return new Response(`data: ${textChunk}\n\ndata: [DONE]\n\n`, { status: 200 });
    }) as any;

    try {
      const session = new AgentSession();
      session.addMessage({ role: "user", content: "send me that file" });
      await session.evaluate("system", {
        provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } },
      } as any, dummyCallbacks);

      expect(session.pendingFileSend?.path).toBe("__agent_test__/out.txt");
      expect(session.pendingFileSend?.caption).toBe("here");
    } finally {
      globalThis.fetch = originalFetch as any;
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("runAgent throws on API error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("bad", { status: 500 })) as any;
    try {
      await expect(
        runAgent(
          [{ role: "user", content: "hi" }],
          "system",
          { provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } } } as any,
          dummyCallbacks,
        )
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });

  test("run_subagent tool returns delegated output", async () => {
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return toolCallResponse("run_subagent", { request: "delegate this", include_context: false });
      }
      if (call === 2) {
        return textResponse("delegated result");
      }
      return textResponse("main final");
    }) as any;

    try {
      const session = new AgentSession();
      session.addMessage({ role: "user", content: "do delegation" });
      const result = await session.evaluate("system", {
        provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } },
      } as any, dummyCallbacks);
      expect(result.text).toBe("main final");
      const toolMsg = session.messages.find((m: any) => m.role === "tool" && m.name === "run_subagent");
      expect(String(toolMsg?.content || "")).toContain("delegated result");
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });

  test("compact tool replaces older context with summary", async () => {
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return toolCallResponse("compact", { preserve_recent_messages: 4 });
      }
      if (call === 2) {
        return textResponse("compacted summary paragraph one.\n\nparagraph two.");
      }
      return textResponse("after compact");
    }) as any;

    try {
      const session = new AgentSession();
      for (let i = 0; i < 10; i++) {
        session.addMessage({ role: i % 2 === 0 ? "user" : "assistant", content: `message-${i}` });
      }
      await session.evaluate("system", {
        provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } },
      } as any, dummyCallbacks);
      expect(String(session.messages[0]?.content || "")).toContain("Conversation context summary");
      expect(session.messages.length).toBeLessThanOrEqual(6+1);
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });

  test("run_background_subagent injects completion into context", async () => {
    const originalFetch = globalThis.fetch;
    let call = 0;
    let injectedSeen = false;
    globalThis.fetch = (async (_input: any, init?: any) => {
      call++;
      if (call === 1) {
        return toolCallResponse("run_background_subagent", { request: "background work", include_context: false, label: "bgtest" });
      }
      if (call === 2) {
        return textResponse("background result payload");
      }
      if (call === 3) {
        const body = JSON.parse(String(init?.body || "{}"));
        const messages = body.messages || [];
        injectedSeen = JSON.stringify(messages).includes("Background subagent completed");
        return textResponse("main continues");
      }
      return textResponse("next turn response");
    }) as any;

    try {
      const session = new AgentSession();
      session.addMessage({ role: "user", content: "start background task" });
      await session.evaluate("system", {
        provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } },
      } as any, dummyCallbacks);
      expect(injectedSeen).toBe(true);
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });

  test("timer tool injects completion into context after delay", async () => {
    const originalFetch = globalThis.fetch;
    let call = 0;
    let injectedSeen = false;
    globalThis.fetch = (async (_input: any, init?: any) => {
      call++;
      if (call === 1) {
        return toolCallResponse("timer", { seconds: 0.1, label: "test-timer" });
      }
      
      const body = JSON.parse(String(init?.body || "{}"));
      const messages = body.messages || [];
      if (JSON.stringify(messages).includes("Background subagent completed (test-timer)")) {
        injectedSeen = true;
      }
      return textResponse("acknowledged");
    }) as any;

    try {
      const session = new AgentSession();
      session.addMessage({ role: "user", content: "set a timer for 0.1 seconds" });
      
      // First evaluation triggers the timer
      await session.evaluate("system", {
        provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } },
      } as any, dummyCallbacks);

      // Wait for timer to expire
      await new Promise(resolve => setTimeout(resolve, 300));

      // Second evaluation should see the injected message
      await session.evaluate("system", {
        provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } },
      } as any, dummyCallbacks);

      expect(injectedSeen).toBe(true);
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });

  test("session_status tool returns session info", async () => {
    const originalFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) return toolCallResponse("session_status", {});
      return textResponse("The status has been retrieved.");
    }) as any;

    try {
      const session = new AgentSession("opoclaw-core-test");
      session.addMessage({ role: "user", content: "what is the status?" });
      const result = await session.evaluate("system", {
        provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } },
      } as any, dummyCallbacks);
      
      const lastMessage = session.messages[session.messages.length - 2];
      expect(lastMessage!.role).toBe("tool");
      expect(lastMessage!.content).toContain("Session Status:");
      expect(lastMessage!.content).toContain("Model: m (openrouter)");
      expect(lastMessage!.content).toContain("Channel: core/terminal");
      expect(lastMessage!.content).toContain("Context Usage:");
      expect(lastMessage!.content).toContain("Spending (last 24h):");
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });
});
