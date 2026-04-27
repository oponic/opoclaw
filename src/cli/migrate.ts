import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { OP_DIR } from "../channels/shared.ts";
import { formatTOMLValue, parseTOML, toTOML } from "../config.ts";
import { info, ok, warn, value, cmdStyle, chip } from "./output.ts";

export function migrate() {
  const jsonPath = resolve(OP_DIR, "config.json");
  const tomlPath = resolve(OP_DIR, "config.toml");

  if (!existsSync(jsonPath)) {
    warn("No config.json found — nothing to migrate.");
    return;
  }

  if (existsSync(tomlPath)) {
    warn("config.toml already exists.");
    const backupPath = jsonPath + ".bak";
    writeFileSync(backupPath, readFileSync(jsonPath));
    ok("Backed up config.json → config.json.bak");
    return;
  }

  info("Reading config.json...");
  const jsonConfig = JSON.parse(readFileSync(jsonPath, "utf-8"));

  info("Converting to TOML...");
  let toml = "";
  for (const [key, value] of Object.entries(jsonConfig)) {
    toml += `${key} = ${formatTOMLValue(value)}\n`;
  }

  writeFileSync(tomlPath, toml);
  ok(`Wrote config.toml`);

  const backupPath = jsonPath + ".bak";
  writeFileSync(backupPath, readFileSync(jsonPath));
  unlinkSync(jsonPath);
  ok("config.json backed up → config.json.bak and removed");

  console.log(`\n${chip("MIGRATION", "cyan")}`);
  console.log(`  ${value("Your config is now at:")} ${cmdStyle(tomlPath)}`);
  console.log(`  ${value("Old config backed up at:")} ${cmdStyle(backupPath)}\n`);
}

export function migrateLessVerboseTools() {
  const tomlPath = resolve(OP_DIR, "config.toml");
  if (!existsSync(tomlPath)) return;

  const raw = readFileSync(tomlPath, "utf-8");
  const parsed = parseTOML(raw);

  const hasLessVerbose = "less_verbose_tools" in parsed;
  if (!hasLessVerbose) {
    return;
  }

  const value = parsed.less_verbose_tools;
  const next: any = { ...parsed };
  delete next.less_verbose_tools;

  if (value === true) {
    next.tool_call_summaries = "minimal";
    info(`less_verbose_tools = true → tool_call_summaries = "minimal"`);
  } else {
    info(`less_verbose_tools = false → removed (default is "full")`);
  }

  const backupPath = tomlPath + ".bak";
  writeFileSync(backupPath, raw);
  writeFileSync(tomlPath, toTOML(next));
  ok(`Migrated less_verbose_tools → tool_call_summaries. Backup at config.toml.bak`);
}

const CAMEL_TO_SNAKE: Record<string, string> = {
  discordToken: "discord_token",
  openrouterKey: "openrouter_key",
  openrouterModel: "openrouter_model",
  allowBots: "allow_bots",
  enableReasoning: "enable_reasoning",
  reasoningSummary: "reasoning_summary",
  reasoningSummaryModel: "reasoning_summary_model",
  notifyChannel: "notify_channel",
};

export function migrateToSnakeCase() {
  const tomlPath = resolve(OP_DIR, "config.toml");
  if (!existsSync(tomlPath)) {
    warn("No config.toml found — nothing to migrate.");
    return;
  }

  let text = readFileSync(tomlPath, "utf-8");
  let changed = false;

  for (const [camel, snake] of Object.entries(CAMEL_TO_SNAKE)) {
    const regex = new RegExp(`^\\s*${camel}(\\s*=)`, "gm");
    if (regex.test(text)) {
      text = text.replace(regex, `${snake}$1`);
      changed = true;
      info(`  ${camel} → ${snake}`);
    }
  }

  if (!changed) {
    ok("Config.toml already uses snake_case keys.");
    return;
  }

  const backupPath = tomlPath + ".bak";
  writeFileSync(backupPath, readFileSync(tomlPath));
  writeFileSync(tomlPath, text);
  ok("Migrated camelCase → snake_case. Backup at config.toml.bak");
}

export function migrateToSectionedConfig() {
  const tomlPath = resolve(OP_DIR, "config.toml");
  if (!existsSync(tomlPath)) {
    warn("No config.toml found — nothing to migrate.");
    return;
  }

  const raw = readFileSync(tomlPath, "utf-8");
  const parsed = parseTOML(raw);

  const alreadySectioned =
    typeof parsed?.channel === "object" ||
    typeof parsed?.provider === "object";
  if (alreadySectioned) {
    ok("Config.toml already uses sectioned channel/provider layout.");
    return;
  }

  const next: any = { ...parsed };

  const discordToken = parsed.discord_token;
  const allowBots = parsed.allow_bots;
  const notifyChannel = parsed.notify_channel;

  const providerActive = parsed.provider || "openrouter";

  next.channel = next.channel || {};
  next.channel.discord = {
    enabled: true,
    token: discordToken,
    allow_bots: allowBots,
    notify_channel: notifyChannel,
  };

  next.provider = {
    active: providerActive,
    openrouter: {
      api_key: parsed.openrouter_key,
      model: parsed.openrouter_model,
    },
    ollama: parsed.ollama,
    custom: parsed.custom,
  };

  delete next.discord_token;
  delete next.allow_bots;
  delete next.notify_channel;
  delete next.openrouter_key;
  delete next.openrouter_model;
  delete next.ollama;
  delete next.custom;

  const backupPath = tomlPath + ".sectioned.bak";
  writeFileSync(backupPath, raw);
  writeFileSync(tomlPath, toTOML(next));
  ok("Migrated to sectioned [channel.*] and [provider.*]. Backup at config.toml.sectioned.bak");
}