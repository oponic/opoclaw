import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { createArtifact } from "../artifacts.ts";
import { createJob, updateJob } from "../jobs.ts";
import { defineTool, type ToolDefinition } from "./types.ts";
import { getToolWithName, handleToolCallDefinition } from "./index.ts";
import { getPolicyDecision } from "../policy.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const ALLOWED_IMPORT_PREFIXES = ["jsr:@std/", "npm:zod", "npm:lodash"]; // Deno resolves these into its managed cache on first use.

function importsAreAllowed(source: string, allowed: string[]): boolean {
    const imports = [...source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map((match) => match[1]!);
    return imports.every((specifier) => !specifier.startsWith("file:") && !specifier.startsWith("/") && !specifier.startsWith(".") && (specifier.startsWith("node:") || allowed.some((prefix) => specifier.startsWith(prefix))));
}

const BRIDGE = `
const encoder = new TextEncoder();
let sequence = 0;
const pending = new Map();
void (async () => {
  const reader = Deno.stdin.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\\n")) >= 0) {
      const raw = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!raw.trim()) continue;
      const msg = JSON.parse(raw); const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  }
})();
globalThis.opoclaw = {
  tools: JSON.parse(Deno.env.get("OPOCLAW_TOOLS") || "[]"),
  async call(name, args = {}) {
    const id = String(++sequence);
    await Deno.stdout.write(encoder.encode(JSON.stringify({ type: "opoclaw.call", id, name, args }) + "\\n"));
    return await new Promise((resolve, reject) => pending.set(id, (response) => response.error ? reject(new Error(response.error)) : resolve(response.result)));
  },
};
`;

export const CODE_TOOLS = {
    deno: defineTool(
        "deno",
        "Run TypeScript in an isolated Deno sandbox. It has no host filesystem, environment, subprocess, or network permissions. Use allowed_tools to explicitly permit bridge calls.",
        {
            code: { type: "string", description: "TypeScript source code to execute." },
            description: { type: "string", description: "Concise user-facing description of the computation." },
            timeout_ms: { type: "number", description: "Optional timeout in milliseconds (maximum 60000)." },
            artifact_name: { type: "string", description: "Optional name for captured output artifact." },
            allowed_tools: { type: "array", items: { type: "string" }, description: "Optional explicitly allowed Opoclaw bridge tool names." },
        },
        ["code", "description"],
        {
            toolset: "runtime", keywords: ["typescript", "deno", "code", "sandbox", "execute"], capabilities: ["execute"], requiresApproval: true,
            enabled: (config) => config.tools?.deno_enabled !== false,
            handler: async (args, { config, session, onDeepResearchSummary }) => {
                const code = String(args.code || "");
                const allowedImports = config.tools?.deno_allowed_imports || ALLOWED_IMPORT_PREFIXES;
                if (!importsAreAllowed(code, allowedImports)) throw new Error(`Imports are restricted. Allowed prefixes: ${allowedImports.join(", ")}.`);
                const timeout = Math.max(1_000, Math.min(60_000, Number(args.timeout_ms || config.tools?.deno_timeout_ms || DEFAULT_TIMEOUT_MS)));
                const allowedTools = Array.isArray(args.allowed_tools) ? args.allowed_tools.map(String) : [];
                const visibleNames = new Set((await import("./index.ts")).getTools(config, new Set(session.getEnabledToolsets())).map((tool) => tool.schema.function.name));
                const toolMetadata = allowedTools.map((name) => getToolWithName(name)).filter((tool) => tool && visibleNames.has(tool.schema.function.name)).map((tool) => ({ name: tool!.schema.function.name, description: tool!.schema.function.description }));
                const job = await createJob({ type: "deno", label: String(args.description), request: code, target: session.deliveryTarget });
                await updateJob(job.id, { status: "running" });
                const dir = await mkdtemp(join(tmpdir(), "opoclaw-deno-"));
                const source = join(dir, "run.ts"), bridge = join(dir, "bridge.ts");
                // Load the bridge only when explicitly needed. A persistent stdin
                // reader otherwise keeps ordinary standalone scripts alive.
                await writeFile(source, allowedTools.length > 0 ? `import "./bridge.ts";\n${code}\nDeno.exit(0);` : code, "utf8"); await writeFile(bridge, BRIDGE, "utf8");
                try {
                    const proc = Bun.spawn({ cmd: [process.env.DENO_BIN || `${homedir()}/.deno/bin/deno`, "run", "--no-prompt", "--allow-env=OPOCLAW_TOOLS", "--deny-read", "--deny-write", "--deny-run", "--deny-net", source], cwd: dir, env: { PATH: process.env.PATH || "", OPOCLAW_TOOLS: JSON.stringify(toolMetadata) }, stdout: "pipe", stderr: "pipe", stdin: "pipe" });
                    const stdin = proc.stdin as any;
                    const sendBridgeResponse = async (response: unknown) => { await stdin.write(JSON.stringify(response) + "\n"); };
                    const outputLines: string[] = [];
                    const stdoutTask = (async () => {
                        const reader = proc.stdout.getReader(); const decoder = new TextDecoder(); let buffer = "";
                        while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true });
                            let newline; while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
                                try { const message = JSON.parse(line); if (message.type === "opoclaw.call") {
                                    if (!allowedTools.includes(message.name)) { await sendBridgeResponse({ id: message.id, error: "Bridge tool is not allowed." }); continue; }
                                    const tool = getToolWithName(message.name); if (!tool?.handler || !visibleNames.has(message.name)) { await sendBridgeResponse({ id: message.id, error: "Unknown or unavailable bridge tool." }); continue; }
                                    const policy = await getPolicyDecision(tool, session.sessionId, message.args || {});
                                    if (!policy.allowed || policy.requiresApproval) { await sendBridgeResponse({ id: message.id, error: policy.reason || "Bridge tool requires approval." }); continue; }
                                    try { const result = await handleToolCallDefinition(tool, message.args || {}, { config, session, onDeepResearchSummary }); await sendBridgeResponse({ id: message.id, result }); }
                                    catch (error: any) { await sendBridgeResponse({ id: message.id, error: error?.message || String(error) }); }
                                } else outputLines.push(line); } catch { outputLines.push(line); }
                            }
                        } if (buffer) outputLines.push(buffer);
                    })();
                    const timedOut = await Promise.race([proc.exited.then(() => false), Bun.sleep(timeout).then(() => true)]); if (timedOut) proc.kill();
                    await stdoutTask; const stderr = await new Response(proc.stderr).text(); try { stdin.end(); } catch {};
                    const stdout = outputLines.join("\n"), output = `stdout:\n${stdout}\nstderr:\n${stderr}`.slice(0, MAX_OUTPUT_BYTES);
                    const artifact = await createArtifact(output, { name: String(args.artifact_name || "deno-output.txt"), sessionId: session.sessionId, jobId: job.id });
                    const status = timedOut ? "failed" : proc.exitCode === 0 ? "completed" : "failed";
                    await updateJob(job.id, { status, output, error: timedOut ? `Timed out after ${timeout}ms` : proc.exitCode === 0 ? undefined : `Deno exited with code ${proc.exitCode}` });
                    return JSON.stringify({ summary: timedOut ? `Deno timed out after ${timeout}ms.` : `Deno exited with code ${proc.exitCode}.`, data: { stdout: stdout.slice(0, 10_000), stderr: stderr.slice(0, 10_000), exitCode: proc.exitCode, timeoutMs: timeout, bridgeTools: allowedTools }, artifacts: [{ id: artifact.id, name: artifact.name }], truncated: output.length >= MAX_OUTPUT_BYTES });
                } catch (error: any) { await updateJob(job.id, { status: "failed", error: error?.message || String(error) }); throw error; }
                finally { await rm(dir, { recursive: true, force: true }); }
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
