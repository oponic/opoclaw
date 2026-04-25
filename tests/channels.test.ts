import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { handleCoreRequest } from "../src/channels/core.ts";
import { startDiscord } from "../src/channels/discord.ts";
import { startIRC } from "../src/channels/irc.ts";
import { handleOpenAIRequest, startOpenAI } from "../src/channels/openai.ts";
import { provider } from "../src/provider/index.ts";

async function withTempConfig(contents: string, fn: () => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "opoclaw-config-"));
  const path = join(dir, "config.toml");
  await writeFile(path, contents, "utf-8");
  process.env.OPOCLAW_CONFIG_PATH = path;
  try {
    await fn();
  } finally {
    delete process.env.OPOCLAW_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("channels", () => {
  test("startDiscord returns when disabled", async () => {
    const cfg = `\n[channel.discord]\nenabled = false\n`;
    await withTempConfig(cfg, async () => {
      await startDiscord();
      expect(true).toBe(true);
    });
  });

  test("startIRC returns when disabled", async () => {
    const cfg = `\n[channel.irc]\nenabled = false\n`;
    await withTempConfig(cfg, async () => {
      await startIRC();
      expect(true).toBe(true);
    });
  });

  test("startOpenAI returns when disabled", async () => {
    const cfg = `\n[channel.openai]\nenabled = false\n`;
    await withTempConfig(cfg, async () => {
      const server = await startOpenAI();
      expect(server).toBeNull();
    });
  });

  test("core health endpoint reports enabled channels", async () => {
    const cfg = `\n[channel.discord]\nenabled = false\n[channel.irc]\nenabled = false\n[channel.openai]\nenabled = true\n`;
    await withTempConfig(cfg, async () => {
      const res = await handleCoreRequest(new Request("http://127.0.0.1:6112/health"));
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.channels.openai).toBe(true);
      expect(data.channels.discord).toBe(false);
    });
  });

  test("core chat endpoint returns assistant response", async () => {
    const cfg = `\n[channel.discord]\nenabled = false\n[channel.irc]\nenabled = false\n[channel.openai]\nenabled = false\n\n[provider]\nactive = "openrouter"\n\n[provider.openrouter]\napi_key = "k"\nmodel = "m"\nbase_url = "http://localhost"\n`;
    const original = provider.generateCompletion;
    provider.generateCompletion = async () => ({ text: "Core says hi", toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, reasoning: "" });

    await withTempConfig(cfg, async () => {
      try {
        const res = await handleCoreRequest(new Request("http://127.0.0.1:6112/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: "t1", message: "hello" }),
        }));
        const data = await res.json() as any;
        expect(res.status).toBe(200);
        expect(data.ok).toBe(true);
        expect(data.text).toBe("Core says hi");
      } finally {
        provider.generateCompletion = original;
      }
    });
  });

  test("openai models endpoint requires configured auth", async () => {
    const cfg = `\n[channel.openai]\nenabled = true\napi_key = "secret"\n\n[provider]\nactive = "openrouter"\n\n[provider.openrouter]\napi_key = "k"\nmodel = "m"\nbase_url = "http://localhost"\n`;
    await withTempConfig(cfg, async () => {
      const unauthorized = await handleOpenAIRequest(new Request("http://127.0.0.1:6113/v1/models"));
      expect(unauthorized.status).toBe(401);

      const authorized = await handleOpenAIRequest(new Request("http://127.0.0.1:6113/v1/models", {
        headers: { Authorization: "Bearer secret" },
      }));
      const data = await authorized.json() as any;
      expect(authorized.status).toBe(200);
      expect(data.data.some((m: any) => m.id === "opoclaw")).toBe(true);
    });
  });

  test("openai chat completions returns assistant text", async () => {
    const cfg = `\n[channel.openai]\nenabled = true\n\n[provider]\nactive = "openrouter"\n\n[provider.openrouter]\napi_key = "k"\nmodel = "m"\nbase_url = "http://localhost"\n`;
    const original = provider.generateCompletion;
    provider.generateCompletion = async () => ({ text: "Hello from API", toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, reasoning: "" });

    await withTempConfig(cfg, async () => {
      try {
        const res = await handleOpenAIRequest(new Request("http://127.0.0.1:6113/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "opoclaw",
            messages: [{ role: "user", content: "hi" }],
          }),
        }));
        const data = await res.json() as any;
        expect(res.status).toBe(200);
        expect(data.choices[0].message.content).toBe("Hello from API");
      } finally {
        provider.generateCompletion = original;
      }
    });
  });
});
