import { startDiscord } from "./channels/discord.ts";
import { startIRC } from "./channels/irc.ts";
import { loadConfig } from "./config.ts";
import { loadPlugins } from "./plugins.ts";

type ChannelStarter = {
    name: string;
    enabled: boolean;
    required: boolean;
    start: () => Promise<void>;
};

function buildChannelStarters() {
    const config = loadConfig();
    return {
        config,
        starters: [
            {
                name: "Discord",
                enabled: config.channel?.discord?.enabled ?? false,
                required: true,
                start: startDiscord,
            },
            {
                name: "IRC",
                enabled: config.channel?.irc?.enabled ?? false,
                required: false,
                start: startIRC,
            },
        ] satisfies ChannelStarter[],
    };
}

async function main(): Promise<void> {
    const { config, starters } = buildChannelStarters();
    await loadPlugins(config);

    for (const starter of starters) {
        if (!starter.enabled) {
            continue;
        }

        try {
            await starter.start();
        } catch (error: any) {
            console.error(`${starter.name} channel failed to start: ${error?.message || error}`);
            if (starter.required) {
                process.exit(1);
            }
        }
    }
}

await main();
