import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { resolve } from "path";
import { runAgent, AgentSession } from "../src/agent.ts";
import { WORKSPACE_DIR } from "../src/workspace.ts";

function sseResponse(payload: string): Response {
  return new Response(payload, { status: 200 });
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
});
