import { startCore } from "./channels/core/index.ts";

try {
    await startCore();
} catch (err: any) {
    console.error(`Core channel failed to start: ${err.message}`);
    process.exit(1);
}
