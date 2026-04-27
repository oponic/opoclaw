import { existsSync, readFileSync } from "fs";
import kleur from "kleur";
import { USAGE_FILE } from "./paths.ts";
import { label, value, chip } from "./output.ts";

export async function showUsage() {
  if (!existsSync(USAGE_FILE)) {
    console.log(`${chip("USAGE 24H", "blue")}\n`);
    console.log(`  ${label("No usage data yet.")}`);
    return;
  }

  const data = JSON.parse(readFileSync(USAGE_FILE, "utf-8"));
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const recent = data.sessions.filter((s: any) => new Date(s.timestamp).getTime() > dayAgo);

  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  for (const s of recent) {
    input += s.input || 0;
    output += s.output || 0;
    cacheRead += s.cacheRead || 0;
    cacheWrite += s.cacheWrite || 0;
    cost += s.cost || 0;
  }

  console.log(`\n${chip("USAGE 24H", "blue")}\n`);
  console.log(`  ${label("Requests:")}    ${value(String(recent.length))}`);
  console.log(`  ${label("Input:")}       ${value(`${(input / 1000).toFixed(1)}k tokens`)}`);
  console.log(`  ${label("Output:")}      ${value(`${(output / 1000).toFixed(1)}k tokens`)}`);
  console.log(`  ${label("Cache read:")}  ${value(`${(cacheRead / 1000).toFixed(1)}k tokens`)}`);
  console.log(`  ${label("Cache write:")} ${value(`${(cacheWrite / 1000).toFixed(1)}k tokens`)}`);
  console.log(`  ${label("Cost:")}        ${kleur.green().bold(`$${cost.toFixed(4)}`)}`);

  console.log(`\n${chip("ALL-TIME", "cyan")}\n`);
  console.log(`  ${label("Total cost:")}  ${kleur.green().bold(`$${data.total.cost.toFixed(4)}`)}`);
  console.log(`  ${label("Total reqs:")}  ${value(String(data.sessions.length))}`);
  console.log();
}