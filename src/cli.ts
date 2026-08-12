#!/usr/bin/env bun
/**
 * opoclaw CLI — usage, gateway management, updates, uninstall
 */

import { resolve, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, statSync, openSync, readSync, closeSync } from "fs";
import { spawn, spawnSync } from "child_process";
import { homedir } from "os";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import kleur from "kleur";
import type { ToolCall } from "./agent.ts";
import { runCoreChatTurn } from "./channels/core.ts";
import { readActivity } from "./activity.ts";
import { validateConfig } from "./config-validation.ts";
import { getDenoBinary } from "./deno.ts";

// ── Paths ──────────────────────────────────────────────────────────────────

const OP_DIR = resolve(import.meta.dir, "..");
import { getConfigPath, formatTOMLValue, parseTOML, toTOML, loadConfig } from "./config.ts";
import { exec, checkForUpdate, doUpdate } from "./utils.ts";

const USAGE_FILE = resolve(OP_DIR, "usage.json");
const WORKSPACE_DIR = resolve(OP_DIR, "workspace");
const LOG_FILE = resolve(OP_DIR, "logs/gateway.log");
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
const ok = (s: string) => console.log(`${kleur.bgGreen().white().bold(" OK ")} ${s}`);
const warn = (s: string) => console.log(`${kleur.bgYellow().white().bold(" WARN ")} ${s}`);
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
    case "green": return kleur.bgGreen().white().bold(text);
    case "yellow": return kleur.bgYellow().white().bold(text);
    case "red": return kleur.bgRed().white().bold(text);
    case "cyan": return kleur.bgCyan().white().bold(text);
    default: return kleur.bgMagenta().white().bold(text);
  }
};
const okChip = (s: string) => kleur.bgGreen().white().bold(` ${s} `);
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

// Run a command with the terminal's stdio inherited so interactive prompts —
// notably sudo's password prompt — reach the user. The piped `exec` helper
// swallows the TTY, which makes sudo fail with "no tty present". Throws on a
// non-zero exit so callers can surface the failure.
function execInteractive(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with code ${r.status}`);
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


// ── Logs ───────────────────────────────────────────────────────────────────

// Read `count` bytes from `fd` starting at `offset` and return the decoded text.
function readFrom(fd: number, offset: number, count: number): string {
  if (count <= 0) return "";
  const buf = Buffer.allocUnsafe(count);
  const bytes = readSync(fd, buf, 0, count, offset);
  return buf.subarray(0, bytes).toString("utf-8");
}

async function showLogs(opts: { follow: boolean; lines: number }) {
  if (!existsSync(LOG_FILE)) {
    warn(`No log file found at ${LOG_FILE}`);
    console.log(`${subtle("The gateway writes this file once it has run. Start it with")} ${cmdStyle("opoclaw gateway start")}${subtle(".")}`);
    return;
  }

  info(`Tailing ${LOG_FILE}${opts.follow ? "  (Ctrl+C to stop)" : ""}`);
  const size = statSync(LOG_FILE).size;

  // Print the last `lines` lines by reading the whole file once. Log files are
  // small (a single gateway process appends to them), so this is cheap.
  const full = readFileSync(LOG_FILE, "utf-8");
  const allLines = full.split("\n");
  // A trailing newline yields a final empty element; drop it so counts are right.
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const tail = allLines.slice(-opts.lines);
  if (tail.length > 0) console.log(tail.join("\n"));

  if (!opts.follow) return;

  // Follow mode: poll the file size and print any appended bytes. If the file
  // shrinks (rotation/truncation), reset to the new start.
  let offset = size;
  await new Promise<void>(() => {
    const tick = () => {
      let stat;
      try {
        stat = statSync(LOG_FILE);
      } catch {
        return; // file briefly gone (e.g. rotation); try again next tick
      }
      if (stat.size < offset) offset = 0; // truncated/rotated
      if (stat.size > offset) {
        const fd = openSync(LOG_FILE, "r");
        try {
          const chunk = readFrom(fd, offset, stat.size - offset);
          offset = stat.size;
          if (chunk) process.stdout.write(chunk);
        } finally {
          closeSync(fd);
        }
      }
    };
    setInterval(tick, 500);
  });
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

  // Use the running bun binary (process.execPath) rather than the bare string
  // "bun" — on Windows, child_process.spawn does no PATH/PATHEXT resolution and
  // would throw ENOENT for "bun".
  const child = spawn(process.execPath, ["run", "src/index.ts"], {
    cwd: OP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.unref();
  setGatewayPID(child.pid!);

  // Pipe stdout/stderr with prefix
  child.stdout?.on("data", (d: Buffer) => {
    process.stdout.write(`${chip("GATEWAY", "cyan")} ${d}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`${chip("GATEWAY", "cyan")} ${d}`);
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
            console.log(`${chip("AUTH", "yellow")} ${value(`Tool: ${call.function.name} — this action requires approval and affects the requested resource.`)}`);
            console.log(`${subtle(preview)}\n`);
            const approved = await askYesNo(`${kleur.yellow().bold("Approve tool call?")}`, true);
            if (!approved) return { approved: false };
            const rawScope = (await rl.question(`${subtle("Scope: [1] once, [2] this session, [3] 30 minutes for this resource (default 1): ")}`)).trim();
            return { approved: true, scope: rawScope === "2" ? "session" : rawScope === "3" ? "duration" : "once" };
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
      // ProgramArguments must be the long-running gateway itself. Running
      // `opoclaw gateway start` forks a detached child and exits — with
      // KeepAlive=true launchd would then relaunch it in a tight loop, spawning
      // orphaned gateways. Run src/index.ts in the foreground with the absolute
      // bun binary, and put its directory on PATH so bun/git resolve.
      const bunBin = process.execPath;
      const bunDir = dirname(bunBin);
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.oponic.opoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunBin}</string>
        <string>run</string>
        <string>${OP_DIR}/src/index.ts</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${bunDir}:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
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
      // The service must run as the human user, not root — when this command is
      // run via sudo, whoami/homedir report root, so prefer SUDO_USER.
      const svcUser = process.env.SUDO_USER || exec("whoami");
      let svcHome = homedir();
      if (process.env.SUDO_USER) {
        try {
          const pw = exec(`getent passwd ${svcUser}`);
          svcHome = pw.split(":")[5] || `/home/${svcUser}`;
        } catch {
          svcHome = `/home/${svcUser}`;
        }
      }

      // ExecStart must be the long-running gateway process itself. The old unit
      // ran `opoclaw gateway start`, which forks a detached child and exits —
      // systemd (Type=simple) then treats the service as dead and tears down the
      // cgroup, killing the gateway. Run src/index.ts in the foreground instead.
      // Use the absolute bun binary and put its directory on PATH, since
      // systemd's default PATH does not include ~/.bun/bin.
      const bunBin = process.execPath;
      const bunDir = dirname(bunBin);
      const servicePath = `${bunDir}:/usr/local/bin:/usr/bin:/bin`;

      const unit = `[Unit]
Description=opoclaw AI Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${svcUser}
WorkingDirectory=${OP_DIR}
Environment=HOME=${svcHome}
Environment=PATH=${servicePath}
ExecStart=${bunBin} run ${OP_DIR}/src/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target`;

      mkdirSync(`${OP_DIR}/logs`, { recursive: true });
      // The daemon runs as svcUser, so it must own the log dir it appends to.
      try { exec(`chown -R ${svcUser} ${OP_DIR}/logs`); } catch {}

      // /etc/systemd/system is root-owned — writeFileSync there fails with EACCES
      // for a normal user. Stage the unit in the project dir, then install it with
      // sudo. `sudo` will prompt for a password if the user lacks a cached grant.
      const stagedUnit = resolve(OP_DIR, SYSTEMD_NAME);
      writeFileSync(stagedUnit, unit);
      try {
        execInteractive("sudo", ["install", "-m", "644", stagedUnit, SYSTEMD_PATH]);
      } finally {
        try { unlinkSync(stagedUnit); } catch {}
      }
      execInteractive("sudo", ["systemctl", "daemon-reload"]);
      execInteractive("sudo", ["systemctl", "enable", "opoclaw.service"]);
      execInteractive("sudo", ["systemctl", "start", "opoclaw.service"]);
      ok("Linux systemd service installed and started");
      console.log(`${chip("MANAGE", "green")}`);
      console.log(`  ${cmdStyle("systemctl status opoclaw")}`);
      console.log(`  ${cmdStyle("sudo systemctl stop opoclaw")}`);
      console.log(`  ${cmdStyle("journalctl -u opoclaw -f")}`);
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
        // Inherit stdio so sudo can prompt for a password if needed. Stop/disable
        // may fail if the unit isn't present; that's fine, so ignore their status.
        try { execInteractive("sudo", ["systemctl", "stop", "opoclaw.service"]); } catch {}
        try { execInteractive("sudo", ["systemctl", "disable", "opoclaw.service"]); } catch {}
        execInteractive("sudo", ["rm", "-f", SYSTEMD_PATH]);
        execInteractive("sudo", ["systemctl", "daemon-reload"]);
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
    const regex = new RegExp(`^\\s*${camel}(\\s*=)`, "gm");
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

// ── Config Reference ─────────────────────────────────────────────────────────

interface ConfigOption {
  key: string;          // dotted path, e.g. "provider.openrouter.api_key"
  type: string;         // human-readable type
  def: string;          // default, as displayed
  desc: string;         // one-line description
}

interface ConfigGroup {
  title: string;
  tone: ChipTone;
  options: ConfigOption[];
}

const CONFIG_REFERENCE: ConfigGroup[] = [
  {
    title: "PROVIDER",
    tone: "magenta",
    options: [
      { key: "provider.active", type: "openrouter|ollama|custom", def: "openrouter", desc: "Which provider to use" },
      { key: "provider.openrouter.api_key", type: "string", def: "—", desc: "OpenRouter API key (sk-or-v1-...)" },
      { key: "provider.openrouter.model", type: "string", def: "openrouter/auto", desc: "OpenRouter model ID" },
      { key: "provider.openrouter.base_url", type: "string", def: "https://openrouter.ai/api", desc: "OpenRouter API base URL" },
      { key: "provider.openrouter.vision", type: "boolean", def: "false", desc: "Send image attachments to the model" },
      { key: "provider.openrouter.video", type: "boolean", def: "false", desc: "Send video attachments to the model" },
      { key: "provider.openrouter.use_session_ids", type: "boolean", def: "true", desc: "Include session IDs in requests" },
      { key: "provider.openrouter.use_proxy", type: "boolean", def: "false", desc: "Route OpenRouter via bundled orproxy (unlocks options below)" },
      { key: "provider.openrouter.proxy_port", type: "number", def: "3001", desc: "Local port for the orproxy server" },
      { key: "provider.openrouter.quantization", type: "int4|int8|fp4|fp6|fp8|fp16|bf16|fp32", def: "—", desc: "Lock provider quantization (proxy)" },
      { key: "provider.openrouter.reasoning_effort", type: "low|medium|high|<n>|off", def: "—", desc: "Reasoning effort, token budget, or off (proxy)" },
      { key: "provider.openrouter.cache", type: "off|5m|1h", def: "off", desc: "Add prompt cache breakpoints, esp. Anthropic (proxy)" },
      { key: "provider.openrouter.zdr", type: "boolean", def: "false", desc: "Require a Zero-Data-Retention provider (proxy)" },
      { key: "provider.openrouter.strict", type: "boolean", def: "false", desc: "Disable provider fallbacks (proxy)" },
      { key: "provider.openrouter.service_tier", type: "string", def: "—", desc: "OpenRouter service tier, e.g. flex (proxy)" },
      { key: "provider.openrouter.providers", type: "string[]", def: "[]", desc: "Preferred provider slugs, in order (proxy)" },
      { key: "provider.ollama.base_url", type: "string", def: "http://localhost:11434", desc: "Ollama server URL" },
      { key: "provider.ollama.model", type: "string", def: "llama3.2", desc: "Ollama model name" },
      { key: "provider.custom.base_url", type: "string", def: "—", desc: "Custom endpoint base URL" },
      { key: "provider.custom.api_key", type: "string", def: "—", desc: "Custom endpoint API key" },
      { key: "provider.custom.model", type: "string", def: "—", desc: "Custom model name" },
      { key: "provider.custom.api_type", type: "openai|anthropic", def: "openai", desc: "Wire format of the custom endpoint" },
      { key: "provider.custom.anthropic_version", type: "string", def: "2023-06-01", desc: "anthropic-version header (anthropic only)" },
      { key: "provider.custom.max_tokens", type: "number", def: "1024", desc: "Max output tokens (anthropic only)" },
      { key: "provider.custom.vision", type: "boolean", def: "false", desc: "Send image attachments to the model" },
      { key: "provider.custom.video", type: "boolean", def: "false", desc: "Send video attachments to the model" },
    ],
  },
  {
    title: "CHANNELS",
    tone: "blue",
    options: [
      { key: "channel.discord.enabled", type: "boolean", def: "false", desc: "Enable the Discord channel" },
      { key: "channel.discord.token", type: "string", def: "—", desc: "Discord bot token" },
      { key: "channel.discord.allow_bots", type: "boolean", def: "false", desc: "Respond to other bots" },
      { key: "channel.discord.notify_channel", type: "string", def: "—", desc: "Channel ID for update notifications" },
      { key: "channel.signal.enabled", type: "boolean", def: "false", desc: "Enable the Signal channel" },
      { key: "channel.signal.account", type: "string", def: "—", desc: "Linked or registered signal-cli account number" },
      { key: "channel.signal.socket", type: "string", def: "$XDG_RUNTIME_DIR/signal-cli/socket", desc: "signal-cli daemon Unix socket" },
      { key: "channel.signal.host", type: "string", def: "127.0.0.1", desc: "signal-cli daemon TCP host" },
      { key: "channel.signal.port", type: "number", def: "7583", desc: "signal-cli daemon TCP port" },
      { key: "channel.signal.bot_name", type: "string", def: "opoclaw", desc: "Name to mention in Signal groups" },
      { key: "channel.signal.autostart", type: "boolean", def: "true", desc: "Start signal-cli daemon with gateway" },
      { key: "channel.irc.enabled", type: "boolean", def: "false", desc: "Enable the IRC channel" },
      { key: "channel.irc.server", type: "string", def: "—", desc: "IRC server host" },
      { key: "channel.irc.port", type: "number", def: "6667", desc: "IRC server port" },
      { key: "channel.irc.tls", type: "boolean", def: "false", desc: "Connect over TLS" },
      { key: "channel.irc.nick", type: "string", def: "—", desc: "IRC nickname" },
      { key: "channel.irc.username", type: "string", def: "—", desc: "IRC username" },
      { key: "channel.irc.realname", type: "string", def: "—", desc: "IRC realname" },
      { key: "channel.irc.password", type: "string", def: "—", desc: "IRC server password" },
      { key: "channel.irc.channels", type: "string", def: "—", desc: "Comma-separated channels to join" },
      { key: "channel.openai.enabled", type: "boolean", def: "false", desc: "Enable the OpenAI-compatible API channel" },
      { key: "channel.openai.host", type: "string", def: "127.0.0.1", desc: "Bind host for the API server" },
      { key: "channel.openai.port", type: "number", def: "—", desc: "Bind port for the API server" },
      { key: "channel.openai.api_key", type: "string", def: "—", desc: "Bearer token required from clients" },
    ],
  },
  {
    title: "MODEL BEHAVIOR",
    tone: "cyan",
    options: [
      { key: "enable_reasoning", type: "boolean", def: "false", desc: "Request model reasoning/thinking" },
      { key: "reasoning_summary", type: "boolean", def: "false", desc: "Summarize reasoning (extra API call)" },
      { key: "reasoning_summary_model", type: "string", def: "main model", desc: "Model used for reasoning summaries" },
    ],
  },
  {
    title: "TOOLS",
    tone: "green",
    options: [
      { key: "basic_tools", type: "boolean", def: "true", desc: "Enable read_file/edit_file/list_files" },
      { key: "real_shell", type: "boolean", def: "false", desc: "Use the real host shell instead of the sandbox" },
      { key: "exposed_commands", type: "string[]", def: "[]", desc: "Host commands exposed inside the sandbox shell" },
      { key: "ollama_semantic_search", type: "boolean", def: "false", desc: "Enable the semantic-search sandbox command" },
      { key: "tools.deno_enabled", type: "boolean", def: "true", desc: "Enable required sandboxed Deno execution" },
      { key: "tools.deno_timeout_ms", type: "number", def: "30000", desc: "Deno sandbox wall-clock timeout" },
      { key: "tools.deno_allowed_imports", type: "string[]", def: "@std, zod, lodash", desc: "Allowed Deno import prefixes" },
      { key: "enable_web_fetch", type: "boolean", def: "true", desc: "Enable the web_fetch tool" },
      { key: "search_provider", type: "duckduckgo|tavily", def: "duckduckgo", desc: "Web search backend" },
      { key: "tavily_api_key", type: "string", def: "—", desc: "Tavily API key (tvly-...)" },
      { key: "mounts", type: "table", def: "{}", desc: "Extra path mounts for file tools (name = path)" },
    ],
  },
  {
    title: "GENERAL",
    tone: "yellow",
    options: [
      { key: "use_toml_files", type: "boolean", def: "false", desc: "Use *.toml workspace files instead of *.md" },
      { key: "authorized_user_id", type: "string", def: "—", desc: "User ID allowed to approve sensitive actions" },
      { key: "tool_call_summaries", type: "full|minimal|off", def: "full", desc: "Verbosity of tool-call status messages" },
      { key: "update_channel", type: "stable|unstable", def: "stable", desc: "Release channel used by `update`" },
      { key: "show_update_notification", type: "boolean", def: "true", desc: "Announce available updates in Discord" },
      { key: "heartbeat.enabled", type: "boolean", def: "false", desc: "Run the periodic heartbeat agent" },
      { key: "heartbeat.interval_minutes", type: "number", def: "60", desc: "Minutes between heartbeat runs" },
      { key: "cron.enabled", type: "boolean", def: "false", desc: "Run durable cron schedules" },
      { key: "cron.max_jobs", type: "number", def: "100", desc: "Maximum cron jobs run per scheduler pass" },
      { key: "cron.timezone", type: "string", def: "system timezone", desc: "IANA timezone used for cron matching" },
      { key: "cron.catch_up", type: "boolean", def: "true", desc: "Run missed schedules after downtime" },
      { key: "jobs.max_concurrent", type: "number", def: "2", desc: "Maximum concurrent durable jobs" },
      { key: "jobs.max_per_session", type: "number", def: "1", desc: "Maximum concurrent durable jobs per session" },
      { key: "usage_alerts.hard_limit", type: "number", def: "—", desc: "Pause model calls once rolling cost reaches this USD amount" },
      { key: "usage_alerts.session_limit", type: "number", def: "—", desc: "Pause a session once its tracked cost reaches this USD amount" },
      { key: "artifacts.retention_days", type: "number", def: "7", desc: "Days artifacts are retained" },
      { key: "artifacts.max_bytes", type: "number", def: "—", desc: "Maximum artifact-store size in bytes" },
      { key: "activity.enabled", type: "boolean", def: "false", desc: "Enable authenticated localhost activity endpoint" },
      { key: "activity.token", type: "string", def: "—", desc: "Bearer token for the local activity endpoint" },
      { key: "dreamer.enabled", type: "boolean", def: "false", desc: "Run the end-of-day dreamer reflection" },
    ],
  },
];

function getNested(obj: any, dotted: string): any {
  return dotted.split(".").reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

function showConfigReference() {
  const configPath = getConfigPath();
  let current: Record<string, any> | null = null;
  if (existsSync(configPath)) {
    try {
      current = parseTOML(readFileSync(configPath, "utf-8"));
    } catch (e: any) {
      warn(`Could not parse ${configPath}: ${e.message}`);
    }
  }

  console.log(banner());
  console.log(`\n${chip("CONFIG REFERENCE", "magenta")}`);
  console.log(`${label("File:")} ${value(configPath)}${current ? "" : subtle("  (not found — showing defaults only)")}\n`);

  // Redact obviously sensitive values when echoing the current config.
  const isSecret = (key: string) => /(_key|token|password)$/.test(key.split(".").pop() || "");
  const fmtCurrent = (key: string, val: any): string => {
    if (val === undefined) return "";
    if (isSecret(key) && val) return kleur.green("set");
    if (Array.isArray(val)) return kleur.green(`[${val.length}]`);
    if (val && typeof val === "object") return kleur.green("{…}");
    return kleur.green(String(val));
  };

  for (const group of CONFIG_REFERENCE) {
    console.log(`${chip(group.title, group.tone)}`);
    for (const opt of group.options) {
      const cur = current ? fmtCurrent(opt.key, getNested(current, opt.key)) : "";
      const head = `  ${cmdStyle(opt.key)} ${subtle(`(${opt.type})`)}`;
      console.log(head);
      const meta = `      ${opt.desc}  ${subtle(`default: ${opt.def}`)}${cur ? `  ${subtle("current:")} ${cur}` : ""}`;
      console.log(meta);
    }
    console.log();
  }

  console.log(`${subtle("Edit")} ${cmdStyle(configPath)} ${subtle("directly, or run")} ${cmdStyle("opoclaw onboard")} ${subtle("to regenerate it.")}\n`);
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

async function doctor(jsonOutput = false): Promise<void> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  let config: any;
  try {
    config = loadConfig();
    const issues = validateConfig(config);
    checks.push({ name: "config", ok: issues.length === 0, detail: issues.length ? issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ") : `Loaded ${getConfigPath()}` });
  } catch (e: any) {
    checks.push({ name: "config", ok: false, detail: e.message || String(e) });
  }
  try {
    const deno = Bun.spawnSync({ cmd: [getDenoBinary(), "--version"], stdout: "pipe", stderr: "pipe" });
    checks.push({ name: "deno", ok: deno.exitCode === 0, detail: deno.exitCode === 0 ? (new TextDecoder().decode(deno.stdout).split("\n")[0] || "Available") : "Not installed (Deno tool unavailable)" });
  } catch {
    checks.push({ name: "deno", ok: false, detail: "Not installed (Deno tool unavailable)" });
  }
  if (config?.channel?.signal?.enabled) {
    const binary = config.channel.signal.signal_cli_path || "signal-cli";
    try {
      const signal = Bun.spawnSync({ cmd: [binary, "--version"], stdout: "pipe", stderr: "pipe" });
      checks.push({ name: "signal-cli", ok: signal.exitCode === 0, detail: signal.exitCode === 0 ? "Available" : `Missing or failed: ${binary}` });
    } catch {
      checks.push({ name: "signal-cli", ok: false, detail: `Missing or failed: ${binary}` });
    }
  }
  const workspaceWritable = await Bun.write(resolve(WORKSPACE_DIR, ".doctor-write-test"), "ok").then(async () => { try { unlinkSync(resolve(WORKSPACE_DIR, ".doctor-write-test")); } catch {} return true; }).catch(() => false);
  checks.push({ name: "workspace", ok: workspaceWritable, detail: workspaceWritable ? "Writable" : "Not writable" });
  if (jsonOutput) console.log(JSON.stringify({ ok: checks.every((check) => check.ok), checks }, null, 2));
  else for (const check of checks) console.log(`${check.ok ? kleur.green("✓") : kleur.red("✗")} ${check.name}: ${check.detail}`);
}

async function showActivity(jsonOutput = false): Promise<void> {
  const args = process.argv.slice(3);
  const type = args.find((arg) => arg.startsWith("--type="))?.slice(7);
  const sessionId = args.find((arg) => arg.startsWith("--session="))?.slice(10);
  const jobId = args.find((arg) => arg.startsWith("--job="))?.slice(6);
  const limitRaw = args.find((arg) => arg.startsWith("--limit="))?.slice(8);
  const events = await readActivity(limitRaw ? Number(limitRaw) : 100, { type, sessionId, jobId });
  if (jsonOutput) { console.log(JSON.stringify(events, null, 2)); return; }
  if (events.length === 0) { info("No activity recorded yet."); return; }
  for (const event of events) console.log(`${subtle(event.timestamp)} ${label(event.type)} ${event.tool ? `${event.tool} ` : ""}${event.jobId ? `job=${event.jobId}` : ""}`.trim());
}

// ── CLI Router ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case "usage":
      await showUsage();
      break;

    case "doctor":
      await doctor(args.includes("--json"));
      break;

    case "activity":
      await showActivity(args.includes("--json"));
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

    case "onboard": {
      // Run interactively — the wizard prompts via readline, so it needs the
      // real stdio inherited (exec() pipes stdio and the prompts would hang).
      const onboardScript = resolve(OP_DIR, "installers/onboard.ts");
      const r = spawnSync(process.execPath, ["run", onboardScript], { cwd: OP_DIR, stdio: "inherit" });
      if (r.status !== 0) process.exit(r.status ?? 1);
      break;
    }

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

    case "config":
      showConfigReference();
      break;

    case "logs": {
      const rest = args.slice(1);
      const follow = rest.includes("-f") || rest.includes("--follow");
      let lines = 200;
      const nIdx = rest.findIndex((a) => a === "-n" || a === "--lines");
      if (nIdx !== -1 && rest[nIdx + 1] !== undefined) {
        const parsed = parseInt(rest[nIdx + 1]!, 10);
        if (Number.isFinite(parsed) && parsed > 0) lines = parsed;
      }
      await showLogs({ follow, lines });
      break;
    }

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
  ${cmdStyle("doctor [--json]")}     ${subtle("Validate local prerequisites and configuration")}
  ${cmdStyle("activity [--json]")}   ${subtle("Show activity; filter with --type/--session/--job/--limit")}
  ${subtle("                    Example: opoclaw activity --type=delivery.sent --limit=20")}
  ${cmdStyle("doctor [--json]")}     ${subtle("Validate config, Deno, workspace, and enabled prerequisites")}
  ${cmdStyle("gateway start")}      ${subtle("Start the bot gateway")}
  ${cmdStyle("gateway stop")}       ${subtle("Stop the gateway")}
  ${cmdStyle("gateway restart")}    ${subtle("Restart the gateway")}
  ${cmdStyle("gateway hibernate")}  ${subtle("Hibernate the gateway (requires approval to wake)")}
  ${cmdStyle("gateway status")}     ${subtle("Check if gateway is running")}
  ${cmdStyle("update [unstable]")}  ${subtle("Pull latest release and restart (use unstable channel)")}
  ${cmdStyle("chat")}               ${subtle("Start interactive terminal chat (Core channel)")}
  ${cmdStyle("logs [-f] [-n N]")}   ${subtle("Show gateway logs (--follow to tail, -n for line count)")}
  ${cmdStyle("check-update")}       ${subtle("Check for available updates")}
  ${cmdStyle("install")}            ${subtle("Install opoclaw command + optional service")}
  ${cmdStyle("service install")}    ${subtle("Install auto-start service (systemd/launchd)")}
  ${cmdStyle("service remove")}     ${subtle("Remove auto-start service")}
  ${cmdStyle("uninstall")}          ${subtle("Remove command, service, and clean up")}
  ${cmdStyle("explainer")}          ${subtle("How opoclaw works")}
  ${cmdStyle("migrate")}            ${subtle("Upgrade config (JSON→TOML, camelCase→snake_case, sections)")}
  ${cmdStyle("onboard")}            ${subtle("Run onboarding wizard")}
  ${cmdStyle("config")}             ${subtle("List all config options, defaults, and current values")}
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
