import type { OpoclawConfig } from "../config.ts";
import type { AgentSession } from "../agent.ts";

export type ToolArgs = Record<string, any>;
export type PendingFileSend = { path: string; caption: string } | null;

export type ToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, any>;
            required: string[];
        };
    };
};

export type ToolContext = {
    config: OpoclawConfig;
    session: AgentSession;
    onDeepResearchSummary?: (summary: string) => Promise<void>;
};

export type ToolHandler = (args: ToolArgs, context: ToolContext) => Promise<string>;

export type ToolDefinition = {
    tool: ToolSchema;
    enabled?: (config: OpoclawConfig) => boolean;
    requiresApproval?: boolean;
    handler?: ToolHandler;
};

export function defineTool(
    name: string,
    description: string,
    properties: Record<string, any>,
    required: string[],
    options: Omit<ToolDefinition, "tool"> = {},
): ToolDefinition {
    return {
        ...options,
        tool: {
            type: "function",
            function: {
                name,
                description,
                parameters: {
                    type: "object",
                    properties,
                    required,
                },
            },
        },
    };
}

export function discordOnlyHandler(name: string): ToolHandler {
    return async () => {
        throw new Error(`${name} is only available in Discord.`);
    };
}
