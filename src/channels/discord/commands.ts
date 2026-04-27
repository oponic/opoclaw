import { REST, Routes, Events } from "discord.js";
import { client } from "./index.ts";
import { loadConfig, getModelId, getActiveProvider } from "../../config.ts";
import { exec } from "../../utils.ts";
import { OP_DIR } from "../shared.ts";

const VERSION = exec("git describe --tags --abbrev=0 2>/dev/null || echo ''", { cwd: OP_DIR });

export async function registerSlashCommands(discordCfg: any): Promise<void> {
    const rest = new REST({ version: "10" }).setToken(discordCfg.token!);
    try {
        await rest.put(
            Routes.applicationCommands(client.user!.id),
            {
                body: [
                    {
                        name: "about",
                        description: "About this bot",
                    },
                    {
                        name: "info",
                        description: "Show information on this claw",
                        options: [
                            {
                                name: "type",
                                type: 3,
                                description: "on what",
                                required: true,
                                choices: [
                                    { name: "model", value: "model" },
                                    { name: "provider", value: "provider" },
                                ],
                            },
                        ],
                    },
                ],
            },
        );
        console.log("[gateway] Registered slash commands");
    } catch (e) {
        console.error("[gateway] Failed to register slash commands:", e);
    }
}

export async function handleSlashCommand(interaction: any): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const tag = VERSION.toLowerCase();
    let releaseBadge = "";
    if (tag.includes("alpha")) releaseBadge = '\u001b[42m alpha \u001b[0m';
    else if (tag.includes("beta")) releaseBadge = '\u001b[41m beta \u001b[0m';
    else if (tag.includes("rc")) releaseBadge = '\u001b[45m rc \u001b[0m';

    if (interaction.commandName === "about") {
        const about = `
\`\`\`ansi
 
 ▄▄███▀                      ▀█              
 ▀▀▄▄▄█▄  ▄▀▀▄ ▄▀▀▄ ▄▀▀▄ ▄▀▀▀ █  ▀▀▀▄ █ █ █  ${releaseBadge}
   █████  ▀▄▄▀ █▄▄▀ ▀▄▄▀ ▀▄▄▄ █▄ ████ ▀▄▀▄▀
    ▀▀▀        █

\u001b[1mopoclaw ${VERSION}\u001b[0m
Lightweight Bun AI agent framework
\u001b[34mhttps://github.com/oponic/opoclaw\u001b[0m
\u001b[30moponic + others, 2026\u001b[0m

\`\`\`
            `;
        await interaction.reply(about);
    }

    if (interaction.commandName === "info") {
        const type = interaction.options.getString("type");
        const config = await loadConfig();
        if (type === "model") {
            const modelId = getModelId(config);
            const provider = getActiveProvider(config);
            await interaction.reply(`**Model:** \`${modelId}\``);
        } else if (type === "provider") {
            const provider = getActiveProvider(config);
            await interaction.reply(`**Provider:** \`${provider}\``);
        }
    }
}