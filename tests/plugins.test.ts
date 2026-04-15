import { describe, expect, test } from "bun:test";
import { loadPlugins, listLoadedPlugins } from "../src/plugins.ts";
import { handleToolCall } from "../src/tools.ts";
import path from "path";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

describe("plugins", () => {
  test("loads a plugin and executes its registered tool", async () => {
    const root = path.resolve(process.cwd(), "workspace", "plugins", "test-runner-plugin");
    if (!existsSync(root)) await mkdir(root, { recursive: true });

    const manifest = {
      name: "test-runner-plugin",
      version: "0.0.1",
      entry: "plugin.ts",
      permissions: { fileSystem: ["workspace"], tools: ["test_echo"] }
    };

    await writeFile(path.join(root, "plugin.json"), JSON.stringify(manifest, null, 2));

    const pluginTs = `export async function activate(context) {
  context.registerTool({ function: { name: 'test_echo', description: 'Echo test' } }, async (args) => {
    return 'echo:' + String(args.text || '');
  });
}
export async function deactivate() {}
`;
    await writeFile(path.join(root, "plugin.ts"), pluginTs);

    const cfg = { enable_plugins: true, plugin_dir: path.resolve(process.cwd(), "workspace", "plugins"), mounts: {} } as any;
    await loadPlugins(cfg);
    const loaded = listLoadedPlugins();
    expect(loaded.includes("test-runner-plugin")).toBe(true);

    const out = await handleToolCall("test_echo", { text: "hello" }, cfg);
    expect(out).toBe("echo:hello");
  });
});
