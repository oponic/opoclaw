import { loadConfig } from "../../config.ts";
import { clearGatewayPid, setGatewayPid, CORE_HOST, CORE_PORT, handleCoreRequest } from "./server.ts";
import { startDiscord } from "../discord/index.ts";
import { startIRC } from "../irc.ts";
import { startOpenAI } from "../openai.ts";

export async function startCore() {
    setGatewayPid(process.pid);

    const cleanup = () => clearGatewayPid();
    process.on("exit", cleanup);
    process.on("SIGTERM", () => {
        cleanup();
        process.exit(0);
    });
    process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
    });

    const server = Bun.serve({
        hostname: CORE_HOST,
        port: CORE_PORT,
        fetch: handleCoreRequest,
    });

    console.log(`[core] Control server listening on http://${CORE_HOST}:${server.port}`);

    try {
        await startDiscord();
    } catch (err: any) {
        console.error(`Discord channel failed to start: ${err.message}`);
        throw err;
    }

    try {
        await startIRC();
    } catch (err: any) {
        console.error(`IRC channel failed to start: ${err.message}`);
    }

    try {
        await startOpenAI();
    } catch (err: any) {
        console.error(`OpenAI channel failed to start: ${err.message}`);
        throw err;
    }

    return server;
}