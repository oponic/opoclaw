import { FILE_TOOLS } from "./file-tools.ts";
import { GATEWAY_TOOLS } from "./gateway-tools.ts";
import { WEB_TOOLS } from "./web-tools.ts";
import { SKILL_TOOLS } from "./skill-tools.ts";
import { AGENT_TOOLS } from "./agent-tools.ts";
import { INFO_TOOLS } from "./info-tools.ts";
import { DISCORD_TOOLS } from "./discord-tools.ts";
import { SHELL_TOOLS } from "./shell-tool.ts";
import { CRON_TOOLS } from "./cron-tools.ts";
import { DISCOVERY_TOOLS } from "./discovery-tools.ts";
import { CODE_TOOLS } from "./code-tools.ts";
import { ARTIFACT_TOOLS } from "./artifact-tools.ts";
import { DOCS_TOOLS } from "./docs-tools.ts";
import type { ToolArgs, ToolContext, ToolDefinition } from "./types.ts";
import type { OpoclawConfig } from "../config.ts";

export type { ToolContext, ToolSchema } from "./types.ts";

const TOOL_DEFINITIONS = {
    ...FILE_TOOLS,
    ...GATEWAY_TOOLS,
    ...WEB_TOOLS,
    ...SKILL_TOOLS,
    ...AGENT_TOOLS,
    ...INFO_TOOLS,
    ...DISCORD_TOOLS,
    ...SHELL_TOOLS,
    ...CRON_TOOLS,
    ...DISCOVERY_TOOLS,
    ...CODE_TOOLS,
    ...ARTIFACT_TOOLS,
    ...DOCS_TOOLS,
} satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof TOOL_DEFINITIONS;

export const APPROVAL_TOOL_NAMES = new Set<ToolName>(
    (Object.entries(TOOL_DEFINITIONS) as [ToolName, ToolDefinition][])
        .filter(([, definition]) => definition.requiresApproval)
        .map(([name]) => name),
);

export function requiresToolApproval(name: string): boolean {
    return APPROVAL_TOOL_NAMES.has(name as ToolName);
}

const TOOLSET_BY_NAME: Record<string, string> = {
    read_file: "files", edit_file: "files", list_files: "files", send_file: "files",
    search: "web", web_fetch: "web", shell: "runtime", deno: "runtime",
    deep_research: "agent", compact: "agent", run_subagent: "agent", run_background_subagent: "agent", timer: "agent",
    edit_config: "configuration", restart_gateway: "configuration", hibernate_gateway: "configuration", update_opoclaw: "configuration",
    use_skill: "skills", list_skills: "skills", session_status: "information", get_time: "information",
    react_message: "discord", request_permission: "interaction", question: "interaction", poll: "discord", check_polls: "discord", create_thread: "discord",
};

function toolsetOf(definition: ToolDefinition): string {
    return definition.toolset || TOOLSET_BY_NAME[definition.schema.function.name] || "general";
}

function withToolset(definition: ToolDefinition): ToolDefinition {
    return definition.toolset ? definition : { ...definition, toolset: toolsetOf(definition) };
}

export function listToolsets(): string[] {
    return [...new Set(Object.values(TOOL_DEFINITIONS).map((definition) => toolsetOf(withToolset(definition))))].sort();
}

export function searchToolsets(query: string): { toolset: string; tools: string[]; description: string }[] {
    const normalized = query.toLowerCase();
    const groups = new Map<string, ToolDefinition[]>();
    for (const original of Object.values(TOOL_DEFINITIONS)) {
        const definition = withToolset(original);
        const set = toolsetOf(definition);
        const text = [set, definition.schema.function.name, definition.schema.function.description, ...(definition.keywords || [])].join(" ").toLowerCase();
        if (normalized && !text.includes(normalized) && !normalized.split(/\s+/).some((term) => text.includes(term))) continue;
        groups.set(set, [...(groups.get(set) || []), definition]);
    }
    return [...groups.entries()].map(([toolset, definitions]) => ({
        toolset,
        tools: definitions.map((definition) => definition.schema.function.name),
        description: definitions.map((definition) => definition.schema.function.description).join(" ").slice(0, 300),
    }));
}

export function getTools(config: OpoclawConfig, toolsets?: Set<string>): ToolDefinition[] {
    return (Object.entries(TOOL_DEFINITIONS) as [ToolName, ToolDefinition][])
        .filter(([, definition]) => definition.enabled?.(config) ?? true)
        .map(([, definition]) => withToolset(definition))
        .filter((definition) => !toolsets || config.tools?.legacy_full_exposure || definition.schema.function.name === "tool_search" || toolsets.has(toolsetOf(definition)))
        .map((definition) => definition.describe ? {
            ...definition,
            schema: { ...definition.schema, function: { ...definition.schema.function, description: definition.describe(config) } },
        } : definition); /* TOOL_MAP */
}

export function getAllTools(config: OpoclawConfig): ToolDefinition[] {
    return (Object.entries(TOOL_DEFINITIONS) as [ToolName, ToolDefinition][])
        .filter(([, definition]) => definition.enabled?.(config) ?? true)
        .map(([, definition]) => withToolset(definition))
        .map((definition) => definition.describe ? {
            ...definition,
            schema: { ...definition.schema, function: { ...definition.schema.function, description: definition.describe(config) } },
        } : definition); /* TOOL_MAP */
}

/* legacy body retained below */
export function getToolsLegacy(config: OpoclawConfig): ToolDefinition[] {
    return (Object.entries(TOOL_DEFINITIONS) as [ToolName, ToolDefinition][])
        .filter(([, definition]) => definition.enabled?.(config) ?? true)
        .map(([, definition]) => {
            if (!definition.describe) return definition;
            const description = definition.describe(config);
            return {
                ...definition,
                schema: { ...definition.schema, function: { ...definition.schema.function, description } },
            };
        });
}

export function getToolsFiltered(config: OpoclawConfig, exclude: ToolName[], include?: ToolName[]): ToolDefinition[] {
    return getTools(config).filter(tool=>{
        if(exclude.includes(tool.schema.function.name as ToolName)) return false;
        if(include == undefined) return true;
        return include.includes(tool.schema.function.name as ToolName);
    })
}

export function getToolWithName(name: string): ToolDefinition | undefined {
    return TOOL_DEFINITIONS[name as ToolName];   
}

export async function handleToolCall(
    name: string,
    args: ToolArgs,
    context: ToolContext,
): Promise<string> {
    console.log(`Handling tool call: ${name} with args ${JSON.stringify(args)}`);
    const definition = TOOL_DEFINITIONS[name as ToolName];
    if (!definition) {
        throw new Error(`Unknown tool: ${name}`);
    }
    if (!definition.handler) {
        throw new Error(`Tool "${name}" is not handled locally.`);
    }
    return await definition.handler(args, context);
}

export async function handleToolCallDefinition(
    definition: ToolDefinition,
    args: ToolArgs,
    context: ToolContext,
): Promise<string> {
    console.log(`Handling tool call: ${definition.schema.function.name} with args ${JSON.stringify(args)}`);
    if (!definition.handler) {
        throw new Error(`Tool "${definition.schema.function.name}" is not handled locally.`);
    }
    return await definition.handler(args, context);
}