#!/usr/bin/env bun
/**
 * opoclaw CLI — usage, gateway management, updates, uninstall
 */

import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { homedir } from "os";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import kleur from "kleur";
import type { ToolCall } from "./agent.ts";
import { runCoreChatTurn } from "./channels/core.ts";

// ── Paths ──────────────────────────────────────────────────────────────────

const OP_DIR = resolve(import.meta.dir, "..");
import { loadConfig, getConfigPath, formatTOMLValue, parseTOML, toTOML } from "./config.ts";
import { exec, checkForUpdate, doUpdate } from "./utils.ts";

const USAGE_FILE = resolve(OP_DIR, "usage.json");
const WORKSPACE_DIR = resolve(OP_DIR, "workspace");
const BIN_DIR = `${homedir()}/.local/bin`;
const OPCLAW_BIN = `${BIN_DIR}/opoclaw`;
const OPCLAW_BIN_WIN = `${BIN_DIR}/opoclaw.cmd`;
const LOCK_FILE = resolve(OP_DIR, ".gateway.lock");
const HIBERNATE_FILE = resolve(OP_DIR, ".gateway.hibernate");
const CORE_URL = "http://127.0.0.1:6112";

// macOS plist
const PLIST_NAME = "com.oponic.opoclaw.plist";
const PLIST_PATH_LA = `${homedir()}/Library/LaunchAgents/${PLIST_NAME}`;
// Linux systemd
const SYSTEMD_NAME = "opoclaw.service";
const SYSTEMD_PATH = `/etc/systemd/system/${SYSTEMD_NAME}`;

// ── Colors ─────────────────────────────────────────────────────────────────

const info = (s: string) => console.log(`${kleur.bgBlue().white().bold(" INFO ")} ${s}`);
const ok = (s: string) => console.log(`${kleur.bgGreen().black().bold(" OK ")} ${s}`);
const warn = (s: string) => console.log(`${kleur.bgYellow().black().bold(" WARN ")} ${s}`);
const err = (s: string) => console.error(`${kleur.bgRed().white().bold(" ERROR ")} ${s}`);
const label = (s: string) => kleur.cyan().bold(s);
const value = (s: string) => kleur.white(s);
const cmdStyle = (s: string) => kleur.magenta().bold(s);
const subtle = (s: string) => kleur.dim(s);
type ChipTone = "magenta" | "blue" | "green" | "yellow" | "red" | "cyan";
const chip = (s: string, tone: ChipTone = "magenta") => {
  const text = ` ${s} `;
  switch (tone) {
    case "blue": return kleur.bgBlue().white().bold(text);
    case "green": return kleur.bgGreen().black().bold(text);
    case "yellow": return kleur.bgYellow().black().bold(text);
    case "red": return kleur.bgRed().white().bold(text);
    case "cyan": return kleur.bgCyan().black().bold(text);
    default: return kleur.bgMagenta().white().bold(text);
  }
};
const okChip = (s: string) => kleur.bgGreen().black().bold(` ${s} `);
const errChip = (s: string) => kleur.bgRed().white().bold(` ${s} `);
const toolChip = (s: string) => kleur.bgBlue().white().bold(` ${s} `);
const banner = () => (
  kleur.magenta("▄▄███▀") + kleur.bold("                    ▀█              \n") +
  kleur.magenta("▀▀▄▄▄█▄") + kleur.dim().bold("  ▄▀▀▄ ▄▀▀▄ ▄▀▀▄ ") + kleur.bold("▄▀▀▀ █  ▀▀▀▄ █ █ █ \n") +
  kleur.magenta("  █████") + kleur.dim().bold("  ▀▄▄▀ █▄▄▀ ▀▄▄▀ ") + kleur.bold("▀▄▄▄ █▄ ████ ▀▄▀▄▀\n") +
  kleur.magenta("   ▀▀▀ ") + kleur.dim().bold("       █")
);

// ── Helpers ────────────────────────────────────────────────────────────────

function getOS(): "macos" | "linux" | "windows" {
  const p = process.platform;
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  return "linux";
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

  console.log(`\n${chip("USAGE 24H", "blue")}\n`);
  console.log(`  ${label("Requests:")}    ${value(String(recent.length))}`);
  console.log(`  ${label("Input:")}       ${value(`${(input / 1000).toFixed(1)}k tokens`)}`);
  console.log(`  ${label("Output:")}      ${value(`${(output / 1000).toFixed(1)}k tokens`)}`);
  console.log(`  ${label("Cache read:")}  ${value(`${(cacheRead / 1000).toFixed(1)}k tokens`)}`);
  console.log(`  ${label("Cache write:")} ${value(`${(cacheWrite / 1000).toFixed(1)}k tokens`)}`);
  console.log(`  ${label("Cost:")}        ${kleur.green().bold(`$${cost.toFixed(4)}`)}`);

  console.log(`\n${chip("ALL-TIME", "cyan")}\n`);
  console.log(`  ${label("Total cost:")}  ${kleur.green().bold(`$${data.total.cost.toFixed(4)}`)}`);
  console.log(`  ${label("Total reqs:")}  ${value(String(data.sessions.length))}`);
  console.log();
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

async function requestCore(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`${CORE_URL}${path}`, init);
  } catch {
    return null;
  }
}

async function getCoreStatus(): Promise<any | null> {
  const res = await requestCore("/health");
  if (!res?.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function gatewayStart() {
  const core = await getCoreStatus();
  if (core?.ok) {
    warn(`Gateway already running (PID ${core.pid})`);
    return;
  }

  const pid = getGatewayPID();
  if (pid) {
    warn(`Gateway already running (PID ${pid})`);
    return;
  }

  // Check for updates silently
  const newVersion = await checkForUpdate(true);
  if (newVersion) {
    warn(`Update available: ${newVersion}`);
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
    process.stdout.write(`${kleur.cyan("[gateway]")} ${d}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`${kleur.cyan("[gateway]")} ${d}`);
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
  const coreRes = await requestCore("/control/stop", { method: "POST" });
  if (coreRes?.ok) {
    const pid = getGatewayPID();
    if (pid) {
      await waitForExit(pid, 4000);
    }
    clearGatewayPID();
    ok("Gateway stopped");
    return;
  }

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

async function gatewayStatus() {
  const core = await getCoreStatus();
  if (core?.ok) {
    ok(`Gateway running (PID ${core.pid})`);
    if (core.hibernating) {
      warn("Gateway is hibernating");
    }
    return;
  }

  const pid = getGatewayPID();
  if (pid) {
    ok(`Gateway running (PID ${pid})`);
    return;
  }
  warn("Gateway not running");
}

async function gatewayHibernate() {
  const coreRes = await requestCore("/control/hibernate", { method: "POST" });
  if (coreRes?.ok) {
    ok("Gateway hibernation enabled");
    return;
  }

  try {
    writeFileSync(HIBERNATE_FILE, new Date().toISOString());
    ok("Gateway hibernation enabled");
  } catch (e: any) {
    err(`Failed to enable hibernation: ${e.message}`);
  }
}

async function chatTui() {
  const divider = () => console.log(subtle("─".repeat(72)));
  const section = (title: string, tone: ChipTone = "magenta") => console.log(`${chip(title, tone)} ${subtle("─".repeat(48))}`);

  console.log(banner());
  section("CHAT", "magenta");
  console.log(subtle(`Type ${cmdStyle("/exit")} to quit.\n`));

  const rl = createInterface({ input, output });
  const sessionKey = `cli-${Date.now().toString(36)}`;
  let turn = 0;

  const askYesNo = async (prompt: string, defaultNo = true): Promise<boolean> => {
    const suffix = defaultNo ? " [y/N]: " : " [Y/n]: ";
    const answer = (await rl.question(prompt + suffix)).trim().toLowerCase();
    if (!answer) return !defaultNo;
    return answer === "y" || answer === "yes";
  };

  try {
    while (true) {
      const text = (await rl.question(`${chip("YOU", "blue")} ${kleur.cyan().bold("> ")}`)).trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;
      turn += 1;
      section(`TURN ${turn}`, "blue");
      console.log(`${chip("INPUT", "cyan")} ${value(text)}`);
      divider();

      try {
        const result = await runCoreChatTurn(sessionKey, text, {
          approveTool: async (call: ToolCall, args: Record<string, any>) => {
            const preview = (() => {
              try {
                const raw = JSON.stringify(args);
                return raw.length > 300 ? raw.slice(0, 300) + "..." : raw;
              } catch {
                return "(invalid args)";
              }
            })();
            console.log(`${chip("AUTH", "yellow")} ${value(`Tool: ${call.function.name}`)}`);
            console.log(`${subtle(preview)}\n`);
            return await askYesNo(`${kleur.yellow().bold("Approve tool call?")}`, true);
          },
          requestPermission: async (message: string, title?: string) => {
            const header = title?.trim() ? `${title}: ` : "";
            console.log(`${chip("PERMISSION", "yellow")} ${value(header + (message || "Approve request?"))}`);
            return await askYesNo(`${kleur.yellow().bold("Approve request?")}`, true);
          },
          askQuestion: async (question: string, options: string[], title?: string) => {
            section("QUESTION", "cyan");
            if (title?.trim()) console.log(kleur.magenta().bold(title));
            if (question?.trim()) console.log(value(question.trim()));
            for (let i = 0; i < options.length; i++) {
              console.log(`${kleur.cyan().bold(`${i + 1}.`)} ${value(options[i]!)}`);
            }
            const raw = (await rl.question(`${subtle("Select option number")} ${kleur.dim("(blank to cancel)")} ${kleur.cyan("> ")}`)).trim();
            if (!raw) return null;
            const idx = Number(raw) - 1;
            if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
              console.log(kleur.yellow("Invalid selection."));
              return null;
            }
            return { selected: options[idx]!, userLabel: "cli-user" };
          },
          onToolLine: (line: string) => {
            const trimmed = line.trim();
            if (trimmed) console.log(`${toolChip("TOOL")} ${subtle(trimmed)}`);
          },
        });

        if (result.reasoningSummary && result.reasoningSummary.trim() && result.reasoningSummary.length < 200) {
          console.log(`${chip("THINK", "magenta")} ${subtle(result.reasoningSummary.trim())}`);
        }
        console.log(`${okChip("ASSISTANT")}\n${result.text}\n`);
        divider();
      } catch (e: any) {
        console.log(`${errChip("ERROR")} ${e?.message || String(e)}\n`);
        divider();
      }
    }
  } finally {
    rl.close();
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
      ok(`macOS service installed.`);
      console.log(`${chip("MANAGE", "green")}`);
      console.log(`  ${cmdStyle("launchctl start/com.oponic.opoclaw")}`);
      console.log(`  ${cmdStyle("launchctl stop/com.oponic.opoclaw")}`);
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
      console.log(`${chip("MANAGE", "green")}`);
      console.log(`  ${cmdStyle("systemctl status opoclaw")}`);
      console.log(`  ${cmdStyle("systemctl stop opoclaw")}`);
      break;
    }
    case "windows": {
      warn("Windows service: create manually with NSSM or sc.exe.");
      console.log(`${chip("WINDOWS SERVICE", "yellow")}`);
      console.log(`  ${cmdStyle(`nssm install opoclaw "${OPCLAW_BIN}" gateway start`)}`);
      console.log(`  ${cmdStyle(`sc create opoclaw binPath="${OPCLAW_BIN} gateway start"`)}`);
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
  console.log(`\n${chip("DATA", "red")}`);
  console.log(`  ${value("To remove all data, delete:")} ${cmdStyle(OP_DIR)}`);
  console.log(`  ${subtle("(config.toml, workspace, and usage data will be lost)")}\n`);
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
    console.log(`${chip("PATH", "yellow")}`);
    if (getOS() === "windows") {
      console.log(`  ${value("Add")} ${cmdStyle(BIN_DIR)} ${value("to your PATH environment variable.")}`);
    } else {
      console.log(`  ${value("Add to .zshrc / .bashrc:")}`);
      console.log(`  ${cmdStyle(`export PATH="${BIN_DIR}:$PATH"` )}`);
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

  console.log(`\n${chip("MIGRATION", "cyan")}`);
  console.log(`  ${value("Your config is now at:")} ${cmdStyle(tomlPath)}`);
  console.log(`  ${value("Old config backed up at:")} ${cmdStyle(backupPath)}\n`);
}

// ── less_verbose_tools → tool_call_summaries migration ────────────────────

function migrateLessVerboseTools() {
  const tomlPath = resolve(OP_DIR, "config.toml");
  if (!existsSync(tomlPath)) return;

  const raw = readFileSync(tomlPath, "utf-8");
  const parsed = parseTOML(raw);

  const hasLessVerbose = "less_verbose_tools" in parsed;
  if (!hasLessVerbose) {
    return;
  }

  const value = parsed.less_verbose_tools;
  const next: any = { ...parsed };
  delete next.less_verbose_tools;

  if (value === true) {
    next.tool_call_summaries = "minimal";
    info(`less_verbose_tools = true → tool_call_summaries = "minimal"`);
  } else {
    // false or absent: "full" is the default, so just drop the key
    info(`less_verbose_tools = false → removed (default is "full")`);
  }

  const backupPath = tomlPath + ".bak";
  writeFileSync(backupPath, raw);
  writeFileSync(tomlPath, toTOML(next));
  ok(`Migrated less_verbose_tools → tool_call_summaries. Backup at config.toml.bak`);
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
        case "hibernate": await gatewayHibernate(); break;
        case "status":  await gatewayStatus(); break;
        default:
          console.log(`${label("Usage:")} ${cmdStyle("opoclaw gateway {start|stop|restart|hibernate|status}")}`);
      }
      break;

    case "update":
      await doUpdate(args[1] === "unstable" ? "unstable" : undefined, gatewayRestart);
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
      else console.log(`${label("Usage:")} ${cmdStyle("opoclaw service {install|remove}")}`);
      break;

    case "migrate":
      migrate();
      migrateToSnakeCase();
      migrateToSectionedConfig();
      migrateLessVerboseTools();
      break;

    case "onboard":
      exec("bun run installers/onboard.ts", { cwd: OP_DIR });
      break;

    case "version":
    case "v":
      try {
        const tag = exec("git describe --tags --abbrev=0 2>/dev/null", { cwd: OP_DIR });
        console.log(`${chip("VERSION", "green")} ${kleur.bold(`opoclaw ${tag}`)}`);
      } catch {
        console.log(`${chip("VERSION", "yellow")} ${subtle("opoclaw (unknown version — no git tags found)")}`);
      }
      break;

    case "explainer":
    case "explain":
      console.log(`
${chip("EXPLAINER", "blue")}

${value("opoclaw is a Discord bot framework. When someone mentions the bot:")}

${label("1.")} ${kleur.bold("Message received")} — Discord event triggers the MessageCreate handler.
   Only messages that @mention the bot (or reply to it) are processed.
   Own messages are always ignored. Other bots are ignored unless
   channel.discord.allow_bots=true in config.toml.

${label("2.")} ${kleur.bold("System prompt loaded")} — Three workspace files are read and composed:
   - SOUL.md — personality, tone, rules, vibe
   - IDENTITY.md — name, appearance, self-description
   - AGENTS.md — operating instructions, memory system, safety rules
   These form the system prompt sent to the LLM.

${label("3.")} ${kleur.bold("Channel history")} — Last 50 messages in the channel are fetched,
   formatted as [name]: content, and sent as conversation context.

${label("4.")} ${kleur.bold("LLM call")} — The composed prompt + history is sent to the configured
   provider (OpenRouter, Ollama, or custom endpoint). The model generates
   a response. If reasoning is enabled, the model's thinking tokens are
   captured during streaming.

${label("5.")} ${kleur.bold("Tools")} — The model can request tool calls (file operations, etc.).
   Tools execute in a loop (max 20 iterations) until the model stops
   requesting them or sends a final text response.

${label("6.")} ${kleur.bold("Response sent")} — The reply is sent back to Discord, split into
   chunks if over 1990 characters.

${chip("SECURITY", "red")}

- ${label("No data exfiltration")} — workspace files (SOUL, IDENTITY, AGENTS,
  MEMORY) are sent to the LLM provider as part of the prompt. Do not
  put secrets in these files.
- ${label("Token safety")} — Discord token and API keys live in config.toml,
  never sent to the LLM or exposed in responses.
- ${label("Tool sandboxing")} — file tools only read from the workspace directory.
  The send_file tool reads workspace files and attaches them to messages.
- ${label("No system commands")} — the bot cannot run shell commands or access
  your filesystem outside the workspace.
- ${label("Rate limiting")} — max 20 agent iterations per message prevents
  runaway loops.

${chip("CONFIG", "cyan")}
${value("config.toml lives at the project root. Onboard wizard:")} ${cmdStyle("opoclaw onboard")}.
${value("Channels live under")} ${subtle("[channel.*]")}. ${value("Providers live under")} ${subtle("[provider.*]")}.
${value("Toggle:")} ${subtle("channel.discord.allow_bots, enable_reasoning, reasoning_summary")}.
`);
      break;

    case "chat":
      await chatTui();
      break;

    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(`
  ${banner()}
  
${chip("HELP", "blue")}
${kleur.blue().bold("Lightweight AI agent framework")}

${chip("COMMANDS", "magenta")}
  ${cmdStyle("usage")}              ${subtle("Show token usage (last 24h) and cost")}
  ${cmdStyle("gateway start")}      ${subtle("Start the bot gateway")}
  ${cmdStyle("gateway stop")}       ${subtle("Stop the gateway")}
  ${cmdStyle("gateway restart")}    ${subtle("Restart the gateway")}
  ${cmdStyle("gateway hibernate")}  ${subtle("Hibernate the gateway (requires approval to wake)")}
  ${cmdStyle("gateway status")}     ${subtle("Check if gateway is running")}
  ${cmdStyle("update [unstable]")}  ${subtle("Pull latest release and restart (use unstable channel)")}
  ${cmdStyle("chat")}               ${subtle("Start interactive terminal chat (Core channel)")}
  ${cmdStyle("check-update")}       ${subtle("Check for available updates")}
  ${cmdStyle("install")}            ${subtle("Install opoclaw command + optional service")}
  ${cmdStyle("service install")}    ${subtle("Install auto-start service (systemd/launchd)")}
  ${cmdStyle("service remove")}     ${subtle("Remove auto-start service")}
  ${cmdStyle("uninstall")}          ${subtle("Remove command, service, and clean up")}
  ${cmdStyle("explainer")}          ${subtle("How opoclaw works")}
  ${cmdStyle("migrate")}            ${subtle("Upgrade config (JSON→TOML, camelCase→snake_case, sections)")}
  ${cmdStyle("onboard")}            ${subtle("Run onboarding wizard")}
  ${cmdStyle("version")}            ${subtle("Print current version (git tag)")}
  ${cmdStyle("help")}               ${subtle("Show this help")}

${chip("PATHS", "cyan")}
${label("Config:")}     ${value(getConfigPath())}
${label("Workspace:")}  ${value(WORKSPACE_DIR)}
${label("Usage:")}      ${value(USAGE_FILE)}
`);
      break;

    default:
      err(`Unknown command: ${cmd}`);
      console.log(`${subtle("Run")} ${cmdStyle("opoclaw help")} ${subtle("for usage.")}`);
      process.exit(1);
  }
}

main().catch((e) => {
  err(e.message || String(e));
  process.exit(1);
});
