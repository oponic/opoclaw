import { readFile, getFilePath, editFile, listFiles } from "../workspace.ts";
import { defineTool, type ToolDefinition } from "./types.ts";
import { createArtifact } from "../artifacts.ts";
import { enqueueDelivery } from "../channels/delivery.ts";

export const FILE_TOOLS = {
    read_file: defineTool(
        "read_file",
        "Read the contents of a file in the workspace. Only files in the workspace directory can be read.",
        {
            path: {
                type: "string",
                description: "Relative path to the file within the workspace (e.g. 'AGENTS.md').",
            },
        },
        ["path"],
        {
            enabled: (config) => config.basic_tools ?? true,
            handler: async (args, { config }) => {
                if (!args.path) throw new Error("Missing 'path' argument for read_file.");
                return await readFile(String(args.path), config.mounts);
            },
        },
    ),
    edit_file: defineTool(
        "edit_file",
        "Overwrite the contents of an existing file in the workspace. You cannot create new files or delete files - only edit files that already exist.",
        {
            path: {
                type: "string",
                description: "Relative path to the file within the workspace.",
            },
            content: {
                type: "string",
                description: "The new complete content to write to the file.",
            },
        },
        ["path", "content"],
        {
            enabled: (config) => config.basic_tools ?? true,
            handler: async (args, { config }) => {
                if (!args.path) throw new Error("Missing 'path' argument for edit_file.");
                if (args.content === undefined) throw new Error("Missing 'content' argument for edit_file.");
                await editFile(String(args.path), String(args.content), config.mounts);
                return `Successfully wrote ${String(args.content).length} characters to "${args.path}".`;
            },
        },
    ),
    list_files: defineTool(
        "list_files",
        "List all files currently in the workspace directory.",
        {},
        [],
        {
            enabled: (config) => config.basic_tools ?? true,
            handler: async (_args, { config }) => {
                const files = await listFiles(config.mounts);
                return files.length > 0 ? files.map((file) => `• ${file}`).join("\n") : "(workspace is empty)";
            },
        },
    ),
    send_file: defineTool(
        "send_file",
        "Send a file from the workspace as a Discord attachment. The file will be sent after the agent's response.",
        {
            path: {
                type: "string",
                description: "Relative path to the file within the workspace.",
            },
            caption: {
                type: "string",
                description: "Optional caption for the file.",
            },
        },
        ["path"],
        {
            handler: async (args, { config, session }) => {
                if (!args.path) throw new Error("Missing 'path' argument for send_file.");
                const source = getFilePath(String(args.path), config.mounts);
                const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
                const artifact = await createArtifact(bytes, { name: String(args.path).split("/").pop(), sessionId: session.sessionId, maxBytes: config.artifacts?.max_bytes });
                if (session.deliveryTarget) {
                    await enqueueDelivery(session.deliveryTarget, String(args.caption || ""), [artifact.id], `send-file:${session.sessionId}:${artifact.id}`);
                    return `Artifact "${artifact.name}" queued for delivery.`;
                }
                session.pendingFileSend = { path: String(args.path), caption: String(args.caption || "") };
                return `Artifact "${artifact.name}" queued; no delivery target is active.`;
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
