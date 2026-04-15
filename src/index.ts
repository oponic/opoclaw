import { startDiscord } from "./channels/discord.ts";
import { startIRC } from "./channels/irc.ts";
import { loadPlugins } from "./plugins.ts";
import { loadConfig } from "./config.ts";

// Start enabled channels with error handling
try {
    const cfg = loadConfig();
    await loadPlugins(cfg);

    await startDiscord();
} catch (err: any) {
    console.error(`Discord channel failed to start: ${err.message}`);
    // Exit with error code to indicate failure
    process.exit(1);
}

try {
    await startIRC();
} catch (err: any) {
    console.error(`IRC channel failed to start: ${err.message}`);
    // Don't exit if only IRC fails, but log error
}
