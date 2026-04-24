#!/usr/bin/env bun
/**
 * opoclaw onboarding wizard
 * Cross-platform (Bun) — generates workspace + config.toml interactively.
 */

import { resolve } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import TOML from "@iarna/toml";
import kleur from "kleur";
import type { OpoclawConfig } from "../src/config.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

const ask = (prompt: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(kleur.cyan(prompt), (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
};

const askMCQ = async <T extends string>(question: string, answers: T[], defaultAnswer: T): Promise<T> => {
    const ans = await ask(`${question} [${answers.join("/")}] (${defaultAnswer}): `);
    const lower = ans.toLowerCase().trim();
    return (answers.find(a => a === lower) ?? defaultAnswer);
};

const info = (msg: string) => console.log(`${kleur.cyan("[opoclaw]")} ${msg}`);
const ok = (msg: string) => console.log(`${kleur.green("[✓]")} ${msg}`);
const header = (msg: string) =>
    console.log(`\n${kleur.bold(`═══ ${msg} ═══`)}\n`);

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

    const discordToken = await ask("Discord bot token: ");
    if (!discordToken) {
        console.error(kleur.yellow("Error: Discord token is required."));
        console.log("Create a bot at https://discord.com/developers/applications");
        process.exit(1);
    }

    // ── Provider ─────────────────────────────────────────────────────────────

    const provider = await askMCQ("Provider", ["openrouter", "ollama", "custom"] as const, "openrouter");

    let providerSection: OpoclawConfig["provider"];

    if (provider === "ollama") {
        const ollamaBaseURL = await ask("Ollama base URL [http://localhost:11434]: ") || "http://localhost:11434";
        const ollamaModel = await ask("Ollama model [llama3.2]: ") || "llama3.2";
        providerSection = {
            active: "ollama",
            ollama: { base_url: ollamaBaseURL, model: ollamaModel },
        };
    } else if (provider === "custom") {
        const customApiType = await askMCQ("Custom API type", ["openai", "anthropic"] as const, "openai");
        if (customApiType === "anthropic") {
            const customBaseURL = await ask("Anthropic base URL [https://api.anthropic.com]: ") || "https://api.anthropic.com";
            const customAPIKey = await ask("Anthropic API key (sk-ant-...): ");
            const customModel = await ask("Anthropic model name (e.g. claude-3-5-sonnet-20240620): ");
            const customAnthropicVersion = await ask("Anthropic version [2023-06-01]: ") || "2023-06-01";
            const customMaxTokens = parseInt(await ask("Max output tokens [1024]: ") || "1024", 10);
            providerSection = {
                active: "custom",
                custom: { base_url: customBaseURL, api_key: customAPIKey, model: customModel, api_type: "anthropic", anthropic_version: customAnthropicVersion, max_tokens: customMaxTokens },
            };
        } else {
            const customBaseURL = await ask("Base URL (no /v1/chat/completions): ");
            const customAPIKey = await ask("API key (blank if none): ");
            const customModel = await ask("Model name: ");
            providerSection = {
                active: "custom",
                custom: { base_url: customBaseURL, api_key: customAPIKey, model: customModel, api_type: "openai" },
            };
        }
    } else {
        const openrouterKey = await ask("OpenRouter API key (sk-or-v1-...): ");
        if (!openrouterKey) {
            console.error(kleur.yellow("Error: OpenRouter key is required."));
            console.log("Get one at https://openrouter.ai/keys");
            process.exit(1);
        }
        const openrouterModel = await ask("Model ID [openrouter/auto]: ") || "openrouter/auto";
        providerSection = {
            active: "openrouter",
            openrouter: { api_key: openrouterKey, model: openrouterModel },
        };
    }

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
            reasoningSummaryModel = await ask("Summary model (blank = main model): ");
        }
    }

    const enableTomlAns = await ask(
        "Use TOML files (memory.toml, identity.toml) instead of markdown?\n" +
        "This is recommended for new agents, but shouldn't be used if you're migrating an existing agent to opoclaw. (y/N): "
    );
    const enableToml = enableTomlAns.toLowerCase() === "y";

    const basicToolsAns = await ask(
        "Enable read_file, edit_file, list_files tools? (sandboxed)\n" +
        "If disabled, the agent will still be able to use the shell to manipulate files. (Y/n): "
    );
    const basicTools = basicToolsAns.toLowerCase() !== "n";

    const toolCallSummaries = await askMCQ(
        "Tool call summaries: full (per-call messages), minimal (reaction + batch summary), off (reaction only)",
        ["full", "minimal", "off"] as const,
        "full"
    );

    // ── Tavily Search ──────────────────────────────────────────────────────

    const useTavilyAns = await ask("Use Tavily for web search instead of DuckDuckGo? (y/N): ");
    const useTavily = useTavilyAns.toLowerCase() === "y";
    let tavilyApiKey = "";
    if (useTavily) {
        tavilyApiKey = await ask("Tavily API key (tvly-...): ");
        if (!tavilyApiKey) {
            console.log(kleur.yellow("No Tavily key provided — falling back to DuckDuckGo."));
        }
    }

    // ── Build typed config ─────────────────────────────────────────────────

    header("Writing config");

    const config: OpoclawConfig = {
        enable_reasoning: enableReasoning,
        reasoning_summary: reasoningSummary,
        use_toml_files: enableToml,
        basic_tools: basicTools,
        channel: {
            discord: {
                enabled: true,
                token: discordToken,
                allow_bots: allowBots,
            },
        },
        provider: providerSection,
        ...(reasoningSummaryModel ? { reasoning_summary_model: reasoningSummaryModel } : {}),
        ...(authorizedUserId ? { authorized_user_id: authorizedUserId } : {}),
        ...(toolCallSummaries !== "full" ? { tool_call_summaries: toolCallSummaries } : {}),
        ...(useTavily && tavilyApiKey ? { search_provider: "tavily" as const, tavily_api_key: tavilyApiKey } : {}),
    };

    writeFileSync(CONFIG_FILE, TOML.stringify(config as TOML.JsonMap));
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

    console.log(`${kleur.green("opoclaw is ready.")}\n`);
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
