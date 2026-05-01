import { FILE_TOOLS } from "./file-tools.ts";
import { GATEWAY_TOOLS } from "./gateway-tools.ts";
import { WEB_TOOLS } from "./web-tools.ts";
import { SKILL_TOOLS } from "./skill-tools.ts";
import { AGENT_TOOLS } from "./agent-tools.ts";
import { INFO_TOOLS } from "./info-tools.ts";
import { DISCORD_TOOLS } from "./discord-tools.ts";
import { SHELL_TOOLS } from "./shell-tool.ts";
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

export function getTools(config: OpoclawConfig): ToolDefinition[] {
    return (Object.entries(TOOL_DEFINITIONS) as [ToolName, ToolDefinition][])
        .filter(([, definition]) => definition.enabled?.(config) ?? true)
        .map(([, definition]) => definition);
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