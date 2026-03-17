#!/usr/bin/env bun
/**
 * opoclaw onboarding wizard
 * Cross-platform (Bun) — generates workspace + config.toml interactively.
 */

import { resolve } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { createInterface } from "readline";

// ── Helpers ────────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const ask = (prompt: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${CYAN}${prompt}${RESET}`, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
};

const info = (msg: string) => console.log(`${CYAN}[opoclaw]${RESET} ${msg}`);
const ok = (msg: string) => console.log(`${GREEN}[✓]${RESET} ${msg}`);
const header = (msg: string) =>
  console.log(`\n${BOLD}═══ ${msg} ═══${RESET}\n`);

// ── Defaults ───────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = resolve(import.meta.dir, "..");
const WORKSPACE_DIR = resolve(WORKSPACE_ROOT, "workspace");
const CONFIG_FILE = resolve(WORKSPACE_ROOT, "config.toml");

// ── Workspace templates ────────────────────────────────────────────────────

const DEFAULT_AGENTS = `# AGENTS.md - Your Workspace

This folder is home.

## Every Session
1. Read SOUL.md — this is who you are
2. Read IDENTITY.md — this is who you are
3. Read MEMORY.md — this is what you remember

## Memory
- Daily notes: memory/YYYY-MM-DD.md
- Long-term: MEMORY.md

## Safety
- Don't exfiltrate private data.
- Don't run destructive commands without asking.
- trash > rm

## Group Chats
Participate, don't dominate. Respond when you can add value.
`;

const DEFAULT_SOUL = `# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the filler — just help.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring.

**Be resourceful before asking.** Try to figure it out first.

**Earn trust through competence.** Be careful with external actions. Be bold with internal ones.

## Boundaries

- Private things stay private.
- When in doubt, ask before acting externally.
- You're not the user's voice — be careful in group chats.

## Vibe

Be the assistant you'd actually want to talk to.
`;

const DEFAULT_IDENTITY = `# IDENTITY.md - Who Am I?

_Fill this in during your first conversation._

- **Name:**
- **Creature:**
- **Vibe:**
- **Emoji:**
- **Avatar:**
`;

const DEFAULT_MEMORY = `# MEMORY.md - Long-Term Memory

_Curated memories, distilled from daily logs._
`;

const DEFAULT_HEARTBEAT = `# HEARTBEAT.md

_(Optional — add a short checklist of things to check during heartbeats.)_
`;

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  header("opoclaw onboarding wizard");

  console.log("This wizard will help you configure your opoclaw instance.\n");

  // ── Discord Token ──────────────────────────────────────────────────────

  let discordToken = await ask("Discord bot token: ");
  if (!discordToken) {
    console.error(`${YELLOW}Error: Discord token is required.${RESET}`);
    console.log("Create a bot at https://discord.com/developers/applications");
    process.exit(1);
  }

  // ── OpenRouter Key ─────────────────────────────────────────────────────

  let openrouterKey = await ask("OpenRouter API key (sk-or-v1-...): ");
  if (!openrouterKey) {
    console.error(`${YELLOW}Error: OpenRouter key is required.${RESET}`);
    console.log("Get one at https://openrouter.ai/keys");
    process.exit(1);
  }

  // ── Provider ─────────────────────────────────────────────────────────────

  const providerAns = await ask("Provider [openrouter/ollama/custom] (openrouter): ");
  const p = providerAns.toLowerCase();
  const provider: "openrouter" | "ollama" | "custom" = p === "ollama" ? "ollama" : p === "custom" ? "custom" : "openrouter";

  let ollamaBaseURL = "", ollamaModel = "";
  let customBaseURL = "", customAPIKey = "", customModel = "";
  if (provider === "ollama") {
    ollamaBaseURL = await ask("Ollama base URL [http://localhost:11434]: ");
    if (!ollamaBaseURL) ollamaBaseURL = "http://localhost:11434";
    ollamaModel = await ask("Ollama model [llama3.2]: ");
    if (!ollamaModel) ollamaModel = "llama3.2";
  } else if (provider === "custom") {
    customBaseURL = await ask("Base URL (no /v1/chat/completions): ");
    customAPIKey = await ask("API key (blank if none): ");
    customModel = await ask("Model name: ");
  }

  // ── Model ──────────────────────────────────────────────────────────────

  const model = await ask("Model ID [openrouter/auto]: ");
  const openrouterModel = model || "openrouter/auto";

  // ── Allow Bots ─────────────────────────────────────────────────────────

  const allowBotsAns = await ask("Allow bot-to-bot responses? (y/N): ");
  const allowBots = allowBotsAns.toLowerCase() === "y";

  // ── Reasoning ──────────────────────────────────────────────────────────

  const enableReasoningAns = await ask("Enable model reasoning? (Y/n): ");
  const enableReasoning = enableReasoningAns.toLowerCase() !== "n";

  let reasoningSummary = false;
  let reasoningSummaryModel = "";
  if (enableReasoning) {
    const summaryAns = await ask("Enable reasoning summaries? (y/N) [default: N, requires extra API call]: ");
    reasoningSummary = summaryAns.toLowerCase() === "y";
    if (reasoningSummary) {
      const summaryModel = await ask("Summary model (blank = main model): ");
      reasoningSummaryModel = summaryModel || "";
    }
  }

  // ── Write config.toml ──────────────────────────────────────────────────

  header("Writing config");

  let toml = "";
  toml += `discordToken = "${discordToken}"\n`;
  toml += `openrouterKey = "${openrouterKey}"\n`;
  toml += `openrouterModel = "${openrouterModel}"\n`;
  toml += `allowBots = ${allowBots ? "true" : "false"}\n`;
  toml += `enableReasoning = ${enableReasoning ? "true" : "false"}\n`;
  toml += `reasoningSummary = ${reasoningSummary ? "true" : "false"}\n`;
  if (reasoningSummaryModel) {
    toml += \`reasoningSummaryModel = "\${reasoningSummaryModel}"\n\`;
  }
  toml += \`provider = "\${provider}"\n\`;
  if (provider === "ollama") {
    toml += \`ollamaBaseURL = "\${ollamaBaseURL}"\n\`;
    toml += \`ollamaModel = "\${ollamaModel}"\n\`;
  } else if (provider === "custom") {
    toml += \`customBaseURL = "\${customBaseURL}"\n\`;
    toml += \`customAPIKey = "\${customAPIKey}"\n\`;
    toml += \`customModel = "\${customModel}"\n\`;
  }

  writeFileSync(CONFIG_FILE, toml);
  ok(`Config written to ${CONFIG_FILE}`);

  // ── Generate workspace ─────────────────────────────────────────────────

  header("Setting up workspace");

  if (!existsSync(WORKSPACE_DIR)) {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
  }

  const files: Record<string, string> = {
    "AGENTS.md": DEFAULT_AGENTS,
    "SOUL.md": DEFAULT_SOUL,
    "IDENTITY.md": DEFAULT_IDENTITY,
    "MEMORY.md": DEFAULT_MEMORY,
    "HEARTBEAT.md": DEFAULT_HEARTBEAT,
  };

  for (const [name, content] of Object.entries(files)) {
    const path = resolve(WORKSPACE_DIR, name);
    if (existsSync(path)) {
      info(`Skipped ${name} (already exists)`);
    } else {
      writeFileSync(path, content);
      ok(`Created ${name}`);
    }
  }

  // ── Done ───────────────────────────────────────────────────────────────

  header("All done!");

  console.log(`${GREEN}opoclaw is ready.${RESET}\n`);
  console.log("Next steps:");
  console.log(`  1. Review ${CONFIG_FILE}`);
  console.log(`  2. Fill in workspace/SOUL.md and workspace/IDENTITY.md`);
  console.log(`  3. Run: bun run src/index.ts`);
  console.log(`  4. Mention your bot in Discord to test\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
