import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import kleur from "kleur";
import type { ToolCall } from "../agent.ts";
import { runCoreChatTurn } from "../channels/core/chat.ts";
import { banner, cmdStyle, subtle, value, chip, okChip, errChip } from "./output.ts";
import type { ChipTone } from "./output.ts";

export async function chatTui() {
  const divider = () => console.log(subtle("─".repeat(72)));
  const section = (title: string, tone: ChipTone = "magenta") => console.log(`${chip(title, tone)} ${subtle("─".repeat(48))}`);

  console.log(banner());
  section("CHAT", "magenta");
  console.log(subtle(`Type ${cmdStyle("/exit")} to quit.\n`));

  const rl = createInterface({ input, output });
  const sessionKey = `cli-${Date.now().toString(36)}`;
  let turn = 0;

  const askYesNo = async (prompt: string, defaultNo = true): Promise<boolean> => {
    const suffix = defaultNo ? " [y/N]: " : " [Y/n]: ";
    const answer = (await rl.question(prompt + suffix)).trim().toLowerCase();
    if (!answer) return !defaultNo;
    return answer === "y" || answer === "yes";
  };

  try {
    while (true) {
      const text = (await rl.question(`${chip("YOU", "blue")} ${kleur.cyan().bold("> ")}`)).trim();
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;
      turn += 1;
      section(`TURN ${turn}`, "blue");
      console.log(`${chip("INPUT", "cyan")} ${value(text)}`);
      divider();

      try {
        const result = await runCoreChatTurn(sessionKey, text, {
          approveTool: async (call: ToolCall, args: Record<string, any>) => {
            const preview = (() => {
              try {
                const raw = JSON.stringify(args);
                return raw.length > 300 ? raw.slice(0, 300) + "..." : raw;
              } catch {
                return "(invalid args)";
              }
            })();
            console.log(`${chip("AUTH", "yellow")} ${value(`Tool: ${call.function.name}`)}`);
            console.log(`${subtle(preview)}\n`);
            return await askYesNo(`${kleur.yellow().bold("Approve tool call?")}`, true);
          },
          requestPermission: async (message: string, title?: string) => {
            const header = title?.trim() ? `${title}: ` : "";
            console.log(`${chip("PERMISSION", "yellow")} ${value(header + (message || "Approve request?"))}`);
            return await askYesNo(`${kleur.yellow().bold("Approve request?")}`, true);
          },
          askQuestion: async (question: string, options: string[], title?: string) => {
            section("QUESTION", "cyan");
            if (title?.trim()) console.log(kleur.magenta().bold(title));
            if (question?.trim()) console.log(value(question.trim()));
            for (let i = 0; i < options.length; i++) {
              console.log(`${kleur.cyan().bold(`${i + 1}.`)} ${value(options[i]!)}`);
            }
            const raw = (await rl.question(`${subtle("Select option number")} ${kleur.dim("(blank to cancel)")} ${kleur.cyan("> ")}`)).trim();
            if (!raw) return null;
            const idx = Number(raw) - 1;
            if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
              console.log(kleur.yellow("Invalid selection."));
              return null;
            }
            return { selected: options[idx]!, userLabel: "cli-user" };
          },
          onToolLine: (line: string) => {
            const trimmed = line.trim();
            if (trimmed) console.log(`${chip("TOOL", "blue")} ${subtle(trimmed)}`);
          },
        });

        if (result.reasoningSummary && result.reasoningSummary.trim() && result.reasoningSummary.length < 200) {
          console.log(`${chip("THINK", "magenta")} ${subtle(result.reasoningSummary.trim())}`);
        }
        console.log(`${okChip("ASSISTANT")}\n${result.text}\n`);
        divider();
      } catch (e: any) {
        console.log(`${errChip("ERROR")} ${e?.message || String(e)}\n`);
        divider();
      }
    }
  } finally {
    rl.close();
  }
}