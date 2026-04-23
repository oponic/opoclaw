import { resolve, relative, join } from "path";
import { WORKSPACE_DIR } from "./workspace.ts";
import { existsSync } from "fs";
import { readdir, stat, readFile } from "fs/promises";

const SKILLS_DIR = resolve(WORKSPACE_DIR, "skills");

// Plugin-provided skills (in-memory)
const PLUGIN_SKILLS: Map<string, { name: string; content: string; metadata?: any }> = new Map();

function isSafeSkillName(name: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(name);
}

function getSkillFilePath(name: string): string {
    if (!isSafeSkillName(name)) {
        throw new Error("Invalid skill name.");
    }
    const abs = resolve(join(SKILLS_DIR, name, "SKILL.md"));
    const rel = relative(SKILLS_DIR, abs);
    if (rel.startsWith("..") || rel.includes("/../")) {
        throw new Error("Invalid skill path.");
    }
    return abs;
}

export async function listSkills(): Promise<string[]> {
    if (!existsSync(SKILLS_DIR)) return [];
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    const skills: string[] = [];
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const name = e.name;
        if (!isSafeSkillName(name)) continue;
        const skillPath = getSkillFilePath(name);
        try {
            const s = await stat(skillPath);
            if (s.isFile()) skills.push(name);
        } catch {
        }
    }
    // Merge plugin skills
    for (const k of PLUGIN_SKILLS.keys()) {
        if (!skills.includes(k)) skills.push(k);
    }
    return skills.sort();
}

export async function readSkill(name: string): Promise<string> {
    // Plugin skill takes precedence
    const p = PLUGIN_SKILLS.get(name);
    if (p) return p.content;
    const path = getSkillFilePath(name);
    return await readFile(path, "utf-8");
}

export function registerSkill(meta: { name: string; content: string; metadata?: any }): void {
    if (!meta || !meta.name || !isSafeSkillName(meta.name)) {
        throw new Error("Invalid skill metadata");
    }
    PLUGIN_SKILLS.set(meta.name, { name: meta.name, content: meta.content || "", metadata: meta.metadata });
}

export function unregisterSkill(name: string): void {
    PLUGIN_SKILLS.delete(name);
}
