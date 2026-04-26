import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import kleur from "kleur";
import { loadConfig, getConfigPath, parseTOML, toTOML } from "./config.ts";
import { OP_DIR } from "./channels/shared.ts";

const dec = new TextDecoder();

const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
let lastUpdateCheck = 0;
let cachedUpdateTag: string | null = null;
let cachedUpdateChannel: "stable" | "unstable" | null = null;

const info = (s: string) => console.log(`${kleur.cyan("[opoclaw]")} ${s}`);
const ok = (s: string) => console.log(`${kleur.green("✓")} ${s}`);
const err = (s: string) => console.error(`${kleur.red("✗")} ${s}`);

export function exec(cmd: string, opts?: { cwd?: string }): string {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
}

function runGit(cmd: string): string | null {
    try {
        const p = Bun.spawnSync({
            cmd: ["bash", "-lc", cmd],
            cwd: OP_DIR,
            stdout: "pipe",
            stderr: "pipe",
        });
        if (p.exitCode !== 0) return null;
        return dec.decode(p.stdout).trim();
    } catch {
        return null;
    }
}

function isStableTag(tag: string): boolean {
    if (!tag) return false;
    if (tag.includes("-")) return false;
    return !/(alpha|beta|rc)/i.test(tag);
}

function baseVersion(tag: string): string {
    return tag.replace(/^v/i, "").split("-")[0] || tag;
}

function isPrereleaseTag(tag: string): boolean {
    return tag.includes("-") || /(alpha|beta|rc)/i.test(tag);
}

function pickLatestTag(tags: string[], channel: "stable" | "unstable", currentTag: string): string | null {
    const currentIndex = tags.indexOf(currentTag);
    const candidates = currentIndex >= 0 ? tags.slice(0, currentIndex) : tags;
    const currentIsStable = isStableTag(currentTag);
    const currentBase = baseVersion(currentTag);
    for (const tag of candidates) {
        if (currentIsStable && isPrereleaseTag(tag) && baseVersion(tag) === currentBase) {
            continue;
        }
        if (channel === "unstable") return tag;
        if (isStableTag(tag)) return tag;
    }
    return null;
}

export function getCurrentTag(): string | undefined {
    const currentTag = runGit("git describe --tags --abbrev=0 2>/dev/null || echo ''");
    if (!currentTag) {
        cachedUpdateTag = null;
        return undefined;
    }
    return currentTag
}

export async function getUpdateTag(): Promise<string | null> {
    const now = Date.now();
    const channel = (loadConfig().update_channel as any) || "stable";
    if (now - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS && cachedUpdateChannel === channel) {
        return cachedUpdateTag;
    }
    lastUpdateCheck = now;
    cachedUpdateChannel = channel;

    const currentTag = getCurrentTag();
    if(currentTag == undefined) { return null; }
    
    runGit("git fetch --tags 2>/dev/null || true");
    const tagsRaw = runGit("git tag --sort=-v:refname") || "";
    const tags = tagsRaw.split("\n").map((t) => t.trim()).filter(Boolean);
    const latestTag = pickLatestTag(tags, channel, currentTag);
    if (latestTag && latestTag !== currentTag) {
        cachedUpdateTag = latestTag;
        return latestTag;
    }
    cachedUpdateTag = null;
    return null;
}

export async function checkForUpdate(silent = false): Promise<string | null> {
    try {
        const currentTag = runGit("git describe --tags --abbrev=0 2>/dev/null || echo ''");
        if (!currentTag) return null;

        runGit("git fetch --tags 2>/dev/null || true");
        const tagsRaw = runGit("git tag --sort=-v:refname") || "";
        const tags = tagsRaw.split("\n").map((t) => t.trim()).filter(Boolean);
        let channel: "stable" | "unstable" = "stable";
        try {
            channel = (loadConfig().update_channel as any) || "stable";
        } catch {}
        const latestTag = pickLatestTag(tags, channel, currentTag);

        if (latestTag && latestTag !== currentTag) {
            if (!silent) {
                console.log(kleur.yellow(`📦 Update available: ${currentTag} → ${latestTag}`));
                console.log(`   Run ${kleur.bold("opoclaw update")} to upgrade.\n`);
            }
            return latestTag;
        }

        if (!silent) {
            ok(`Up to date (latest: ${currentTag})`);
        }
        return null;
    } catch {
        return null;
    }
}

function setUpdateChannel(channel: "stable" | "unstable") {
    const cfgPath = getConfigPath();
    if (!existsSync(cfgPath)) return;
    const raw = readFileSync(cfgPath, "utf-8");
    const parsed = parseTOML(raw);
    parsed.update_channel = channel;
    writeFileSync(cfgPath, toTOML(parsed));
}

export async function doUpdate(channelOverride?: "unstable", restart?: () => Promise<void>) {
    if (channelOverride === "unstable") {
        setUpdateChannel("unstable");
    }

    info("Pulling latest changes...");
    runGit("git fetch --tags 2>/dev/null || true");
    const currentTag = runGit("git describe --tags --abbrev=0 2>/dev/null || echo ''") || "";
    const tagsRaw = runGit("git tag --sort=-v:refname") || "";
    const tags = tagsRaw.split("\n").map((t) => t.trim()).filter(Boolean);
    let channel: "stable" | "unstable" = "stable";
    try {
        channel = (loadConfig().update_channel as any) || "stable";
    } catch {}
    const latestTag = pickLatestTag(tags, channel, currentTag);
    if (!latestTag) {
        err("No matching release tag found.");
        return;
    }
    exec(`git checkout ${latestTag}`, { cwd: OP_DIR });
    ok(`Updated to ${latestTag}`);

    info("Installing dependencies...");
    exec("bun install", { cwd: OP_DIR });
    ok("Dependencies updated");

    if (restart) {
        info("Restarting gateway...");
        await restart();
        ok("Gateway restarted with update");
    }
}
