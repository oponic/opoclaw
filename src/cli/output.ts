import kleur from "kleur";

export type ChipTone = "magenta" | "blue" | "green" | "yellow" | "red" | "cyan";

export const info = (s: string) => console.log(`${kleur.bgBlue().white().bold(" INFO ")} ${s}`);
export const ok = (s: string) => console.log(`${kleur.bgGreen().white().bold(" OK ")} ${s}`);
export const warn = (s: string) => console.log(`${kleur.bgYellow().white().bold(" WARN ")} ${s}`);
export const err = (s: string) => console.error(`${kleur.bgRed().white().bold(" ERROR ")} ${s}`);
export const label = (s: string) => kleur.cyan().bold(s);
export const value = (s: string) => kleur.white(s);
export const cmdStyle = (s: string) => kleur.magenta().bold(s);
export const subtle = (s: string) => kleur.dim(s);

export const chip = (s: string, tone: ChipTone = "magenta") => {
  const text = ` ${s} `;
  switch (tone) {
    case "blue": return kleur.bgBlue().white().bold(text);
    case "green": return kleur.bgGreen().white().bold(text);
    case "yellow": return kleur.bgYellow().white().bold(text);
    case "red": return kleur.bgRed().white().bold(text);
    case "cyan": return kleur.bgCyan().white().bold(text);
    default: return kleur.bgMagenta().white().bold(text);
  }
};
export const okChip = (s: string) => kleur.bgGreen().white().bold(` ${s} `);
export const errChip = (s: string) => kleur.bgRed().white().bold(` ${s} `);
export const toolChip = (s: string) => kleur.bgBlue().white().bold(` ${s} `);
export const banner = () => (
  kleur.magenta("▄▄███▀") + kleur.bold("                    ▀█              \n") +
  kleur.magenta("▀▀▄▄▄█▄") + kleur.dim().bold("  ▄▀▀▄ ▄▀▀▄ ▄▀▀▄ ") + kleur.bold("▄▀▀▀ █  ▀▀▀▄ █ █ █ \n") +
  kleur.magenta("  █████") + kleur.dim().bold("  ▀▄▄▀ █▄▄▀ ▀▄▄▀ ") + kleur.bold("▀▄▄▄ █▄ ████ ▀▄▀▄▀\n") +
  kleur.magenta("   ▀▀▀ ") + kleur.dim().bold("       █")
);