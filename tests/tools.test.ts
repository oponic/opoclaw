import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile, readFile, mkdtemp, writeFile as writeFileFs, rm as rmFs } from "fs/promises";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { handleToolCall, pendingFileSend, clearPendingFileSend } from "../src/tools.ts";
import { WORKSPACE_DIR } from "../src/workspace.ts";

const TEST_DIR = resolve(WORKSPACE_DIR, "__tools_test__");

async function setup() {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(resolve(TEST_DIR, "a.txt"), "alpha", "utf-8");
}

async function cleanup() {
  await rm(TEST_DIR, { recursive: true, force: true });
}

describe("tools", () => {
  test("read_file + edit_file", async () => {
    await setup();
    const rel = "__tools_test__/a.txt";
    const content = await handleToolCall("read_file", { path: rel }, {} as any);
    expect(content).toBe("alpha");
    await handleToolCall("edit_file", { path: rel, content: "beta" }, {} as any);
    const updated = await readFile(resolve(TEST_DIR, "a.txt"), "utf-8");
    expect(updated).toBe("beta");
    await cleanup();
  });

  test("list_files returns entries", async () => {
    await setup();
    const res = await handleToolCall("list_files", {}, {} as any);
    expect(res).toContain("__tools_test__/a.txt");
    await cleanup();
  });

  test("send_file queues", async () => {
    await setup();
    const rel = "__tools_test__/a.txt";
    const res = await handleToolCall("send_file", { path: rel }, {} as any);
    expect(res).toContain("queued");
    expect(pendingFileSend?.path).toBe(rel);
    clearPendingFileSend();
    await cleanup();
  });

  test("error paths for missing args", async () => {
    await expect(handleToolCall("read_file", {} as any, {} as any)).rejects.toThrow();
    await expect(handleToolCall("edit_file", { path: "x" } as any, {} as any)).rejects.toThrow();
    await expect(handleToolCall("search", {} as any, {} as any)).rejects.toThrow();
    await expect(handleToolCall("use_skill", {} as any, {} as any)).rejects.toThrow();
  });

  test("use_skill and list_skills", async () => {
    const skillsDir = resolve(WORKSPACE_DIR, "skills", "alpha");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(resolve(skillsDir, "SKILL.md"), "Alpha skill", "utf-8");
    const list = await handleToolCall("list_skills", {}, {} as any);
    expect(list).toContain("alpha");
    const skill = await handleToolCall("use_skill", { name: "alpha" }, {} as any);
    expect(skill).toContain("Alpha skill");
    await rm(resolve(WORKSPACE_DIR, "skills"), { recursive: true, force: true });
  });

  test("edit_config updates key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opoclaw-config-"));
    const cfgPath = join(dir, "config.toml");
    await writeFileFs(cfgPath, "enable_reasoning = false\n", "utf-8");
    process.env.OPOCLAW_CONFIG_PATH = cfgPath;
    try {
      const res = await handleToolCall("edit_config", { key: "enable_reasoning", value: "true" }, {} as any);
      expect(res).toContain("Updated config key");
      const updated = await readFile(cfgPath, "utf-8");
      expect(updated).toContain("enable_reasoning = true");
    } finally {
      delete process.env.OPOCLAW_CONFIG_PATH;
      await rmFs(dir, { recursive: true, force: true });
    }
  });

  test("search uses searx when available", async () => {
    process.env.OPOCLAW_SEARCH_NO_PYTHON = "1";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("searx") && url.includes("format=json")) {
        return new Response(
          JSON.stringify({ results: [{ title: "Example", url: "https://example.com", content: "Snippet" }] }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as any;

    try {
      const res = await handleToolCall("search", { query: "test", count: "3" } as any, {} as any);
      expect(res).toContain("Example");
      expect(res).toContain("https://example.com");
    } finally {
      globalThis.fetch = originalFetch as any;
      delete process.env.OPOCLAW_SEARCH_NO_PYTHON;
    }
  });

  test("search falls back to duckduckgo html", async () => {
    process.env.OPOCLAW_SEARCH_NO_PYTHON = "1";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("searx") && url.includes("format=json")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      if (url.includes("duckduckgo.com/?") && url.includes("format=json")) {
        return new Response(JSON.stringify({ RelatedTopics: [] }), { status: 200 });
      }
      if (url.includes("duckduckgo.com/html/")) {
        const html = `<a class=\"result__a\" href=\"https://ddg.example\">Title</a><a class=\"result__snippet\">Snippet</a>`;
        return new Response(html, { status: 200 });
      }
      return new Response("", { status: 200 });
    }) as any;

    try {
      const res = await handleToolCall("search", { query: "test", count: "1" } as any, {} as any);
      expect(res).toContain("https://ddg.example");
      expect(res).toContain("Title");
    } finally {
      globalThis.fetch = originalFetch as any;
      delete process.env.OPOCLAW_SEARCH_NO_PYTHON;
    }
  });
});
