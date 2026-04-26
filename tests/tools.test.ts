import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile, readFile, mkdtemp, writeFile as writeFileFs, rm as rmFs } from "fs/promises";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { handleToolCall, type ToolContext } from "../src/tools/index.ts";
import { AgentSession } from "../src/agent.ts";
import { WORKSPACE_DIR } from "../src/workspace.ts";

const DUMMY_TOOL_CONTEXT: ToolContext = { config: {} as any, session: new AgentSession("test-session") };

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
    const content = await handleToolCall("read_file", { path: rel }, DUMMY_TOOL_CONTEXT);
    expect(content).toBe("alpha");
    await handleToolCall("edit_file", { path: rel, content: "beta" }, DUMMY_TOOL_CONTEXT);
    const updated = await readFile(resolve(TEST_DIR, "a.txt"), "utf-8");
    expect(updated).toBe("beta");
    await cleanup();
  });

  test("list_files returns entries", async () => {
    await setup();
    const res = await handleToolCall("list_files", {}, DUMMY_TOOL_CONTEXT);
    // Normalize path separators to forward slashes for comparison
    const normalizedRes = res.replace(/\\/g, '/');
    expect(normalizedRes).toContain("__tools_test__/a.txt");
    await cleanup();
  });

  test("send_file queues", async () => {
    await setup();
    const rel = "__tools_test__/a.txt";
    const session = new AgentSession("test-session");
    const res = await handleToolCall("send_file", { path: rel }, { config: {} as any, session });
    expect(res).toContain("queued");
    expect(session.pendingFileSend?.path).toBe(rel);
    await cleanup();
  });

  test("send_file without setter callback does not throw", async () => {
    await setup();
    const rel = "__tools_test__/a.txt";
    // Simulates the runDeepResearch call site which passes no setter
    await expect(handleToolCall("send_file", { path: rel }, DUMMY_TOOL_CONTEXT)).resolves.toContain("queued");
    await cleanup();
  });

  test("error paths for missing args", async () => {
    await expect(handleToolCall("read_file", {} as any, DUMMY_TOOL_CONTEXT)).rejects.toThrow();
    await expect(handleToolCall("edit_file", { path: "x" } as any, DUMMY_TOOL_CONTEXT)).rejects.toThrow();
    await expect(handleToolCall("search", {} as any, DUMMY_TOOL_CONTEXT)).rejects.toThrow();
    await expect(handleToolCall("use_skill", {} as any, DUMMY_TOOL_CONTEXT)).rejects.toThrow();
  });

  test("use_skill and list_skills", async () => {
    const skillsDir = resolve(WORKSPACE_DIR, "skills", "alpha");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(resolve(skillsDir, "SKILL.md"), "Alpha skill", "utf-8");
    const list = await handleToolCall("list_skills", {}, DUMMY_TOOL_CONTEXT);
    expect(list).toContain("alpha");
    const skill = await handleToolCall("use_skill", { name: "alpha" }, DUMMY_TOOL_CONTEXT);
    expect(skill).toContain("Alpha skill");
    await rm(resolve(WORKSPACE_DIR, "skills"), { recursive: true, force: true });
  });

  test("edit_config updates key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opoclaw-config-"));
    const cfgPath = join(dir, "config.toml");
    await writeFileFs(cfgPath, "enable_reasoning = false\n", "utf-8");
    process.env.OPOCLAW_CONFIG_PATH = cfgPath;
    try {
      const res = await handleToolCall("edit_config", { key: "enable_reasoning", value: "true" }, DUMMY_TOOL_CONTEXT);
      expect(res).toContain("Updated config key");
      const updated = await readFile(cfgPath, "utf-8");
      expect(updated).toContain("enable_reasoning = true");
    } finally {
      delete process.env.OPOCLAW_CONFIG_PATH;
      await rmFs(dir, { recursive: true, force: true });
    }
  });

  test("search uses duckduckgo html parser", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("duckduckgo.com/html/")) {
        const html = `<a class=\"result__a\" href=\"https://ddg.example\">Title</a><a class=\"result__snippet\">Snippet</a>`;
        return new Response(html, { status: 200 });
      }
      return new Response("", { status: 200 });
    }) as any;

    try {
      const res = await handleToolCall("search", { query: "test", count: "1" } as any, DUMMY_TOOL_CONTEXT);
      expect(res).toContain("https://ddg.example");
      expect(res).toContain("Title");
    } finally {
      globalThis.fetch = originalFetch as any;
    }
  });
});
