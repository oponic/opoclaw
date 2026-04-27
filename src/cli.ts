#!/usr/bin/env bun
/**
 * opoclaw CLI — entry point, delegates to cli/router.ts
 */

import { main } from "./cli/router.ts";
import { err } from "./cli/output.ts";

main().catch((e) => {
  err(e.message || String(e));
  process.exit(1);
});