import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";
import { resolve } from "path";
import { runAgent, AgentSession } from "../src/agent.ts";
import { provider } from "../src/provider/index.ts";
import type { CompletionResult } from "../src/provider/index.ts";
import { WORKSPACE_DIR } from "../src/workspace.ts";

const cfg: any = { provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } } };
const dummyCallbacks = { onFirstToken: () => {}, onToolCall: () => {}, onToolCallError: () => {} };

function textResult(text: string): CompletionResult {
    return { text, toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, reasoning: "" };
}

function toolCallResult(name: string, args: Record<string, any>, id = "tc1"): CompletionResult {
    return {
        text: null,
        toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        reasoning: "",
    };
}

describe("agent", () => {
    test("runAgent returns assistant text", async () => {
        const original = provider.generateCompletion;
        provider.generateCompletion = async () => textResult("Hello");
        try {
            const result = await runAgent([{ role: "user", content: "hi" }], "system", cfg, dummyCallbacks, "test-session");
            expect(result.text).toBe("Hello");
        } finally {
            provider.generateCompletion = original;
        }
    });

    test("AgentSession.pendingFileSend is set when model calls send_file", async () => {
        const testDir = resolve(WORKSPACE_DIR, "__agent_test__");
        await rm(testDir, { recursive: true, force: true });
        await mkdir(testDir, { recursive: true });
        await writeFile(resolve(testDir, "out.txt"), "data", "utf-8");

        const original = provider.generateCompletion;
        let call = 0;
        provider.generateCompletion = async () => {
            call++;
            if (call === 1) return toolCallResult("send_file", { path: "__agent_test__/out.txt", caption: "here" });
            return textResult("done");
        };

        try {
            const session = new AgentSession("test-session");
            session.addMessage({ role: "user", content: "send me that file" });
            await session.evaluate("system", cfg, dummyCallbacks);
            expect(session.pendingFileSend?.path).toBe("__agent_test__/out.txt");
            expect(session.pendingFileSend?.caption).toBe("here");
        } finally {
            provider.generateCompletion = original;
            await rm(testDir, { recursive: true, force: true });
        }
    });

    test("runAgent throws on API error", async () => {
        const original = provider.generateCompletion;
        provider.generateCompletion = async () => { throw new Error("API error"); };
        try {
            await expect(
                runAgent([{ role: "user", content: "hi" }], "system", cfg, dummyCallbacks, "test-session")
            ).rejects.toThrow();
        } finally {
            provider.generateCompletion = original;
        }
    });

    test("run_subagent tool returns delegated output", async () => {
        const original = provider.generateCompletion;
        let call = 0;
        provider.generateCompletion = async () => {
            call++;
            if (call === 1) return toolCallResult("run_subagent", { request: "delegate this", include_context: false });
            if (call === 2) return textResult("delegated result");
            return textResult("main final");
        };

        try {
            const session = new AgentSession("test-session");
            session.addMessage({ role: "user", content: "do delegation" });
            const result = await session.evaluate("system", cfg, dummyCallbacks);
            expect(result.text).toBe("main final");
            const toolMsg = session.messages.find((m: any) => m.role === "tool" && m.name === "run_subagent");
            expect(String(toolMsg?.content || "")).toContain("delegated result");
        } finally {
            provider.generateCompletion = original;
        }
    });

    test("compact tool replaces older context with summary", async () => {
        const original = provider.generateCompletion;
        let call = 0;
        provider.generateCompletion = async () => {
            call++;
            if (call === 1) return toolCallResult("compact", { preserve_recent_messages: 4 });
            if (call === 2) return textResult("compacted summary paragraph one.\n\nparagraph two.");
            return textResult("after compact");
        };

        try {
            const session = new AgentSession("test-session");
            for (let i = 0; i < 10; i++) {
                session.addMessage({ role: i % 2 === 0 ? "user" : "assistant", content: `message-${i}` });
            }
            await session.evaluate("system", {
                provider: { active: "openrouter", openrouter: { api_key: "k", model: "m", base_url: "http://localhost" } },
            } as any, dummyCallbacks);
            expect(String(session.messages[0]?.content || "")).toContain("Conversation context summary");
            expect(session.messages.length).toBeLessThanOrEqual(6+1);
        } finally {
            provider.generateCompletion = original;
        }
    });

    test("run_background_subagent injects completion into context", async () => {
        const original = provider.generateCompletion;
        let call = 0;
        let injectedSeen = false;
        provider.generateCompletion = async (messages) => {
            call++;
            if (call === 1) return toolCallResult("run_background_subagent", { request: "background work", include_context: false, label: "bgtest" });
            if (call === 2) return textResult("background result payload");
            injectedSeen = JSON.stringify(messages).includes("Background subagent completed");
            return textResult("main continues");
        };
        try {
            const session = new AgentSession("test-session");
            session.addMessage({ role: "user", content: "start background task" });
            await session.evaluate("system", cfg, dummyCallbacks);
            expect(injectedSeen).toBe(true);
        } finally {
            provider.generateCompletion = original;
        }
    });

    test("timer tool injects completion into context after delay", async () => {
        const original = provider.generateCompletion;
        let call = 0;
        let injectedSeen = false;
        provider.generateCompletion = async (messages) => {
            call++;
            if (call === 1) return toolCallResult("timer", { seconds: 0.1, label: "test-timer" });
            if (JSON.stringify(messages).includes("Background subagent completed (test-timer)")) {
                injectedSeen = true;
            }
            return textResult("acknowledged");
        };

        try {
            const session = new AgentSession("test-session");
            session.addMessage({ role: "user", content: "set a timer for 0.1 seconds" });

            await session.evaluate("system", cfg, dummyCallbacks);

            await new Promise(resolve => setTimeout(resolve, 300));

            await session.evaluate("system", cfg, dummyCallbacks);

            expect(injectedSeen).toBe(true);
        } finally {
            provider.generateCompletion = original;
        }
    });

    test("session_status tool returns session info", async () => {
        const original = provider.generateCompletion;
        let call = 0;
        provider.generateCompletion = async () => {
            call++;
            if (call === 1) return toolCallResult("session_status", {});
            return textResult("The status has been retrieved.");
        };

        try {
            const session = new AgentSession("opoclaw-core-test");
            session.addMessage({ role: "user", content: "what is the status?" });
            await session.evaluate("system", cfg, dummyCallbacks);

            const lastMessage = session.messages[session.messages.length - 2];
            expect(lastMessage!.role).toBe("tool");
            expect(lastMessage!.content).toContain("Session Status:");
            expect(lastMessage!.content).toContain("Model: m (openrouter)");
            expect(lastMessage!.content).toContain("Channel: core/terminal");
            expect(lastMessage!.content).toContain("Context Usage:");
            expect(lastMessage!.content).toContain("Spending (last 24h):");
        } finally {
            provider.generateCompletion = original;
        }
    });

});