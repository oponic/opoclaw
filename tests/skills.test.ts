import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { resolve } from "path";
import { listSkills, readSkill } from "../src/skills.ts";
import { WORKSPACE_DIR } from "../src/workspace.ts";

const SKILLS_DIR = resolve(WORKSPACE_DIR, "skills");

async function setupSkill(name: string, content: string) {
  const dir = resolve(SKILLS_DIR, name);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "SKILL.md"), content, "utf-8");
}

async function cleanupSkills() {
  await rm(SKILLS_DIR, { recursive: true, force: true });
}

describe("skills", () => {
  test("listSkills returns skill folders with SKILL.md", async () => {
    await cleanupSkills();
    await setupSkill("alpha", "Alpha skill");
    await setupSkill("beta", "Beta skill");

    const skills = await listSkills();
    expect(skills).toContain("alpha");
    expect(skills).toContain("beta");

    await cleanupSkills();
  });

  test("readSkill loads content", async () => {
    await cleanupSkills();
    await setupSkill("gamma", "Gamma skill content");

    const content = await readSkill("gamma");
    expect(content).toContain("Gamma skill content");

    await cleanupSkills();
  });

  test("readSkill rejects invalid name", async () => {
    await expect(readSkill("../bad" as any)).rejects.toThrow();
  });
});
