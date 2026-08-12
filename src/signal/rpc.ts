import net from "net";

// Minimal JSON-RPC 2.0 client for the `signal-cli daemon` socket.
//
// The daemon speaks newline-delimited JSON over either a unix socket
// (`signal-cli daemon --socket <path>`) or TCP (`signal-cli daemon --tcp
// host:port`). Requests are standard JSON-RPC; incoming Signal messages arrive
// as `receive` notifications (no id).

export type SignalEnvelope = {
    source?: string;
    sourceNumber?: string;
    sourceUuid?: string;
    sourceName?: string;
    sourceDevice?: number;
    timestamp?: number;
    dataMessage?: {
        timestamp?: number;
        message?: string | null;
        expiresInSeconds?: number;
        viewOnce?: boolean;
        attachments?: Array<{
            contentType?: string;
            filename?: string;
            id?: string;
            size?: number;
        }>;
        mentions?: Array<{ name?: string; number?: string; uuid?: string; start?: number; length?: number }>;
        quote?: {
            id?: number;
            author?: string;
            authorNumber?: string;
            authorUuid?: string;
            text?: string;
        };
        reaction?: {
            emoji?: string;
            targetAuthor?: string;
            targetAuthorNumber?: string;
            targetAuthorUuid?: string;
            targetSentTimestamp?: number;
            isRemove?: boolean;
        };
        groupInfo?: { groupId?: string; groupName?: string; type?: string };
    } | null;
    syncMessage?: any;
    receiptMessage?: any;
    typingMessage?: any;
};

export type SignalReceive = {
    account?: string;
    envelope?: SignalEnvelope;
};

type Pending = {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

export type SignalRpcOptions = {
    socket?: string;
    host?: string;
    port?: number;
    account?: string;
    requestTimeoutMs?: number;
    onReceive?: (receive: SignalReceive) => void;
    onStatus?: (line: string) => void;
};

export class SignalRpc {
    private socket: net.Socket | null = null;
    private buffer = "";
    private nextId = 1;
    private pending = new Map<string, Pending>();
    private closed = false;
    private reconnectDelayMs = 1000;
    private readyPromise: Promise<void> | null = null;

    constructor(private opts: SignalRpcOptions) {}

    get account(): string | undefined {
        return this.opts.account;
    }

    async connect(): Promise<void> {
        if (this.readyPromise) return this.readyPromise;
        this.readyPromise = new Promise<void>((resolve, reject) => {
            const socket = this.opts.socket
                ? net.connect({ path: this.opts.socket })
                : net.connect({ host: this.opts.host || "127.0.0.1", port: this.opts.port || 7583 });
            this.socket = socket;
            socket.setEncoding("utf-8");

            const onConnect = () => {
                this.reconnectDelayMs = 1000;
                this.opts.onStatus?.("connected to signal-cli daemon");
                resolve();
            };
            const onError = (err: Error) => {
                if (this.readyPromise && !this.socket?.readable) reject(err);
                this.opts.onStatus?.(`socket error: ${err.message}`);
            };

            socket.once("connect", onConnect);
            socket.on("error", onError);
            socket.on("data", (chunk: string) => this.onData(chunk));
            socket.on("close", () => {
                this.socket = null;
                this.readyPromise = null;
                this.failAllPending(new Error("signal-cli daemon connection closed"));
                if (!this.closed) this.scheduleReconnect();
            });
        });
        return this.readyPromise;
    }

    close(): void {
        this.closed = true;
        this.socket?.destroy();
        this.socket = null;
    }

    private scheduleReconnect(): void {
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(delay * 2, 30_000);
        this.opts.onStatus?.(`reconnecting in ${Math.round(delay / 1000)}s`);
        setTimeout(() => {
            if (this.closed) return;
            this.connect().catch(() => {});
        }, delay);
    }

    private failAllPending(err: Error): void {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            let msg: any;
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            this.dispatch(msg);
        }
    }

    private dispatch(msg: any): void {
        if (msg.id !== undefined && msg.id !== null && this.pending.has(String(msg.id))) {
            const key = String(msg.id);
            const p = this.pending.get(key)!;
            this.pending.delete(key);
            clearTimeout(p.timer);
            if (msg.error) {
                const detail = typeof msg.error === "string" ? msg.error : msg.error.message || JSON.stringify(msg.error);
                p.reject(new Error(detail));
            } else {
                p.resolve(msg.result);
            }
            return;
        }

        if (msg.method === "receive" && msg.params) {
            this.opts.onReceive?.(msg.params as SignalReceive);
        }
    }

    async request(method: string, params: Record<string, any> = {}): Promise<any> {
        await this.connect();
        const socket = this.socket;
        if (!socket) throw new Error("Not connected to signal-cli daemon.");

        const id = String(this.nextId++);
        const payload: Record<string, any> = { jsonrpc: "2.0", method, id, params: { ...params } };
        // A daemon serving multiple registered numbers requires an explicit
        // account on every call; single-account daemons reject nothing extra.
        if (this.opts.account && payload.params.account === undefined) {
            payload.params.account = this.opts.account;
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`signal-cli request '${method}' timed out`));
            }, this.opts.requestTimeoutMs ?? 120_000);
            this.pending.set(id, { resolve, reject, timer });
            socket.write(JSON.stringify(payload) + "\n", (err) => {
                if (err) {
                    this.pending.delete(id);
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }
}
