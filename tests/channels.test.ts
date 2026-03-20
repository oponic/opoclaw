import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { startDiscord } from "../src/channels/discord.ts";
import { startIRC } from "../src/channels/irc.ts";

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
});
