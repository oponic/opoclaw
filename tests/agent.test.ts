import { describe, expect, test } from "bun:test";
import { runAgent } from "../src/agent.ts";

function sseResponse(payload: string): Response {
  return new Response(payload, { status: 200 });
}

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
        {
          onFirstToken: () => {},
          onToolCall: () => {},
          onToolCallError: () => {}
      },
      );
      expect(result.text).toBe("Hello");
    } finally {
      globalThis.fetch = originalFetch as any;
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
          {
            onFirstToken: () => {},
            onToolCall: () => {},
            onToolCallError: () => {}
        },
        )
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });
});
