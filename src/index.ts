import { startDiscord } from "./channels/discord.ts";
import { startIRC } from "./channels/irc.ts";

console.log("Starting gateway channels...");

// Keep process alive
const keepAlive = setInterval(() => {}, 60_000);

// Start enabled channels with error handling
try {
    await startDiscord();
    console.log("Discord channel started");
} catch (err: any) {
    console.error(`Discord channel failed to start: ${err.message}`);
    // Exit with error code to indicate failure
    process.exit(1);
}

try {
    await startIRC();
    console.log("IRC channel started");
} catch (err: any) {
    console.error(`IRC channel failed to start: ${err.message}`);
    // Don't exit if only IRC fails, but log error
}

console.log("All channels started. Gateway running.");
