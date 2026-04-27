import { existsSync, readFileSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import kleur from "kleur";
import { OP_DIR } from "../channels/shared.ts";
import { checkForUpdate } from "../utils.ts";
import {
  LOCK_FILE,
  HIBERNATE_FILE,
  CORE_URL,
} from "./paths.ts";
import { info, ok, warn, err } from "./output.ts";

export function getOS(): "macos" | "linux" | "windows" {
  const p = process.platform;
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  return "linux";
}

function getGatewayPID(): number | null {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    const pid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function setGatewayPID(pid: number) {
  writeFileSync(LOCK_FILE, String(pid));
}

function clearGatewayPID() {
  try { require("fs").unlinkSync(LOCK_FILE); } catch {}
}

export async function requestCore(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`${CORE_URL}${path}`, init);
  } catch {
    return null;
  }
}

async function getCoreStatus(): Promise<any | null> {
  const res = await requestCore("/health");
  if (!res?.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function gatewayStart() {
  const core = await getCoreStatus();
  if (core?.ok) {
    warn(`Gateway already running (PID ${core.pid})`);
    return;
  }

  const pid = getGatewayPID();
  if (pid) {
    warn(`Gateway already running (PID ${pid})`);
    return;
  }

  const newVersion = await checkForUpdate(true);
  if (newVersion) {
    warn(`Update available: ${newVersion}`);
  }

  info("Starting gateway...");

  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: OP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.unref();
  setGatewayPID(child.pid!);

  child.stdout?.on("data", (d: Buffer) => {
    process.stdout.write(`${kleur.cyan("[gateway]")} ${d}`);
  });
  child.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`${kleur.cyan("[gateway]")} ${d}`);
  });

  let childExited = false;
  let exitCode: number | null = null;
  child.on("exit", (code) => {
    childExited = true;
    exitCode = code;
    clearGatewayPID();
    if (code !== 0) {
      err(`Gateway exited with code ${code}`);
    }
  });

  setTimeout(() => {
    if (childExited) {
      err(`Gateway failed to start (exit code ${exitCode})`);
    } else if (getGatewayPID()) {
      ok(`Gateway running (PID ${child.pid})`);
    }
  }, 2000);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isProcessAlive(pid);
}

export async function gatewayStop() {
  const coreRes = await requestCore("/control/stop", { method: "POST" });
  if (coreRes?.ok) {
    const pid = getGatewayPID();
    if (pid) {
      await waitForExit(pid, 4000);
    }
    clearGatewayPID();
    ok("Gateway stopped");
    return;
  }

  const pid = getGatewayPID();
  if (!pid) {
    warn("Gateway not running");
    return;
  }

  info(`Stopping gateway (PID ${pid})...`);
  try {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }

    const stopped = await waitForExit(pid, 4000);
    if (!stopped) {
      warn("Gateway did not exit after SIGTERM, sending SIGKILL...");
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
      await waitForExit(pid, 2000);
    }

    if (isProcessAlive(pid)) {
      warn("Gateway process still alive after SIGKILL.");
    } else {
      ok("Gateway stopped");
    }
    clearGatewayPID();
  } catch (e: any) {
    err(`Failed to stop: ${e.message}`);
    clearGatewayPID();
  }
}

export async function gatewayRestart() {
  await gatewayStop();
  await new Promise((r) => setTimeout(r, 500));
  await gatewayStart();
}

export async function gatewayStatus() {
  const core = await getCoreStatus();
  if (core?.ok) {
    ok(`Gateway running (PID ${core.pid})`);
    if (core.hibernating) {
      warn("Gateway is hibernating");
    }
    return;
  }

  const pid = getGatewayPID();
  if (pid) {
    ok(`Gateway running (PID ${pid})`);
    return;
  }
  warn("Gateway not running");
}

export async function gatewayHibernate() {
  const coreRes = await requestCore("/control/hibernate", { method: "POST" });
  if (coreRes?.ok) {
    ok("Gateway hibernation enabled");
    return;
  }

  try {
    writeFileSync(HIBERNATE_FILE, new Date().toISOString());
    ok("Gateway hibernation enabled");
  } catch (e: any) {
    err(`Failed to enable hibernation: ${e.message}`);
  }
}