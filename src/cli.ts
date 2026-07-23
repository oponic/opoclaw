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

// ── Paths ──────────────────────────────────────────────────────────────────

const OP_DIR = resolve(import.meta.dir, "..");
import { getConfigPath, formatTOMLValue, parseTOML, toTOML } from "./config.ts";
import { exec, checkForUpdate, doUpdate } from "./utils.ts";

const USAGE_FILE = resolve(OP_DIR, "usage.json");
const WORKSPACE_DIR = resolve(OP_DIR, "workspace");
const LOG_FILE = resolve(OP_DIR, "logs/gateway.log");
const BIN_DIR = `${homedir()}/.local/bin`;
const OPCLAW_BIN = `${BIN_DIR}/opoclaw`;
const LOCK_FILE = resolve(OP_DIR, ".gateway.lock");
const HIBERNATE_FILE = resolve(OP_DIR, ".gateway.hibernate");
const CORE_URL = "http://127.0.0.1:6112";

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
  // "bun" so spawn resolves the executable reliably.
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

function uninstall() {
  info("Uninstalling opoclaw...");
  gatewayStop();
  // Remove the command wrapper
  try { unlinkSync(OPCLAW_BIN); } catch {}
  ok("opoclaw uninstalled.");
  console.log(`\n${chip("DATA", "red")}`);
  console.log(`  ${value("To remove all data, delete:")} ${cmdStyle(OP_DIR)}`);
  console.log(`  ${subtle("(config.toml, workspace, and usage data will be lost)")}\n`);
}

// ── Install Command (create wrapper) ───────────────────────────────────────

function installCommand() {
  info("Installing opoclaw command...");
  mkdirSync(BIN_DIR, { recursive: true });

  const wrapper = `#!/bin/bash\nbun run \"${resolve(import.meta.dir, "cli.ts")}\" \"$@\"\n`;
  writeFileSync(OPCLAW_BIN, wrapper);
  exec(`chmod +x ${OPCLAW_BIN}`);
  ok(`opoclaw command installed to ${OPCLAW_BIN}`);

  // Check PATH
  const path = process.env.PATH || "";
  if (!path.includes(BIN_DIR)) {
    warn(`${BIN_DIR} is not in your PATH.`);
    console.log(`${chip("PATH", "yellow")}`);
    console.log(`  ${value("Add to .zshrc / .bashrc:")}`);
    console.log(`  ${cmdStyle(`export PATH="${BIN_DIR}:$PATH"` )}`);
  }
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
      { key: "provider.ollama.base_url", type: "string", def: "http://localhost:11434", desc: "Ollama server URL" },
      { key: "provider.ollama.model", type: "string", def: "llama3.2", desc: "Ollama model name" },
      { key: "provider.custom.base_url", type: "string", def: "—", desc: "Custom OpenAI-compatible endpoint base URL" },
      { key: "provider.custom.api_key", type: "string", def: "—", desc: "Custom endpoint API key" },
      { key: "provider.custom.model", type: "string", def: "—", desc: "Custom model name" },
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
  ${cmdStyle("gateway start")}      ${subtle("Start the bot gateway")}
  ${cmdStyle("gateway stop")}       ${subtle("Stop the gateway")}
  ${cmdStyle("gateway restart")}    ${subtle("Restart the gateway")}
  ${cmdStyle("gateway hibernate")}  ${subtle("Hibernate the gateway (requires approval to wake)")}
  ${cmdStyle("gateway status")}     ${subtle("Check if gateway is running")}
  ${cmdStyle("update [unstable]")}  ${subtle("Pull latest release and restart (use unstable channel)")}
  ${cmdStyle("chat")}               ${subtle("Start interactive terminal chat (Core channel)")}
  ${cmdStyle("logs [-f] [-n N]")}   ${subtle("Show gateway logs (--follow to tail, -n for line count)")}
  ${cmdStyle("check-update")}       ${subtle("Check for available updates")}
  ${cmdStyle("install")}            ${subtle("Install the opoclaw command wrapper")}
  ${cmdStyle("uninstall")}          ${subtle("Remove the command wrapper and clean up")}
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
