export type PluginManifest = {
    name: string;
    version?: string;
    entry?: string;
    description?: string;
};

export type OpenAIFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
        strict?: boolean;
    };
};

export type PluginInvokeContext = {
    config: Record<string, unknown>;
    root: string;
    manifest: PluginManifest;
};

export type PluginModule = {
    tools?: unknown;
    invoke?: (toolName: string, args: Record<string, unknown>, context?: PluginInvokeContext) => unknown | Promise<unknown>;
    deactivate?: () => unknown | Promise<unknown>;
};

export type HostInitMessage = {
    type: "init";
    entry: string;
    config?: Record<string, unknown>;
    root?: string;
    manifest?: PluginManifest;
};

export type HostInvokeMessage = {
    type: "invoke";
    callId: string;
    toolName: string;
    args?: Record<string, unknown>;
};

export type HostShutdownMessage = {
    type: "shutdown";
};

export type PluginHostMessage = HostInitMessage | HostInvokeMessage | HostShutdownMessage;

export type WorkerReadyMessage = {
    type: "ready";
    tools: unknown[];
};

export type WorkerInvokeResultMessage = {
    type: "invokeResult";
    callId: string;
    result?: unknown;
    error?: string;
};

export type WorkerLogMessage = {
    type: "log";
    args?: unknown[];
};

export type WorkerErrorMessage = {
    type: "error" | "fatal";
    message?: string;
};

export type PluginWorkerMessage = WorkerReadyMessage | WorkerInvokeResultMessage | WorkerLogMessage | WorkerErrorMessage;

export function isOpenAIFunctionTool(value: unknown): value is OpenAIFunctionTool {
    if (!value || typeof value !== "object") return false;
    const maybeTool = value as OpenAIFunctionTool;
    return maybeTool.type === "function"
        && !!maybeTool.function
        && typeof maybeTool.function.name === "string"
        && maybeTool.function.name.trim().length > 0;
}
