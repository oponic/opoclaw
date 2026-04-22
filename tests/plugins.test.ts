import { describe, expect, test, afterEach } from "bun:test";
import { loadPlugins, listLoadedPlugins, unloadPlugin } from "../src/plugins.ts";
import { handleToolCall, TOOLS, unregisterTool } from "../src/tools.ts";
import { getTools } from "../src/config.ts";
import path from "path";
import { writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";

const testPluginBase = path.resolve(process.cwd(), "workspace", "plugins");

const TOOL_TEST_ECHO = "test_echo";
const TOOL_TEST_VISIBLE = "test_tool_visible";
const TOOL_TEST_UNLOAD = "test_unload";

async function cleanupPlugin(name: string) {
  await unloadPlugin(name).catch(() => {});
  const pluginDir = path.join(testPluginBase, name);
  if (existsSync(pluginDir)) {
    await rm(pluginDir, { recursive: true, force: true });
  }
}

async function createPlugin(name: string, toolName: string, invokeBody: string) {
  const pluginDir = path.join(testPluginBase, name);
  if (!existsSync(pluginDir)) await mkdir(pluginDir, { recursive: true });

  const manifest = {
    name,
    version: "0.0.1",
    entry: "plugin.ts",
  };

  await writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2));

  const pluginTs = `export const tools = [{
  type: 'function',
  function: {
    name: '${toolName}',
    description: 'Plugin test tool ${toolName}.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Input text.' }
      },
      required: []
    }
  }
}];

export async function invoke(name, args) {
  ${invokeBody}
}

export async function deactivate() {}`;
  await writeFile(path.join(pluginDir, "plugin.ts"), pluginTs);

  return pluginDir;
}

async function createLegacyPlugin(name: string) {
  const pluginDir = path.join(testPluginBase, name);
  if (!existsSync(pluginDir)) await mkdir(pluginDir, { recursive: true });

  const manifest = {
    name,
    version: "0.0.1",
    entry: "plugin.ts",
    permissions: { tools: ["legacy_echo"] }
  };

  await writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(pluginDir, "plugin.ts"), `
export async function activate(context) {
  context.registerTool({
    type: 'function',
    function: {
      name: 'legacy_echo',
      description: 'legacy',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }, async () => 'legacy');
}
`);
}

async function createTraversalPlugin(name: string) {
  const pluginDir = path.join(testPluginBase, name);
  if (!existsSync(pluginDir)) await mkdir(pluginDir, { recursive: true });

  const manifest = {
    name,
    version: "0.0.1",
    entry: "../outside.ts",
  };

  await writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(pluginDir, "plugin.ts"), "export const tools = []; export async function invoke() { return ''; }");
}

describe("plugins", () => {
  afterEach(async () => {
    await cleanupPlugin("test-echo-plugin");
    await cleanupPlugin("test-tool-visible-plugin");
    await cleanupPlugin("test-unload-plugin");
    await cleanupPlugin("test-legacy-plugin");
    await cleanupPlugin("test-traversal-plugin");
    unregisterTool(TOOL_TEST_ECHO);
    unregisterTool(TOOL_TEST_VISIBLE);
    unregisterTool(TOOL_TEST_UNLOAD);
  });

  test("loads a plugin and executes its registered tool", async () => {
    await createPlugin("test-echo-plugin", TOOL_TEST_ECHO, `
  if (name === '${TOOL_TEST_ECHO}') {
    return 'echo:' + String(args.text || '');
  }
  throw new Error('unknown tool');`);

    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);
    const loaded = listLoadedPlugins();
    expect(loaded.includes("test-echo-plugin")).toBe(true);

    const out = await handleToolCall(TOOL_TEST_ECHO, { text: "hello" }, cfg);
    expect(out).toBe("echo:hello");
  });

  test("plugin tool is present in model tools after registration", async () => {
    await createPlugin("test-tool-visible-plugin", TOOL_TEST_VISIBLE, `
  if (name === '${TOOL_TEST_VISIBLE}') return 'ok';
  throw new Error('unknown tool');`);

    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);

    expect(TOOLS[TOOL_TEST_VISIBLE]).toBeDefined();
    const modelTools = getTools(cfg);
    expect(modelTools.some((t: any) => t?.function?.name === TOOL_TEST_VISIBLE)).toBe(true);
  });

  test("legacy context plugin API is rejected", async () => {
    await createLegacyPlugin("test-legacy-plugin");
    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);

    expect(listLoadedPlugins().includes("test-legacy-plugin")).toBe(false);
    expect(TOOLS.legacy_echo).toBeUndefined();
  });

  test("entry path traversal is rejected", async () => {
    await createTraversalPlugin("test-traversal-plugin");
    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);

    expect(listLoadedPlugins().includes("test-traversal-plugin")).toBe(false);
  });

  test("plugin tool unregistered after unload", async () => {
    await createPlugin("test-unload-plugin", TOOL_TEST_UNLOAD, `
  if (name === '${TOOL_TEST_UNLOAD}') return 'ok';
  throw new Error('unknown tool');`);

    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);

    expect(TOOLS[TOOL_TEST_UNLOAD]).toBeDefined();

    await unloadPlugin("test-unload-plugin");

    expect(TOOLS[TOOL_TEST_UNLOAD]).toBeUndefined();
  });
});