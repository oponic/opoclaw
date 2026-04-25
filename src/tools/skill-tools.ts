import { listSkills, readSkill } from "../skills.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

export const SKILL_TOOLS = {
    use_skill: defineTool(
        "use_skill",
        "Load a skill by name from workspace/skills/<skill>/SKILL.md. Use this before applying a skill's instructions.",
        {
            name: {
                type: "string",
                description: "Skill folder name under workspace/skills.",
            },
        },
        ["name"],
        {
            handler: async (args) => {
                if (!args.name) throw new Error("Missing 'name' argument for use_skill.");
                return await readSkill(String(args.name));
            },
        },
    ),
    list_skills: defineTool(
        "list_skills",
        "List available skills from workspace/skills.",
        {},
        [],
        {
            handler: async () => {
                const skills = await listSkills();
                return skills.length > 0 ? skills.join("\n") : "(no skills)";
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
