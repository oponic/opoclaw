import { exec } from "../utils.ts";
import { OP_DIR } from "../channels/shared.ts";
import { getConfigPath } from "../config.ts";
import { checkForUpdate, doUpdate } from "../utils.ts";
import { banner, cmdStyle, subtle, label, value, chip, err } from "./output.ts";
import { showUsage } from "./usage.ts";
import { gatewayStart, gatewayStop, gatewayRestart, gatewayHibernate, gatewayStatus } from "./gateway.ts";
import { installService, uninstallService, fullUninstall } from "./service.ts";
import { chatTui } from "./chat.ts";
import { migrate, migrateToSnakeCase, migrateToSectionedConfig, migrateLessVerboseTools } from "./migrate.ts";
import { installCommand } from "./install.ts";
import { WORKSPACE_DIR, USAGE_FILE } from "./paths.ts";

export async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case "usage":
      await showUsage();
      break;

    case "gateway": {
      const sub = args[1];
      switch (sub) {
        case "start":   await gatewayStart(); break;
        case "stop":    await gatewayStop(); break;
        case "restart": await gatewayRestart(); break;
        case "hibernate": await gatewayHibernate(); break;
        case "status":  await gatewayStatus(); break;
        default:
          console.log(`${label("Usage:")} ${cmdStyle("opoclaw gateway {start|stop|restart|hibernate|status}")}`);
      }
      break;
    }

    case "update":
      await doUpdate(args[1] === "unstable" ? "unstable" : undefined, gatewayRestart);
      break;

    case "check-update":
      await checkForUpdate(false);
      break;

    case "install":
      installCommand();
      if (args[2] === "--service" || args[2] === "--daemon") {
        installService();
      }
      break;

    case "uninstall":
      fullUninstall();
      break;

    case "service": {
      const svcCmd = args[1];
      if (svcCmd === "install") installService();
      else if (svcCmd === "remove") uninstallService();
      else console.log(`${label("Usage:")} ${cmdStyle("opoclaw service {install|remove}")}`);
      break;
    }

    case "migrate":
      migrate();
      migrateToSnakeCase();
      migrateToSectionedConfig();
      migrateLessVerboseTools();
      break;

    case "onboard":
      exec("bun run installers/onboard.ts", { cwd: OP_DIR });
      break;

    case "version":
    case "v":
      try {
        const tag = exec("git describe --tags --abbrev=0 2>/dev/null", { cwd: OP_DIR });
        console.log(`${chip("VERSION", "green")} ${cmdStyle(`opoclaw ${tag}`)}`);
      } catch {
        console.log(`${chip("VERSION", "yellow")} ${subtle("opoclaw (unknown version — no git tags found)")}`);
      }
      break;

    case "explainer":
    case "explain":
      console.log(`
${chip("EXPLAINER", "blue")}

${value("opoclaw is a Discord bot framework. When someone mentions the bot:")}

${label("1.")} ${cmdStyle("Message received")} — Discord event triggers the MessageCreate handler.
   Only messages that @mention the bot (or reply to it) are processed.
   Own messages are always ignored. Other bots are ignored unless
   channel.discord.allow_bots=true in config.toml.

${label("2.")} ${cmdStyle("System prompt loaded")} — Three workspace files are read and composed:
   - SOUL.md — personality, tone, rules, vibe
   - IDENTITY.md — name, appearance, self-description
   - AGENTS.md — operating instructions, memory system, safety rules
   These form the system prompt sent to the LLM.

${label("3.")} ${cmdStyle("Channel history")} — Last 50 messages in the channel are fetched,
   formatted as [name]: content, and sent as conversation context.

${label("4.")} ${cmdStyle("LLM call")} — The composed prompt + history is sent to the configured
   provider (OpenRouter, Ollama, or custom endpoint). The model generates
   a response. If reasoning is enabled, the model's thinking tokens are
   captured during streaming.

${label("5.")} ${cmdStyle("Tools")} — The model can request tool calls (file operations, etc.).
   Tools execute in a loop (max 20 iterations) until the model stops
   requesting them or sends a final text response.

${label("6.")} ${cmdStyle("Response sent")} — The reply is sent back to Discord, split into
   chunks if over 1990 characters.

${chip("SECURITY", "red")}

- ${label("No data exfiltration")} — workspace files (SOUL, IDENTITY, AGENTS,
  MEMORY) are sent to the LLM provider as part of the prompt. Do not
  put secrets in these files.
- ${label("Token safety")} — Discord token and API keys live in config.toml,
  never sent to the LLM or exposed in responses.
- ${label("Tool sandboxing")} — file tools only read from the workspace directory.
  The send_file tool reads workspace files and attaches them to messages.
- ${label("No system commands")} — the bot cannot run shell commands or access
  your filesystem outside the workspace.
- ${label("Rate limiting")} — max 20 agent iterations per message prevents
  runaway loops.

${chip("CONFIG", "cyan")}
${value("config.toml lives at the project root. Onboard wizard:")} ${cmdStyle("opoclaw onboard")}.
${value("Channels live under")} ${subtle("[channel.*]")}. ${value("Providers live under")} ${subtle("[provider.*]")}.
${value("Toggle:")} ${subtle("channel.discord.allow_bots, enable_reasoning, reasoning_summary")}.
`);
      break;

    case "chat":
      await chatTui();
      break;

    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(`
  ${banner()}
  
${chip("HELP", "blue")}
${cmdStyle("opoclaw")} — ${subtle("Lightweight AI agent framework")}

${chip("COMMANDS", "magenta")}
  ${cmdStyle("usage")}              ${subtle("Show token usage (last 24h) and cost")}
  ${cmdStyle("gateway start")}      ${subtle("Start the bot gateway")}
  ${cmdStyle("gateway stop")}       ${subtle("Stop the gateway")}
  ${cmdStyle("gateway restart")}    ${subtle("Restart the gateway")}
  ${cmdStyle("gateway hibernate")}  ${subtle("Hibernate the gateway (requires approval to wake)")}
  ${cmdStyle("gateway status")}     ${subtle("Check if gateway is running")}
  ${cmdStyle("update [unstable]")}  ${subtle("Pull latest release and restart (use unstable channel)")}
  ${cmdStyle("chat")}               ${subtle("Start interactive terminal chat (Core channel)")}
  ${cmdStyle("check-update")}       ${subtle("Check for available updates")}
  ${cmdStyle("install")}            ${subtle("Install opoclaw command + optional service")}
  ${cmdStyle("service install")}    ${subtle("Install auto-start service (systemd/launchd)")}
  ${cmdStyle("service remove")}     ${subtle("Remove auto-start service")}
  ${cmdStyle("uninstall")}          ${subtle("Remove command, service, and clean up")}
  ${cmdStyle("explainer")}          ${subtle("How opoclaw works")}
  ${cmdStyle("migrate")}            ${subtle("Upgrade config (JSON→TOML, camelCase→snake_case, sections)")}
  ${cmdStyle("onboard")}            ${subtle("Run onboarding wizard")}
  ${cmdStyle("version")}            ${subtle("Print current version (git tag)")}
  ${cmdStyle("help")}               ${subtle("Show this help")}

${chip("PATHS", "cyan")}
${label("Config:")}     ${value(getConfigPath())}
${label("Workspace:")}  ${value(WORKSPACE_DIR)}
${label("Usage:")}      ${value(USAGE_FILE)}
`);
      break;

    default:
      err(`Unknown command: ${cmd}`);
      console.log(`${subtle("Run")} ${cmdStyle("opoclaw help")} ${subtle("for usage.")}`);
      process.exit(1);
  }
}