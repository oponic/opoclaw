import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { resolve } from "path";
import { WORKSPACE_DIR, readFile, editFile, listFiles } from "../src/workspace.ts";

const TEST_DIR = resolve(WORKSPACE_DIR, "__test__");

async function setup() {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(resolve(TEST_DIR, "a.txt"), "alpha", "utf-8");
}

async function cleanup() {
  await rm(TEST_DIR, { recursive: true, force: true });
}

describe("workspace", () => {
  test("readFile and editFile", async () => {
    await setup();
    const rel = "__test__/a.txt";
    expect(await readFile(rel)).toBe("alpha");
    await editFile(rel, "beta");
    expect(await readFile(rel)).toBe("beta");
    await cleanup();
  });

  test("listFiles includes files", async () => {
    await setup();
    const files = await listFiles();
    // Normalize path separators to forward slashes for comparison
    const normalizedFiles = files.map(f => f.replace(/\\/g, '/'));
    expect(normalizedFiles).toContain("__test__/a.txt");
    await cleanup();
  });

  test("readFile throws on missing file", async () => {
    await cleanup();
    expect(() => readFile("__test__/missing.txt")).toThrow();
  });
});
