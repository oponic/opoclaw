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
    workspaceRoot: string;
    manifest: PluginManifest;
    fs: {
        plugin: {
            readText: (relativePath: string) => Promise<string>;
            readJson: <T = unknown>(relativePath: string) => Promise<T>;
            writeText: (relativePath: string, content: string) => Promise<void>;
            writeJson: (relativePath: string, value: unknown) => Promise<void>;
            exists: (relativePath: string) => Promise<boolean>;
            list: (relativePath?: string) => Promise<string[]>;
            mkdir: (relativePath: string) => Promise<void>;
            remove: (relativePath: string, recursive?: boolean) => Promise<void>;
        };
        workspace: {
            readText: (relativePath: string) => Promise<string>;
            readJson: <T = unknown>(relativePath: string) => Promise<T>;
            writeText: (relativePath: string, content: string) => Promise<void>;
            writeJson: (relativePath: string, value: unknown) => Promise<void>;
            exists: (relativePath: string) => Promise<boolean>;
            list: (relativePath?: string) => Promise<string[]>;
            mkdir: (relativePath: string) => Promise<void>;
            remove: (relativePath: string, recursive?: boolean) => Promise<void>;
        };
    };
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
    workspaceRoot?: string;
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

export type WorkerShutdownAckMessage = {
    type: "shutdownAck";
};

export type PluginWorkerMessage = WorkerReadyMessage | WorkerInvokeResultMessage | WorkerLogMessage | WorkerErrorMessage | WorkerShutdownAckMessage;

export function isOpenAIFunctionTool(value: unknown): value is OpenAIFunctionTool {
    if (!value || typeof value !== "object") return false;
    const maybeTool = value as OpenAIFunctionTool;
    return maybeTool.type === "function"
        && !!maybeTool.function
        && typeof maybeTool.function.name === "string"
        && maybeTool.function.name.trim().length > 0;
}
