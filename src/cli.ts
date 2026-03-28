#!/usr/bin/env bun
/**
 * opoclaw CLI — usage, gateway management, updates, uninstall
 */

import { resolve, join } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from "fs";
import { execSync, spawn } from "child_process";
import { homedir } from "os";

// ── Paths ──────────────────────────────────────────────────────────────────

const OP_DIR = resolve(import.meta.dir, "..");
import { loadConfig, getConfigPath, formatTOMLValue } from "./config.ts";
import { parseTOML, toTOML } from "./config.ts";

const USAGE_FILE = resolve(OP_DIR, "usage.json");
const WORKSPACE_DIR = resolve(OP_DIR, "workspace");
const BIN_DIR = `${homedir()}/.local/bin`;
const OPCLAW_BIN = `${BIN_DIR}/opoclaw`;
const OPCLAW_BIN_WIN = `${BIN_DIR}/opoclaw.cmd`;
const LOCK_FILE = resolve(OP_DIR, ".gateway.lock");
const HIBERNATE_FILE = resolve(OP_DIR, ".gateway.hibernate");

// macOS plist
const PLIST_NAME = "com.oponic.opoclaw.plist";
const PLIST_PATH_LA = `${homedir()}/Library/LaunchAgents/${PLIST_NAME}`;
// Linux systemd
const SYSTEMD_NAME = "opoclaw.service";
const SYSTEMD_PATH = `/etc/systemd/system/${SYSTEMD_NAME}`;

// ── Colors ─────────────────────────────────────────────────────────────────

const B = "\x1b[1m";
const C = "\x1b[36m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const R = "\x1b[31m";
const X = "\x1b[0m";

const info = (s: string) => console.log(`${C}[opoclaw]${X} ${s}`);
const ok = (s: string) => console.log(`${G}✓${X} ${s}`);
const warn = (s: string) => console.log(`${Y}⚠${X} ${s}`);
const err = (s: string) => console.error(`${R}✗${X} ${s}`);

// ── Helpers ────────────────────────────────────────────────────────────────

function getOS(): "macos" | "linux" | "windows" {
  const p = process.platform;
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  return "linux";
}



function exec(cmd: string, opts?: { cwd?: string }): string {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
}

// ── Usage ──────────────────────────────────────────────────────────────────

async function showUsage() {
  if (!existsSync(USAGE_FILE)) {
    info("No usage data yet.");
    return;
  }

  const data = JSON.parse(readFileSync(USAGE_FILE, "utf-8"));
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const recent = data.sessions.filter((s: any) => new Date(s.timestamp).getTime() > dayAgo);

  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  for (const s of recent) {
    input += s.input || 0;
    output += s.output || 0;
    cacheRead += s.cacheRead || 0;
    cacheWrite += s.cacheWrite || 0;
    cost += s.cost || 0;
  }

  console.log(`\n${B}═══ opoclaw usage (last 24h) ═══${X}\n`);

  console.log(`  Requests:    ${recent.length}`);
  console.log(`  Input:       ${(input / 1000).toFixed(1)}k tokens`);
  console.log(`  Output:      ${(output / 1000).toFixed(1)}k tokens`);
  console.log(`  Cache read:  ${(cacheRead / 1000).toFixed(1)}k tokens`);
  console.log(`  Cache write: ${(cacheWrite / 1000).toFixed(1)}k tokens`);
  console.log(`  Cost:        $${cost.toFixed(4)}`);

  console.log(`\n${B}─── all-time ───${X}\n`);
  console.log(`  Total cost:  $${data.total.cost.toFixed(4)}`);
  console.log(`  Total reqs:  ${data.sessions.length}`);
  console.log();
}

// ── Update Check ───────────────────────────────────────────────────────────

async function checkForUpdate(silent = false): Promise<string | null> {
  try {
    const currentTag = exec("git describe --tags --abbrev=0 2>/dev/null || echo ''", { cwd: OP_DIR });
    if (!currentTag) return null;

    // Fetch latest tags
    exec("git fetch --tags 2>/dev/null", { cwd: OP_DIR });
    const tagsRaw = exec("git tag --sort=-v:refname", { cwd: OP_DIR });
    const tags = tagsRaw.split("\n").map((t) => t.trim()).filter(Boolean);
    let channel: "stable" | "unstable" = "stable";
    try {
      channel = (loadConfig().update_channel as any) || "stable";
    } catch {}
    const latestTag = pickLatestTag(tags, channel, currentTag);

    if (latestTag && latestTag !== currentTag) {
      if (!silent) {
        console.log(`${Y}📦 Update available: ${currentTag} → ${latestTag}${X}`);
        console.log(`   Run ${B}opoclaw update${X} to upgrade.\n`);
      }
      return latestTag;
    }

    if (!silent) {
      ok("Up to date (latest: " + currentTag + ")");
    }
    return null;
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

function setUpdateChannel(channel: "stable" | "unstable") {
  const cfgPath = getConfigPath();
  if (!existsSync(cfgPath)) return;
  const raw = readFileSync(cfgPath, "utf-8");
  const parsed = parseTOML(raw);
  parsed.update_channel = channel;
  writeFileSync(cfgPath, toTOML(parsed));
}

async function notifyUpdateDiscord(newVersion: string) {
  try {
    const config = loadConfig();
    const currentTag = exec("git describe --tags --abbrev=0 2>/dev/null", { cwd: OP_DIR });

    const msg = `📦 **opoclaw update available:** \`${currentTag}\` → \`${newVersion}\`\nRun \`\`\`opoclaw update\`\`\` to upgrade.`;

    await fetch("https://discord.com/api/v10/channels/messages", {
      method: "POST",
      headers: {
        Authorization: `Bot ${config.channel?.discord?.token || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: msg }),
    });
  } catch {}
}

async function doUpdate(channelOverride?: "unstable") {
  if (channelOverride === "unstable") {
    setUpdateChannel("unstable");
  }

  info("Pulling latest changes...");
  exec("git fetch --tags", { cwd: OP_DIR });
  const currentTag = exec("git describe --tags --abbrev=0 2>/dev/null || echo ''", { cwd: OP_DIR });
  const tagsRaw = exec("git tag --sort=-v:refname", { cwd: OP_DIR });
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

  info("Restarting gateway...");
  await gatewayRestart();
  ok("Gateway restarted with update");
}

// ── Gateway Management ─────────────────────────────────────────────────────

function getGatewayPID(): number | null {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim());
    // Check if process is alive
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function setGatewayPID(pid: number) {
  writeFileSync(LOCK_FILE, String(pid));
}

function clearGatewayPID() {
  try { unlinkSync(LOCK_FILE); } catch {}
}

async function gatewayStart() {
  const pid = getGatewayPID();
  if (pid) {
    warn(`Gateway already running (PID ${pid})`);
    return;
  }

  // Check for updates silently
  const newVersion = await checkForUpdate(true);
  if (newVersion) {
    warn(`Update available: ${newVersion}`);
    await notifyUpdateDiscord(newVersion);
  }

  info("Starting gateway...");

  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: OP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.unref();
  setGatewayPID(child.pid!);

  // Pipe stdout/stderr with prefix
  child.stdout?.on("data", (d: Buffer) => {
    process.stdout.write(`${C}[gateway]${X} ${d}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`${C}[gateway]${X} ${d}`);
  });

  let childExited = false;
  let exitCode: number | null = null;
  child.on("exit", (code) => {
    childExited = true;
    exitCode = code;
    clearGatewayPID();
    if (code !== 0) {
      err(`Gateway exited with code ${code}`);
    }
  });

  // Brief delay to check startup
  setTimeout(() => {
    if (childExited) {
      // Child already exited, don't report success
      err(`Gateway failed to start (exit code ${exitCode})`);
    } else if (getGatewayPID()) {
      ok(`Gateway running (PID ${child.pid})`);
    }
  }, 2000);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isProcessAlive(pid);
}

async function gatewayStop() {
  const pid = getGatewayPID();
  if (!pid) {
    warn("Gateway not running");
    return;
  }

  info(`Stopping gateway (PID ${pid})...`);
  try {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }

    const stopped = await waitForExit(pid, 4000);
    if (!stopped) {
      warn("Gateway did not exit after SIGTERM, sending SIGKILL...");
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
      await waitForExit(pid, 2000);
    }

    if (isProcessAlive(pid)) {
      warn("Gateway process still alive after SIGKILL.");
    } else {
      ok("Gateway stopped");
    }
    clearGatewayPID();
  } catch (e: any) {
    err(`Failed to stop: ${e.message}`);
    clearGatewayPID();
  }
}

async function gatewayRestart() {
  await gatewayStop();
  await new Promise((r) => setTimeout(r, 500));
  await gatewayStart();
}

function gatewayStatus() {
  const pid = getGatewayPID();
  if (pid) {
    ok(`Gateway running (PID ${pid})`);
  } else {
    warn("Gateway not running");
  }
}

function gatewayHibernate() {
  try {
    writeFileSync(HIBERNATE_FILE, new Date().toISOString());
    ok("Gateway hibernation enabled");
  } catch (e: any) {
    err(`Failed to enable hibernation: ${e.message}`);
  }
}

// ── Service Installation ───────────────────────────────────────────────────

function installService() {
  const os = getOS();
  info(`Installing ${os} service...`);

  switch (os) {
    case "macos": {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.oponic.opoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${OPCLAW_BIN}</string>
        <string>gateway</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${OP_DIR}/logs/gateway.log</string>
    <key>StandardErrorPath</key>
    <string>${OP_DIR}/logs/gateway.log</string>
    <key>WorkingDirectory</key>
    <string>${OP_DIR}</string>
</dict>
</plist>`;
      mkdirSync(`${OP_DIR}/logs`, { recursive: true });
      writeFileSync(PLIST_PATH_LA, plist);
      exec(`launchctl load ${PLIST_PATH_LA}`);
      ok(`macOS service installed. Manage with:`);
      console.log(`  launchctl start/com.oponic.opoclaw`);
      console.log(`  launchctl stop/com.oponic.opoclaw`);
      break;
    }
    case "linux": {
      const unit = `[Unit]
Description=opoclaw AI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${exec("whoami")}
WorkingDirectory=${OP_DIR}
ExecStart=${OPCLAW_BIN} gateway start
Restart=on-failure
RestartSec=5
StandardOutput=append:${OP_DIR}/logs/gateway.log
StandardError=append:${OP_DIR}/logs/gateway.log

[Install]
WantedBy=multi-user.target`;
      mkdirSync(`${OP_DIR}/logs`, { recursive: true });
      writeFileSync(SYSTEMD_PATH, unit);
      exec("sudo systemctl daemon-reload");
      exec("sudo systemctl enable opoclaw.service");
      exec("sudo systemctl start opoclaw.service");
      ok("Linux systemd service installed and started");
      console.log(`  systemctl status opoclaw`);
      console.log(`  systemctl stop opoclaw`);
      break;
    }
    case "windows": {
      warn("Windows service: create manually with NSSM or sc.exe");
      console.log(`  nssm install opoclaw "${OPCLAW_BIN}" gateway start`);
      console.log(`  sc create opoclaw binPath="${OPCLAW_BIN} gateway start"`);
      break;
    }
  }
}

function uninstallService() {
  const os = getOS();
  info(`Removing ${os} service...`);

  switch (os) {
    case "macos": {
      try {
        exec(`launchctl unload ${PLIST_PATH_LA} 2>/dev/null || true`);
        unlinkSync(PLIST_PATH_LA);
        ok("macOS service removed");
      } catch { warn("No service found"); }
      break;
    }
    case "linux": {
      try {
        exec("sudo systemctl stop opoclaw.service 2>/dev/null || true");
        exec("sudo systemctl disable opoclaw.service 2>/dev/null || true");
        exec("sudo rm -f /etc/systemd/system/opoclaw.service");
        exec("sudo systemctl daemon-reload");
        ok("Linux service removed");
      } catch { warn("No service found"); }
      break;
    }
    case "windows": {
      try {
        exec("nssm remove opoclaw confirm 2>nul || true");
        exec("sc delete opoclaw 2>nul || true");
        ok("Windows service removed");
      } catch { warn("No service found"); }
      break;
    }
  }
}

function uninstall() {
  info("Uninstalling opoclaw...");
  gatewayStop();
  uninstallService();
  // Remove symlink
  try { unlinkSync(OPCLAW_BIN); } catch {}
  try { unlinkSync(OPCLAW_BIN_WIN); } catch {}
  ok("opoclaw uninstalled.");
  console.log(`\n  To remove all data, delete: ${OP_DIR}`);
  console.log(`  (config.toml, workspace, and usage data will be lost)\n`);
}

// ── Install Command (create symlink + service) ─────────────────────────────

function installCommand() {
  info("Installing opoclaw command...");
  mkdirSync(BIN_DIR, { recursive: true });

  if (getOS() === "windows") {
    const wrapper = `@echo off\r\nbun run \"${resolve(import.meta.dir, "cli.ts")}\" %*\r\n`;
    writeFileSync(OPCLAW_BIN_WIN, wrapper);
    ok(`opoclaw command installed to ${OPCLAW_BIN_WIN}`);
  } else {
    // Create wrapper script
    const wrapper = `#!/bin/bash\nbun run \"${resolve(import.meta.dir, "cli.ts")}\" \"$@\"\n`;
    writeFileSync(OPCLAW_BIN, wrapper);
    exec(`chmod +x ${OPCLAW_BIN}`);
    ok(`opoclaw command installed to ${OPCLAW_BIN}`);
  }

  // Check PATH
  const path = process.env.PATH || "";
  if (!path.includes(BIN_DIR)) {
    warn(`${BIN_DIR} is not in your PATH.`);
    if (getOS() === "windows") {
      console.log(`  Add ${BIN_DIR} to your PATH environment variable.`);
    } else {
      console.log(`  Add to .zshrc / .bashrc:`);
      console.log(`  export PATH="${BIN_DIR}:$PATH"`);
    }
  }

  // Install auto-start service
  const ans = process.argv[3];
  if (ans === "--service" || ans === "--daemon") {
    installService();
  }
}

// ── Migrate ─────────────────────────────────────────────────────────────────

function migrate() {
  const jsonPath = resolve(OP_DIR, "config.json");
  const tomlPath = resolve(OP_DIR, "config.toml");

  if (!existsSync(jsonPath)) {
    warn("No config.json found — nothing to migrate.");
    return;
  }

  if (existsSync(tomlPath)) {
    warn("config.toml already exists.");
    const backupPath = jsonPath + ".bak";
    writeFileSync(backupPath, readFileSync(jsonPath));
    ok("Backed up config.json → config.json.bak");
    return;
  }

  info("Reading config.json...");
  const jsonConfig = JSON.parse(readFileSync(jsonPath, "utf-8"));

  info("Converting to TOML...");
  let toml = "";
  for (const [key, value] of Object.entries(jsonConfig)) {
    toml += `${key} = ${formatTOMLValue(value)}\n`;
  }

  writeFileSync(tomlPath, toml);
  ok(`Wrote config.toml`);

  // Move old config
  const backupPath = jsonPath + ".bak";
  writeFileSync(backupPath, readFileSync(jsonPath));
  unlinkSync(jsonPath);
  ok("config.json backed up → config.json.bak and removed");

  console.log(`\n  Your config is now at: ${tomlPath}`);
  console.log(`  Old config backed up at: ${backupPath}\n`);
}

// ── CamelCase → snake_case migration ──────────────────────────────────────

const CAMEL_TO_SNAKE: Record<string, string> = {
  discordToken: "discord_token",
  openrouterKey: "openrouter_key",
  openrouterModel: "openrouter_model",
  allowBots: "allow_bots",
  enableReasoning: "enable_reasoning",
  reasoningSummary: "reasoning_summary",
  reasoningSummaryModel: "reasoning_summary_model",
  notifyChannel: "notify_channel",
};

function migrateToSnakeCase() {
  const tomlPath = resolve(OP_DIR, "config.toml");
  if (!existsSync(tomlPath)) {
    warn("No config.toml found — nothing to migrate.");
    return;
  }

  let text = readFileSync(tomlPath, "utf-8");
  let changed = false;

  for (const [camel, snake] of Object.entries(CAMEL_TO_SNAKE)) {
    const regex = new RegExp(`^\s*${camel}(\s*=)`, "gm");
    if (regex.test(text)) {
      text = text.replace(regex, `${snake}$1`);
      changed = true;
      info(`  ${camel} → ${snake}`);
    }
  }

  if (!changed) {
    ok("Config.toml already uses snake_case keys.");
    return;
  }

  const backupPath = tomlPath + ".bak";
  writeFileSync(backupPath, readFileSync(tomlPath));
  writeFileSync(tomlPath, text);
  ok("Migrated camelCase → snake_case. Backup at config.toml.bak");
}

function migrateToSectionedConfig() {
  const tomlPath = resolve(OP_DIR, "config.toml");
  if (!existsSync(tomlPath)) {
    warn("No config.toml found — nothing to migrate.");
    return;
  }

  const raw = readFileSync(tomlPath, "utf-8");
  const parsed = parseTOML(raw);

  const alreadySectioned =
    typeof parsed?.channel === "object" ||
    typeof parsed?.provider === "object";
  if (alreadySectioned) {
    ok("Config.toml already uses sectioned channel/provider layout.");
    return;
  }

  const next: any = { ...parsed };

  const discordToken = parsed.discord_token;
  const allowBots = parsed.allow_bots;
  const notifyChannel = parsed.notify_channel;

  const providerActive = parsed.provider || "openrouter";

  next.channel = next.channel || {};
  next.channel.discord = {
    enabled: true,
    token: discordToken,
    allow_bots: allowBots,
    notify_channel: notifyChannel,
  };

  next.provider = {
    active: providerActive,
    openrouter: {
      api_key: parsed.openrouter_key,
      model: parsed.openrouter_model,
    },
    ollama: parsed.ollama,
    custom: parsed.custom,
  };

  // Remove old flat keys
  delete next.discord_token;
  delete next.allow_bots;
  delete next.notify_channel;
  delete next.openrouter_key;
  delete next.openrouter_model;
  delete next.ollama;
  delete next.custom;

  const backupPath = tomlPath + ".sectioned.bak";
  writeFileSync(backupPath, raw);
  writeFileSync(tomlPath, toTOML(next));
  ok("Migrated to sectioned [channel.*] and [provider.*]. Backup at config.toml.sectioned.bak");
}

// ── CLI Router ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case "usage":
      await showUsage();
      break;

    case "gateway":
      const sub = args[1];
      switch (sub) {
        case "start":   await gatewayStart(); break;
        case "stop":    await gatewayStop(); break;
        case "restart": await gatewayRestart(); break;
        case "hibernate": gatewayHibernate(); break;
        case "status":  gatewayStatus(); break;
        default:
          console.log("Usage: opoclaw gateway {start|stop|restart|hibernate|status}");
      }
      break;

    case "update":
      await doUpdate(args[1] === "unstable" ? "unstable" : undefined);
      break;

    case "check-update":
      await checkForUpdate(false);
      break;

    case "install":
      installCommand();
      break;

    case "uninstall":
      uninstall();
      break;

    case "service":
      const svcCmd = args[1];
      if (svcCmd === "install") installService();
      else if (svcCmd === "remove") uninstallService();
      else console.log("Usage: opoclaw service {install|remove}");
      break;

    case "migrate":
      migrate();
      migrateToSnakeCase();
      migrateToSectionedConfig();
      break;

    case "onboard":
      exec("bun run installers/onboard.ts", { cwd: OP_DIR });
      break;

    case "version":
    case "v":
      try {
        const tag = exec("git describe --tags --abbrev=0 2>/dev/null", { cwd: OP_DIR });
        console.log(`opoclaw ${tag}`);
      } catch {
        console.log("opoclaw (unknown version — no git tags found)");
      }
      break;

    case "explainer":
    case "explain":
      console.log(`
${B}How opoclaw works${X}

opoclaw is a Discord bot framework. When someone mentions the bot:

1. ${B}Message received${X} — Discord event triggers the MessageCreate handler.
   Only messages that @mention the bot (or reply to it) are processed.
   Own messages are always ignored. Other bots are ignored unless
   channel.discord.allow_bots=true in config.toml.

2. ${B}System prompt loaded${X} — Three workspace files are read and composed:
   - SOUL.md — personality, tone, rules, vibe
   - IDENTITY.md — name, appearance, self-description
   - AGENTS.md — operating instructions, memory system, safety rules
   These form the system prompt sent to the LLM.

3. ${B}Channel history${X} — Last 50 messages in the channel are fetched,
   formatted as [name]: content, and sent as conversation context.

4. ${B}LLM call${X} — The composed prompt + history is sent to the configured
   provider (OpenRouter, Ollama, or custom endpoint). The model generates
   a response. If reasoning is enabled, the model's thinking tokens are
   captured during streaming.

5. ${B}Tools${X} — The model can request tool calls (file operations, etc.).
   Tools execute in a loop (max 20 iterations) until the model stops
   requesting them or sends a final text response.

6. ${B}Response sent${X} — The reply is sent back to Discord, split into
   chunks if over 1990 characters.

${B}Security profile${X}

- ${B}No data exfiltration${X} — workspace files (SOUL, IDENTITY, AGENTS,
  MEMORY) are sent to the LLM provider as part of the prompt. Do not
  put secrets in these files.
- ${B}Token safety${X} — Discord token and API keys live in config.toml,
  never sent to the LLM or exposed in responses.
- ${B}Tool sandboxing${X} — file tools only read from the workspace directory.
  The send_file tool reads workspace files and attaches them to messages.
- ${B}No system commands${X} — the bot cannot run shell commands or access
  your filesystem outside the workspace.
- ${B}Rate limiting${X} — max 20 agent iterations per message prevents
  runaway loops.

${B}Config${X}
config.toml lives at the project root. Onboard wizard: opoclaw onboard.
Channels live under [channel.*]. Providers live under [provider.*].
Toggle: channel.discord.allow_bots, enable_reasoning, reasoning_summary.
`);
      break;

    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(`
${B}opoclaw${X} — lightweight AI agent framework

${B}Commands:${X}
  usage              Show token usage (last 24h) and cost
  gateway start      Start the bot gateway
  gateway stop       Stop the gateway
  gateway restart    Restart the gateway
  gateway hibernate  Hibernate the gateway (requires approval to wake)
  gateway status     Check if gateway is running
  update [unstable]  Pull latest release and restart (use unstable channel)
  check-update       Check for available updates
  install            Install opoclaw command + optional service
  service install    Install auto-start service (systemd/launchd)
  service remove     Remove auto-start service
  uninstall          Remove command, service, and clean up
  explainer          How opoclaw works
  migrate            Upgrade config (JSON→TOML, camelCase→snake_case, sections)
  onboard            Run onboarding wizard
  version            Print current version (git tag)
  help               Show this help

${B}Config:${X}  ${getConfigPath()}
${B}Workspace:${X}  ${WORKSPACE_DIR}
${B}Usage:${X}  ${USAGE_FILE}
`);
      break;

    default:
      err(`Unknown command: ${cmd}`);
      console.log("Run `opoclaw help` for usage.");
      process.exit(1);
  }
}

main().catch((e) => {
  err(e.message || String(e));
  process.exit(1);
});
