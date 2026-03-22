import { startDiscord } from "./channels/discord.ts";
import { startIRC } from "./channels/irc.ts";

// Start enabled channels with error handling
try {
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
