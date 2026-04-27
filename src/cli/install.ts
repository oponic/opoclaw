import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { OP_DIR } from "../channels/shared.ts";
import { getOS } from "./gateway.ts";
import { exec } from "../utils.ts";
import { BIN_DIR, OPCLAW_BIN, OPCLAW_BIN_WIN } from "./paths.ts";
import { info, ok, warn, cmdStyle, value, chip } from "./output.ts";

export function installCommand() {
  info("Installing opoclaw command...");
  mkdirSync(BIN_DIR, { recursive: true });

  if (getOS() === "windows") {
    const wrapper = `@echo off\r\nbun run "${resolve(import.meta.dir, "../cli.ts")}" %*\r\n`;
    writeFileSync(OPCLAW_BIN_WIN, wrapper);
    ok(`opoclaw command installed to ${OPCLAW_BIN_WIN}`);
  } else {
    const wrapper = `#!/bin/bash\nbun run "${resolve(import.meta.dir, "../cli.ts")}" "$@"\n`;
    writeFileSync(OPCLAW_BIN, wrapper);
    exec(`chmod +x ${OPCLAW_BIN}`);
    ok(`opoclaw command installed to ${OPCLAW_BIN}`);
  }

  const path = process.env.PATH || "";
  if (!path.includes(BIN_DIR)) {
    warn(`${BIN_DIR} is not in your PATH.`);
    console.log(`${chip("PATH", "yellow")}`);
    if (getOS() === "windows") {
      console.log(`  ${value("Add")} ${cmdStyle(BIN_DIR)} ${value("to your PATH environment variable.")}`);
    } else {
      console.log(`  ${value("Add to .zshrc / .bashrc:")}`);
      console.log(`  ${cmdStyle(`export PATH="${BIN_DIR}:$PATH"` )}`);
    }
  }
}