import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseTOML,
  toTOML,
  getActiveProvider,
  getApiBaseUrl,
  getApiKey,
  getModelId,
  loadConfig,
  getExposedCommands,
  getSemanticSearchEnabled,
  useTomlFiles,
} from "../src/config.ts";

async function withTempConfig(contents: string, fn: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "opoclaw-config-"));
  const path = join(dir, "config.toml");
  await writeFile(path, contents, "utf-8");
  process.env.OPOCLAW_CONFIG_PATH = path;
  try {
    await fn(path);
  } finally {
    delete process.env.OPOCLAW_CONFIG_PATH;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("config TOML", () => {
  test("parseTOML supports dotted sections", () => {
    const input = `enable_reasoning = true\n\n[channel.discord]\nenabled = true\nallow_bots = false\n\n[provider.openrouter]\napi_key = "sk-123"\nmodel = "openrouter/auto"\n`;
    const parsed = parseTOML(input);
    expect(parsed.enable_reasoning).toBe(true);
    expect(parsed.channel.discord.enabled).toBe(true);
    expect(parsed.channel.discord.allow_bots).toBe(false);
    expect(parsed.provider.openrouter.api_key).toBe("sk-123");
    expect(parsed.provider.openrouter.model).toBe("openrouter/auto");
  });

  test("toTOML emits dotted sections", () => {
    const obj = {
      enable_reasoning: true,
      channel: { discord: { enabled: true, allow_bots: false } },
      provider: { openrouter: { api_key: "sk-xyz", model: "openrouter/auto" } },
    };
    const toml = toTOML(obj as any);
    expect(toml).toContain("[channel.discord]");
    expect(toml).toContain("enabled = true");
    expect(toml).toContain("allow_bots = false");
    expect(toml).toContain("[provider.openrouter]");
    expect(toml).toContain("api_key = \"sk-xyz\"");
  });

  test("getActiveProvider defaults to openrouter", () => {
    expect(getActiveProvider({} as any)).toBe("openrouter");
  });

  test("loadConfig + provider helpers", async () => {
    const cfg = `\n[provider]\nactive = "custom"\n\n[provider.custom]\nbase_url = "http://localhost:1234"\napi_key = "k"\nmodel = "m"\n`;
    await withTempConfig(cfg, async () => {
      const loaded = loadConfig();
      expect(getApiBaseUrl(loaded)).toBe("http://localhost:1234");
      expect(getApiKey(loaded)).toBe("k");
      expect(getModelId(loaded)).toBe("m");
    });
  });

  test("getExposedCommands returns list", () => {
    expect(getExposedCommands({ exposed_commands: ["ls", "cat"] } as any)).toEqual(["ls", "cat"]);
  });

  test("parses durable platform configuration", () => {
    const parsed = parseTOML(`
[cron]
enabled = true
timezone = "America/New_York"
catch_up = false
max_jobs = 4
[jobs]
max_concurrent = 3
max_per_session = 1
[tools]
deno_enabled = true
deno_timeout_ms = 5000
[usage_alerts]
hard_limit = 10
session_limit = 2
job_limit = 1
[artifacts]
retention_days = 7
max_bytes = 1024
[activity]
enabled = true
token = "local-token"
`);
    expect(parsed.cron.timezone).toBe("America/New_York");
    expect(parsed.jobs.max_concurrent).toBe(3);
    expect(parsed.tools.deno_enabled).toBe(true);
    expect(parsed.usage_alerts.job_limit).toBe(1);
    expect(parsed.artifacts.max_bytes).toBe(1024);
    expect(parsed.activity.enabled).toBe(true);
  });

  test("feature toggles default to false", () => {
    expect(getSemanticSearchEnabled({} as any)).toBe(false);
    expect(useTomlFiles({} as any)).toBe(false);
  });
});
