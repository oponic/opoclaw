import { startDiscord } from "./channels/discord.ts";
import { startIRC } from "./channels/irc.ts";

// Start enabled channels
await startDiscord();
await startIRC();
