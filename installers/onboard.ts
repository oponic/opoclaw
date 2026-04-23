#!/usr/bin/env bun

import { dirname, resolve } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { fileURLToPath } from "url";

const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIR = resolve(ROOT_DIR, "workspace");
const CONFIG_FILE = resolve(ROOT_DIR, "config.toml");

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

const DEFAULT_AGENTS_TOML = `# <filename> - workspace instructions
every_session = [
  "Read soul.toml",
  "Read identity.toml",
  "Read memory.toml",
]

[memory]
daily_notes = "memory/YYYY-MM-DD.md"
long_term = "memory.toml"

[safety]
rules = [
  "Don't exfiltrate private data.",
  "Don't run destructive commands without asking.",
  "Prefer trash over rm when possible.",
]

[group_chats]
guidance = "Participate, don't dominate. Respond when you can add value."
`;

const DEFAULT_SOUL_MD = `# <filename> - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the filler, just help.

**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring.

**Be resourceful before asking.** Try to figure it out first.

**Earn trust through competence.** Be careful with external actions. Be bold with internal ones.

## Boundaries

- Private things stay private.
- When in doubt, ask before acting externally.
- You're not the user's voice. Be careful in group chats.

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
  "You're not the user's voice. Be careful in group chats.",
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
name = ""
creature = ""
vibe = ""
emoji = ""
avatar = ""
`;

const DEFAULT_MEMORY_MD = `# <filename> - Long-Term Memory

_Curated memories, distilled from daily logs._
`;

const DEFAULT_MEMORY_TOML = `# <filename> - long-term memory
notes = []
`;

const DEFAULT_HEARTBEAT_MD = `# <filename>

_(Optional — add a short checklist of things to check during heartbeats.)_
`;

const DEFAULT_HEARTBEAT_TOML = `# <filename> - things to check periodically
tasks = []
`;

type Provider = "openrouter" | "ollama" | "custom";
type SearchProvider = "duckduckgo" | "tavily";
type ToolSummaryMode = "full" | "minimal" | "off";

type Answers = {
    provider: Provider;
    searchProvider: SearchProvider;
    useToml: boolean;
    enableDiscord: boolean;
    discordToken: string;
    allowBots: boolean;
    authorizedUserId: string;
    enableReasoning: boolean;
    reasoningSummary: boolean;
    reasoningSummaryModel: string;
    basicTools: boolean;
    advancedTools: boolean;
    enableWebFetch: boolean;
    toolCallSummaries: ToolSummaryMode;
    openrouterKey: string;
    openrouterModel: string;
    ollamaBaseUrl: string;
    ollamaModel: string;
    customApiType: "openai" | "anthropic";
    customBaseUrl: string;
    customApiKey: string;
    customModel: string;
    customAnthropicVersion: string;
    customMaxTokens: string;
    tavilyApiKey: string;
};

function header(message: string): void {
    console.log(`\n${BOLD}═══ ${message} ═══${RESET}\n`);
}

function info(message: string): void {
    console.log(`${CYAN}[opoclaw]${RESET} ${message}`);
}

function ok(message: string): void {
    console.log(`${GREEN}[✓]${RESET} ${message}`);
}

function warn(message: string): void {
    console.log(`${YELLOW}⚠${RESET} ${message}`);
}

function createPrompter() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const ask = (prompt: string): Promise<string> =>
        new Promise((resolvePrompt) => {
            rl.question(`${CYAN}${prompt}${RESET}`, (answer) => resolvePrompt(answer.trim()));
        });

    const askRequired = async (prompt: string): Promise<string> => {
        while (true) {
            const value = await ask(prompt);
            if (value) {
                return value;
            }
            warn("This value is required.");
        }
    };

    const askWithDefault = async (prompt: string, fallback: string): Promise<string> => {
        const value = await ask(`${prompt} [${fallback}]: `);
        return value || fallback;
    };

    const askYesNo = async (prompt: string, fallback: boolean): Promise<boolean> => {
        const suffix = fallback ? "Y/n" : "y/N";
        while (true) {
            const value = (await ask(`${prompt} (${suffix}): `)).toLowerCase();
            if (!value) {
                return fallback;
            }
            if (value === "y" || value === "yes") {
                return true;
            }
            if (value === "n" || value === "no") {
                return false;
            }
            warn("Please answer y or n.");
        }
    };

    const close = () => rl.close();

    return { ask, askRequired, askWithDefault, askYesNo, close };
}

function escapeTomlString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function replaceFilename(template: string, filename: string): string {
    return template.replaceAll("<filename>", filename);
}

function maybeWriteFile(path: string, content: string): void {
    if (existsSync(path)) {
        info(`Skipped ${path.replace(`${WORKSPACE_DIR}/`, "")} (already exists)`);
        return;
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    ok(`Created ${path.replace(`${WORKSPACE_DIR}/`, "")}`);
}

function buildConfig(answers: Answers): string {
    const lines: string[] = [];

    lines.push(`enable_reasoning = ${answers.enableReasoning}`);
    lines.push(`reasoning_summary = ${answers.reasoningSummary}`);
    lines.push(`use_toml_files = ${answers.useToml}`);
    lines.push(`basic_tools = ${answers.basicTools}`);
    lines.push(`advanced_tools = ${answers.advancedTools}`);
    lines.push(`enable_web_fetch = ${answers.enableWebFetch}`);
    lines.push(`enable_plugins = false`);
    lines.push(`plugin_dir = "workspace/plugins"`);

    if (answers.authorizedUserId) {
        lines.push(`authorized_user_id = ${escapeTomlString(answers.authorizedUserId)}`);
    }
    if (answers.reasoningSummaryModel) {
        lines.push(`reasoning_summary_model = ${escapeTomlString(answers.reasoningSummaryModel)}`);
    }
    if (answers.toolCallSummaries !== "full") {
        lines.push(`tool_call_summaries = "${answers.toolCallSummaries}"`);
    }
    if (answers.searchProvider === "tavily" && answers.tavilyApiKey) {
        lines.push(`search_provider = "tavily"`);
        lines.push(`tavily_api_key = ${escapeTomlString(answers.tavilyApiKey)}`);
    }

    lines.push("");
    lines.push("[channel.discord]");
    lines.push(`enabled = ${answers.enableDiscord}`);
    if (answers.discordToken) {
        lines.push(`token = ${escapeTomlString(answers.discordToken)}`);
    }
    lines.push(`allow_bots = ${answers.allowBots}`);

    lines.push("");
    lines.push("[provider]");
    lines.push(`active = "${answers.provider}"`);

    if (answers.openrouterKey || answers.openrouterModel !== "openrouter/auto") {
        lines.push("");
        lines.push("[provider.openrouter]");
        if (answers.openrouterKey) {
            lines.push(`api_key = ${escapeTomlString(answers.openrouterKey)}`);
        }
        lines.push(`model = ${escapeTomlString(answers.openrouterModel)}`);
    }

    if (answers.provider === "ollama") {
        lines.push("");
        lines.push("[provider.ollama]");
        lines.push(`base_url = ${escapeTomlString(answers.ollamaBaseUrl)}`);
        lines.push(`model = ${escapeTomlString(answers.ollamaModel)}`);
    }

    if (answers.provider === "custom") {
        lines.push("");
        lines.push("[provider.custom]");
        lines.push(`base_url = ${escapeTomlString(answers.customBaseUrl)}`);
        if (answers.customApiKey) {
            lines.push(`api_key = ${escapeTomlString(answers.customApiKey)}`);
        }
        lines.push(`model = ${escapeTomlString(answers.customModel)}`);
        lines.push(`api_type = "${answers.customApiType}"`);
        if (answers.customApiType === "anthropic") {
            lines.push(`anthropic_version = ${escapeTomlString(answers.customAnthropicVersion)}`);
            lines.push(`max_tokens = ${Number.parseInt(answers.customMaxTokens, 10) || 1024}`);
        }
    }

    return `${lines.join("\n")}\n`;
}

function scaffoldWorkspace(useToml: boolean): void {
    mkdirSync(resolve(WORKSPACE_DIR, "memory", "sessions"), { recursive: true });
    mkdirSync(resolve(WORKSPACE_DIR, "skills"), { recursive: true });
    mkdirSync(resolve(WORKSPACE_DIR, "plugins"), { recursive: true });
    mkdirSync(resolve(WORKSPACE_DIR, "config"), { recursive: true });
    ok("Created workspace directories");

    const sharedFiles = useToml
        ? {
              "config/agents.toml": DEFAULT_AGENTS_TOML,
              "config/soul.toml": DEFAULT_SOUL_TOML,
              "config/identity.toml": DEFAULT_IDENTITY_TOML,
              "config/memory.toml": DEFAULT_MEMORY_TOML,
              "heartbeat.toml": DEFAULT_HEARTBEAT_TOML,
          }
        : {
              "config/AGENTS.md": DEFAULT_AGENTS_MD,
              "config/SOUL.md": DEFAULT_SOUL_MD,
              "config/IDENTITY.md": DEFAULT_IDENTITY_MD,
              "config/MEMORY.md": DEFAULT_MEMORY_MD,
              "HEARTBEAT.md": DEFAULT_HEARTBEAT_MD,
          };

    for (const [relativePath, content] of Object.entries(sharedFiles)) {
        const absolutePath = resolve(WORKSPACE_DIR, relativePath);
        maybeWriteFile(absolutePath, replaceFilename(content, relativePath.split("/").pop() || relativePath));
    }

    const exampleDir = resolve(WORKSPACE_DIR, "plugins", "example-echo-plugin");
    if (!existsSync(exampleDir)) {
        mkdirSync(exampleDir, { recursive: true });
        writeFileSync(
            resolve(exampleDir, "plugin.json"),
            JSON.stringify(
                {
                    name: "example-echo-plugin",
                    version: "0.1.0",
                    entry: "plugin.ts",
                    description: "Example plugin: registers one tool named example_echo.",
                },
                null,
                2,
            ),
            "utf-8",
        );
        writeFileSync(
            resolve(exampleDir, "plugin.ts"),
            `export const tools = [
  {
    type: "function",
    function: {
      name: "example_echo",
      description: "Echo input text.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to echo back." }
        },
        required: ["text"]
      }
    }
  }
];

export async function invoke(name, args) {
  if (name === "example_echo") {
    return String(args?.text || "");
  }
  throw new Error("Unknown tool: " + String(name));
}

export async function deactivate() {}
`,
            "utf-8",
        );
        ok("Created example plugin scaffold");
    } else {
        info("Skipped example plugin scaffold (already exists)");
    }
}

async function collectAnswers(): Promise<Answers> {
    const prompt = createPrompter();
    try {
        const providerRaw = (await prompt.askWithDefault("Provider", "openrouter")).toLowerCase();
        const provider: Provider =
            providerRaw === "ollama" ? "ollama" : providerRaw === "custom" ? "custom" : "openrouter";

        const enableDiscord = await prompt.askYesNo("Enable Discord", true);
        const discordToken = enableDiscord
            ? await prompt.askRequired("Discord bot token: ")
            : "";

        const openrouterKey =
            provider === "openrouter" ? await prompt.askRequired("OpenRouter API key: ") : "";
        const openrouterModel =
            provider === "openrouter"
                ? await prompt.askWithDefault("OpenRouter model", "openrouter/auto")
                : "openrouter/auto";

        const ollamaBaseUrl =
            provider === "ollama"
                ? await prompt.askWithDefault("Ollama base URL", "http://localhost:11434")
                : "http://localhost:11434";
        const ollamaModel =
            provider === "ollama"
                ? await prompt.askWithDefault("Ollama model", "llama3.2")
                : "llama3.2";

        let customApiType: "openai" | "anthropic" = "openai";
        let customBaseUrl = "";
        let customApiKey = "";
        let customModel = "";
        let customAnthropicVersion = "2023-06-01";
        let customMaxTokens = "1024";

        if (provider === "custom") {
            const customApiTypeRaw = (await prompt.askWithDefault("Custom API type", "openai")).toLowerCase();
            customApiType = customApiTypeRaw === "anthropic" ? "anthropic" : "openai";
            customBaseUrl =
                customApiType === "anthropic"
                    ? await prompt.askWithDefault("Anthropic base URL", "https://api.anthropic.com")
                    : await prompt.askRequired("Custom base URL (no trailing /v1/chat/completions): ");
            customApiKey = await prompt.ask("Custom API key (leave blank if none): ");
            customModel = await prompt.askRequired("Custom model name: ");
            if (customApiType === "anthropic") {
                customAnthropicVersion = await prompt.askWithDefault("Anthropic version", "2023-06-01");
                customMaxTokens = await prompt.askWithDefault("Max output tokens", "1024");
            }
        }

        const allowBots = await prompt.askYesNo("Allow bot-to-bot responses", false);
        const authorizedUserId = await prompt.ask("Authorized user ID for approvals (optional): ");
        const enableReasoning = await prompt.askYesNo("Enable model reasoning", true);
        const reasoningSummary = enableReasoning
            ? await prompt.askYesNo("Enable reasoning summaries", false)
            : false;
        const reasoningSummaryModel = reasoningSummary
            ? await prompt.ask("Reasoning summary model (blank = main model): ")
            : "";
        const useToml = await prompt.askYesNo("Use TOML workspace files", true);
        const basicTools = await prompt.askYesNo("Enable read_file/edit_file/list_files tools", true);
        const advancedTools = await prompt.askYesNo("Enable mkdir/rm/mv/cp tools", false);
        const enableWebFetch = await prompt.askYesNo("Enable web_fetch tool", true);

        const summaryRaw = (await prompt.askWithDefault("Tool call summaries [full|minimal|off]", "full")).toLowerCase();
        const toolCallSummaries: ToolSummaryMode =
            summaryRaw === "minimal" || summaryRaw === "off" ? summaryRaw : "full";

        const searchProviderRaw = (await prompt.askWithDefault("Search provider", "duckduckgo")).toLowerCase();
        const searchProvider: SearchProvider = searchProviderRaw === "tavily" ? "tavily" : "duckduckgo";
        const tavilyApiKey =
            searchProvider === "tavily" ? await prompt.askRequired("Tavily API key: ") : "";

        return {
            provider,
            searchProvider,
            useToml,
            enableDiscord,
            discordToken,
            allowBots,
            authorizedUserId,
            enableReasoning,
            reasoningSummary,
            reasoningSummaryModel,
            basicTools,
            advancedTools,
            enableWebFetch,
            toolCallSummaries,
            openrouterKey,
            openrouterModel,
            ollamaBaseUrl,
            ollamaModel,
            customApiType,
            customBaseUrl,
            customApiKey,
            customModel,
            customAnthropicVersion,
            customMaxTokens,
            tavilyApiKey,
        };
    } finally {
        prompt.close();
    }
}

async function main(): Promise<void> {
    header("opoclaw onboarding wizard");
    console.log("This wizard sets up config.toml and a starter workspace.\n");

    const answers = await collectAnswers();

    header("Writing config");
    writeFileSync(CONFIG_FILE, buildConfig(answers), "utf-8");
    ok(`Wrote ${CONFIG_FILE}`);

    header("Setting up workspace");
    scaffoldWorkspace(answers.useToml);

    header("All done");
    console.log(`${GREEN}opoclaw is ready.${RESET}\n`);
    console.log("Next steps:");
    console.log(`  1. Review ${CONFIG_FILE}`);
    console.log(`  2. Fill in ${resolve(WORKSPACE_DIR, "config")}`);
    console.log("  3. Run: bun run src/index.ts");
    if (answers.enableDiscord) {
        console.log("  4. Mention your bot in Discord to test");
    }
    console.log("");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
