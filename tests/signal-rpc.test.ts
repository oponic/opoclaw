import { describe, expect, test } from "bun:test";
import net from "net";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { SignalRpc } from "../src/signal/rpc.ts";

describe("Signal JSON-RPC", () => {
  test("sends requests and receives notifications over a Unix socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opoclaw-signal-"));
    const socketPath = join(dir, "signal.sock");
    let received = "";
    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        received += chunk;
        const request = JSON.parse(received.trim());
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }) + "\n");
        socket.write(JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope: { source: "+1", dataMessage: { message: "hello" } } } }) + "\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    let notification = "";
    const rpc = new SignalRpc({ socket: socketPath, onReceive: (event) => { notification = event.envelope?.dataMessage?.message || ""; } });
    try {
      expect(await rpc.request("ping", {})).toEqual({ ok: true });
      await Bun.sleep(10);
      expect(notification).toBe("hello");
    } finally {
      rpc.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
