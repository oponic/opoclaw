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

export type ToolResult = {
    summary: string;
    data?: unknown;
    warnings?: string[];
    artifacts?: { id: string; name?: string }[];
    truncated?: boolean;
};

export function renderToolResult(result: ToolResult | string): string {
    return typeof result === "string" ? result : JSON.stringify(result);
}

export type ToolHandler = (args: ToolArgs, context: ToolContext) => Promise<string>;

export type ToolDefinition = {
    schema: ToolSchema;
    enabled?: (config: OpoclawConfig) => boolean;
    requiresApproval?: boolean;
    /** Capability labels used by the centralized policy layer. */
    capabilities?: ("read" | "write" | "execute" | "network" | "schedule" | "message" | "config" | "admin")[];
    /** Searchable category used to expose tools incrementally. */
    toolset?: string;
    keywords?: string[];
    handler?: ToolHandler;
    /** Optional config-dependent override for the tool's description. */
    describe?: (config: OpoclawConfig) => string;
};

export function defineTool(
    name: string,
    description: string,
    properties: Record<string, any>,
    required: string[],
    options: Omit<ToolDefinition, "schema"> = {},
): ToolDefinition {
    return {
        ...options,
        schema: {
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
