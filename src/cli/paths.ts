import { resolve } from "path";
import { homedir } from "os";
import { OP_DIR } from "../channels/shared.ts";

export const USAGE_FILE = resolve(OP_DIR, "usage.json");
export const WORKSPACE_DIR = resolve(OP_DIR, "workspace");
export const BIN_DIR = `${homedir()}/.local/bin`;
export const OPCLAW_BIN = `${BIN_DIR}/opoclaw`;
export const OPCLAW_BIN_WIN = `${BIN_DIR}/opoclaw.cmd`;
export const LOCK_FILE = resolve(OP_DIR, ".gateway.lock");
export const HIBERNATE_FILE = resolve(OP_DIR, ".gateway.hibernate");
export const CORE_URL = "http://127.0.0.1:6112";

export const PLIST_NAME = "com.oponic.opoclaw.plist";
export const PLIST_PATH_LA = `${homedir()}/Library/LaunchAgents/${PLIST_NAME}`;
export const SYSTEMD_NAME = "opoclaw.service";
export const SYSTEMD_PATH = `/etc/systemd/system/${SYSTEMD_NAME}`;