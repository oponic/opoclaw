import { homedir } from "os";

export function getDenoBinary(): string {
    return process.env.DENO_BIN || `${homedir()}/.deno/bin/deno`;
}

export function assertDenoAvailable(): void {
    try {
        const processResult = Bun.spawnSync({ cmd: [getDenoBinary(), "--version"], stdout: "pipe", stderr: "pipe" });
        if (processResult.exitCode === 0) return;
    } catch {
    }
    throw new Error(`Deno is required but unavailable at ${getDenoBinary()}. Install it with: curl -fsSL https://deno.land/install.sh | sh`);
}
