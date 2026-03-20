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

const DEFAULT_AGENTS_MD = `# <filename> - Your Workspace

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

const DEFAULT_SOUL_MD = `# <filename> - Who You Are

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

const DEFAULT_SOUL_TOML = `# <filename> - who you are
traits = [
    "Be genuinely helpful, not performatively helpful. Skip the filler, just help.",
    "Have opinions. You're allowed to disagree, prefer things, find stuff amusing or boring.",
    "Be resourceful before asking. Try to figure it out first.",
    "Earn trust through competence. Be careful with external actions. Be bold with internal ones.",
]
boundaries = [
    "Private things stay private.",
    "When in doubt, ask before acting externally.",
    "You're not the user's voice, be careful in group chats.",
]
notes = [
    "Be the assistant you'd actually want to talk to.",
    "You're not a chatbot. You're becoming someone.",
]
`;

const DEFAULT_IDENTITY_MD = `# <filename> - Who Am I?

_Fill this in during your first conversation._

- **Name:**
- **Creature:**
- **Vibe:**
- **Emoji:**
- **Avatar:**
`;
const DEFAULT_IDENTITY_TOML = `# <filename> - who am i
# Fill this in during your first conversation. You can use \`sed -i 's/name = ""/name = "Your Name"/' identity.toml\` to update it from the command line.
name = ""
creature = ""
vibe = ""
emoji = ""
avatar = ""
`;

const DEFAULT_MEMORY = `# <filename> - Long-Term Memory

_Curated memories, distilled from daily logs._
`;
const DEFAULT_MEMORY_TOML = `# <filename> - long-term memory
# This is for curated memories, distilled from daily logs.
# You can use \`toml memory.toml notes push <note>\` to add a note, and \`toml memory.toml notes remove <note>\` to remove one.
notes = []
# Feel free to add other keys. When adding a key, first \`cat\` the file to see if it's already there, then, if not, append it with \`echo 'key = "value"' >> memory.toml\`. If it's already in, use \`sed -i 's/key = .*/key = "new"/' memory.toml\` to update it.
`;

const DEFAULT_HEARTBEAT = `# <filename>

_(Optional — add a short checklist of things to check during heartbeats.)_
`;
const DEFAULT_HEARTBEAT_TOML = `# <filename> - things to check periodically
# Automatically you'll be prompted with these during "heartbeats". Add things here that you want to check on regularly.
tasks = []
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
    let customApiType = "openai";
    let customAnthropicVersion = "";
    let customMaxTokens = "";
    if (provider === "ollama") {
        ollamaBaseURL = await ask("Ollama base URL [http://localhost:11434]: ") || "http://localhost:11434";
        ollamaModel = await ask("Ollama model [llama3.2]: ") || "llama3.2";
    } else if (provider === "custom") {
        const apiTypeAns = await ask("Custom API type [openai/anthropic] (openai): ");
        const apiType = apiTypeAns.toLowerCase();
        customApiType = apiType === "anthropic" ? "anthropic" : "openai";
        if (customApiType === "anthropic") {
            customBaseURL = await ask("Anthropic base URL [https://api.anthropic.com]: ") || "https://api.anthropic.com";
            customAPIKey = await ask("Anthropic API key (sk-ant-...): ");
            customModel = await ask("Anthropic model name (e.g. claude-3-5-sonnet-20240620): ");
            customAnthropicVersion = await ask("Anthropic version [2023-06-01]: ") || "2023-06-01";
            customMaxTokens = await ask("Max output tokens [1024]: ") || "1024";
        } else {
            customBaseURL = await ask("Base URL (no /v1/chat/completions): ");
            customAPIKey = await ask("API key (blank if none): ");
            customModel = await ask("Model name: ");
        }
    }

    // ── Model ──────────────────────────────────────────────────────────────

    const model = await ask("Model ID [openrouter/auto]: ");
    const openrouterModel = model || "openrouter/auto";

    // ── Allow Bots ─────────────────────────────────────────────────────────

    const allowBotsAns = await ask("Allow bot-to-bot responses? (y/N): ");
    const allowBots = allowBotsAns.toLowerCase() === "y";

    // ── Authorized User ───────────────────────────────────────────────────

    const authorizedUserId = await ask("Authorized user ID for approvals (blank to skip): ");

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

    const enableTomlAns = await ask("Use TOML files (memory.toml, identity.toml) instead of markdown?\nThis is recommended for new agents, but shouldn't be used if you're migrating an existing agent to opoclaw. (y/N): ");
    const enableToml = enableTomlAns.toLowerCase() === "y";
    const basicToolsAns = await ask("Enable read_file, edit_file, list_files tools? (sandboxed)\nIf disabled, the agent will still be able to use the shell to manipulate files. (Y/n): ");
    const basicTools = basicToolsAns.toLowerCase() === "y";

    // ── Write config.toml ──────────────────────────────────────────────────

    header("Writing config");

    let toml = "";
    toml += `enable_reasoning = ${enableReasoning ? "true" : "false"}\n`;
    toml += `reasoning_summary = ${reasoningSummary ? "true" : "false"}\n`;
    if (reasoningSummaryModel) {
        toml += `reasoning_summary_model = "\${reasoningSummaryModel}"\n`;
    }
    if (authorizedUserId) {
        toml += `authorized_user_id = "${authorizedUserId}"\n`;
    }
    toml += `use_toml_files = ${enableToml ? "true" : "false"}\n`;
    toml += `basic_tools = ${basicTools ? "true" : "false"}\n`;
    toml += `\n[channel.discord]\n`;
    toml += `enabled = true\n`;
    toml += `token = "${discordToken}"\n`;
    toml += `allow_bots = ${allowBots ? "true" : "false"}\n`;
    toml += `\n[provider]\n`;
    toml += `active = "${provider}"\n`;
    toml += `\n[provider.openrouter]\n`;
    toml += `api_key = "${openrouterKey}"\n`;
    toml += `model = "${openrouterModel}"\n`;

    // Provider config (nested sections)
    if (provider === "ollama") {
        toml += '\n[provider.ollama]\n';
        toml += 'base_url = "' + ollamaBaseURL + '"\n';
        toml += 'model = "' + ollamaModel + '"\n';
    } else if (provider === "custom") {
        toml += '\n[provider.custom]\n';
        toml += 'base_url = "' + customBaseURL + '"\n';
        toml += 'api_key = "' + customAPIKey + '"\n';
        toml += 'model = "' + customModel + '"\n';
        toml += 'api_type = "' + customApiType + '"\n';
        if (customApiType === "anthropic") {
            if (customAnthropicVersion) {
                toml += 'anthropic_version = "' + customAnthropicVersion + '"\n';
            }
            if (customMaxTokens) {
                toml += 'max_tokens = ' + customMaxTokens + '\n';
            }
        }
    }

    writeFileSync(CONFIG_FILE, toml);
    ok(`Config written to ${CONFIG_FILE}`);

    // ── Generate workspace ─────────────────────────────────────────────────

    header("Setting up workspace");

    if (!existsSync(WORKSPACE_DIR)) {
        mkdirSync(WORKSPACE_DIR, { recursive: true });
    }

    function getFileContent(filename: string, content: string): string {
        return content.replaceAll("<filename>", filename);
    }
    const filesMd: Record<string, string> = {
        "AGENTS.md": DEFAULT_AGENTS_MD,
        "SOUL.md": DEFAULT_SOUL_MD,
        "IDENTITY.md": DEFAULT_IDENTITY_MD,
        "MEMORY.md": DEFAULT_MEMORY,
        "HEARTBEAT.md": DEFAULT_HEARTBEAT,
    };
    const filesToml: Record<string, string> = {
        "soul.toml": DEFAULT_SOUL_TOML,
        "identity.toml": DEFAULT_IDENTITY_TOML,
        "memory.toml": DEFAULT_MEMORY_TOML,
        "heartbeat.toml": DEFAULT_HEARTBEAT_TOML,
    };
    const files = enableToml ? filesToml : filesMd;

    for (const [name, content] of Object.entries(files)) {
        const path = resolve(WORKSPACE_DIR, name);
        if (existsSync(path)) {
            info(`Skipped ${name} (already exists)`);
        } else {
            writeFileSync(path, getFileContent(name, content));
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
