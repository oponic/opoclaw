import { getArtifact, listArtifacts } from "../artifacts.ts";
import { enqueueDelivery } from "../channels/delivery.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

export const ARTIFACT_TOOLS = {
    list_artifacts: defineTool("list_artifacts", "List artifacts created in this session.", {}, [], {
        toolset: "artifacts", keywords: ["artifact", "output", "file"], capabilities: ["read"],
        handler: async (_args, { session }) => JSON.stringify(await listArtifacts(session.sessionId), null, 2),
    }),
    read_artifact: defineTool("read_artifact", "Read a text artifact created in this session.", { id: { type: "string", description: "Artifact ID." } }, ["id"], {
        toolset: "artifacts", keywords: ["artifact", "read", "output"], capabilities: ["read"],
        handler: async (args, { session }) => {
            const artifact = await getArtifact(String(args.id || ""));
            if (!artifact || artifact.sessionId !== session.sessionId) throw new Error("Artifact not found in this session.");
            return await Bun.file(artifact.path).text();
        },
    }),
    send_artifact: defineTool("send_artifact", "Send an artifact created in this session to the current conversation.", { id: { type: "string", description: "Artifact ID." }, caption: { type: "string", description: "Optional caption." } }, ["id"], {
        toolset: "artifacts", keywords: ["artifact", "send", "file"], capabilities: ["message"],
        handler: async (args, { session }) => {
            const artifact = await getArtifact(String(args.id || ""));
            if (!artifact || artifact.sessionId !== session.sessionId) throw new Error("Artifact not found in this session.");
            if (!session.deliveryTarget) throw new Error("No active delivery target.");
            await enqueueDelivery(session.deliveryTarget, String(args.caption || ""), [artifact.id], `send-artifact:${session.sessionId}:${artifact.id}`);
            return `Artifact "${artifact.name}" queued for delivery.`;
        },
    }),
} satisfies Record<string, ToolDefinition>;
