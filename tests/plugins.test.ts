import { describe, expect, test, afterEach } from "bun:test";
import { loadPlugins, listLoadedPlugins, unloadPlugin } from "../src/plugins.ts";
import { handleToolCall, TOOLS, unregisterTool } from "../src/tools.ts";
import { getTools } from "../src/config.ts";
import path from "path";
import { writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";

const testPluginBase = path.resolve(process.cwd(), "workspace", "plugins");

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

describe("plugins", () => {
  afterEach(async () => {
    await cleanupPlugin("test-echo-plugin");
    await cleanupPlugin("test-tool-visible-plugin");
    await cleanupPlugin("test-unload-plugin");
    await cleanupPlugin("test-legacy-plugin");
    unregisterTool("test_echo");
    unregisterTool("test_tool_visible");
    unregisterTool("test_unload");
  });

  test("loads a plugin and executes its registered tool", async () => {
    await createPlugin("test-echo-plugin", "test_echo", `
  if (name === 'test_echo') {
    return 'echo:' + String(args.text || '');
  }
  throw new Error('unknown tool');`);

    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);
    const loaded = listLoadedPlugins();
    expect(loaded.includes("test-echo-plugin")).toBe(true);

    const out = await handleToolCall("test_echo", { text: "hello" }, cfg);
    expect(out).toBe("echo:hello");
  });

  test("plugin tool is present in model tools after registration", async () => {
    await createPlugin("test-tool-visible-plugin", "test_tool_visible", `
  if (name === 'test_tool_visible') return 'ok';
  throw new Error('unknown tool');`);

    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);

    expect(TOOLS.test_tool_visible).toBeDefined();
    const modelTools = getTools(cfg);
    expect(modelTools.some((t: any) => t?.function?.name === "test_tool_visible")).toBe(true);
  });

  test("legacy context plugin API is rejected", async () => {
    await createLegacyPlugin("test-legacy-plugin");
    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);

    expect(listLoadedPlugins().includes("test-legacy-plugin")).toBe(false);
    expect(TOOLS.legacy_echo).toBeUndefined();
  });

  test("plugin tool unregistered after unload", async () => {
    await createPlugin("test-unload-plugin", "test_unload", `
  if (name === 'test_unload') return 'ok';
  throw new Error('unknown tool');`);

    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);

    expect(TOOLS.test_unload).toBeDefined();

    await unloadPlugin("test-unload-plugin");

    expect(TOOLS.test_unload).toBeUndefined();
  });
});