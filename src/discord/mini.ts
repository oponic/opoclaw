/**
 * mini.ts — a tiny, dependency-free Discord client.
 *
 * Implements only the slice of the Discord API opoclaw uses: a gateway
 * WebSocket (MESSAGE_CREATE / INTERACTION_CREATE / READY), a REST helper with
 * 429 handling, and drop-in shims for the discord.js builders and component
 * collectors. This replaces the ~11 MB discord.js dependency tree and its
 * unbounded in-memory caches — nothing here is cached beyond the live socket.
 */

const API = "https://discord.com/api/v10";

// ── Enums (subset, values match discord.js / the Discord API) ────────────────

export const GatewayIntentBits = {
    Guilds: 1 << 0,
    GuildMessages: 1 << 9,
    GuildMessageReactions: 1 << 10,
    MessageContent: 1 << 15,
} as const;

export const Events = {
    ClientReady: "ready",
    MessageCreate: "messageCreate",
    InteractionCreate: "interactionCreate",
} as const;

export const ButtonStyle = {
    Primary: 1,
    Secondary: 2,
    Success: 3,
    Danger: 4,
    Link: 5,
} as const;

export const ComponentType = {
    ActionRow: 1,
    Button: 2,
    StringSelect: 3,
} as const;

export const MessageReferenceType = {
    Default: 0,
    Forward: 1,
} as const;

// ── Builders ─────────────────────────────────────────────────────────────────

export class EmbedBuilder {
    data: any;
    constructor(data: any = {}) { this.data = { ...data }; }
    static from(other: EmbedBuilder | any): EmbedBuilder {
        return new EmbedBuilder(other instanceof EmbedBuilder ? other.data : other);
    }
    setTitle(t: string) { this.data.title = t; return this; }
    setDescription(d: string) { this.data.description = d; return this; }
    setColor(c: number) { this.data.color = c; return this; }
    setFooter(f: { text: string }) { this.data.footer = f; return this; }
    toJSON() { return this.data; }
}

export class ButtonBuilder {
    data: any = { type: ComponentType.Button };
    setCustomId(id: string) { this.data.custom_id = id; return this; }
    setLabel(l: string) { this.data.label = l; return this; }
    setStyle(s: number) { this.data.style = s; return this; }
    toJSON() { return this.data; }
}

export class StringSelectMenuBuilder {
    data: any = { type: ComponentType.StringSelect };
    setCustomId(id: string) { this.data.custom_id = id; return this; }
    setMinValues(n: number) { this.data.min_values = n; return this; }
    setMaxValues(n: number) { this.data.max_values = n; return this; }
    addOptions(opts: { label: string; value: string }[]) {
        this.data.options = [...(this.data.options || []), ...opts];
        return this;
    }
    toJSON() { return this.data; }
}

export class ActionRowBuilder<T extends { toJSON(): any } = any> {
    components: T[] = [];
    addComponents(...c: T[]) { this.components.push(...c.flat() as T[]); return this; }
    toJSON() {
        return { type: ComponentType.ActionRow, components: this.components.map((c) => c.toJSON()) };
    }
}

export class AttachmentBuilder {
    path: string;
    name: string;
    constructor(path: string, opts?: { name?: string }) {
        this.path = path;
        this.name = opts?.name || path.split("/").pop() || "file";
    }
}

// ── REST client ──────────────────────────────────────────────────────────────

async function restRequest(token: string, method: string, path: string, opts: { body?: any; files?: AttachmentBuilder[] } = {}): Promise<any> {
    const url = `${API}${path}`;
    const headers: Record<string, string> = { Authorization: `Bot ${token}` };

    for (let attempt = 0; attempt < 5; attempt++) {
        let bodyInit: any;
        if (opts.files && opts.files.length > 0) {
            const form = new FormData();
            form.append("payload_json", JSON.stringify(opts.body ?? {}));
            for (let i = 0; i < opts.files.length; i++) {
                const f = opts.files[i]!;
                form.append(`files[${i}]`, Bun.file(f.path), f.name);
            }
            bodyInit = form;
        } else if (opts.body !== undefined) {
            headers["Content-Type"] = "application/json";
            bodyInit = JSON.stringify(opts.body);
        }

        const res = await fetch(url, { method, headers, body: bodyInit });
        if (res.status === 429) {
            let retryMs = 1000;
            try {
                const j: any = await res.json();
                if (typeof j?.retry_after === "number") retryMs = Math.ceil(j.retry_after * 1000);
            } catch {}
            await Bun.sleep(Math.min(retryMs, 10_000));
            continue;
        }
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`Discord REST ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
        }
        if (res.status === 204) return null;
        return res.json().catch(() => null);
    }
    throw new Error(`Discord REST ${method} ${path} rate-limited after retries.`);
}

export class REST {
    private token = "";
    constructor(_opts?: { version?: string }) {}
    setToken(token: string) { this.token = token; return this; }
    put(path: string, opts: { body: any }) { return restRequest(this.token, "PUT", path, { body: opts.body }); }
}

export const Routes = {
    applicationCommands: (appId: string) => `/applications/${appId}/commands`,
};

// ── Message / channel / interaction wrappers ─────────────────────────────────

function normalizeSendPayload(content: any): { body: any; files?: AttachmentBuilder[] } {
    if (typeof content === "string") return { body: { content } };
    const body: any = {};
    if (content.content !== undefined) body.content = content.content;
    if (content.embeds) body.embeds = content.embeds.map((e: any) => (e.toJSON ? e.toJSON() : e));
    if (content.components) body.components = content.components.map((c: any) => (c.toJSON ? c.toJSON() : c));
    return { body, files: content.files };
}

export class Channel {
    id: string;
    name?: string;
    private client: Client;
    threads: { create: (o: { name: string }) => Promise<Channel> };
    messages: {
        fetch: {
            (arg: string): Promise<Message>;
            (arg: { limit: number }): Promise<Map<string, Message>>;
        };
    };
    constructor(client: Client, id: string, name?: string) {
        this.client = client;
        this.id = id;
        this.name = name;
        this.threads = {
            create: async ({ name }) => {
                const raw = await this.client.request("POST", `/channels/${this.id}/threads`, { body: { name, type: 11 } });
                return new Channel(this.client, raw.id, raw.name);
            },
        };
        this.messages = {
            fetch: (async (arg: any) => {
                if (typeof arg === "string") {
                    const raw = await this.client.request("GET", `/channels/${this.id}/messages/${arg}`);
                    return new Message(this.client, raw);
                }
                const raws: any[] = await this.client.request("GET", `/channels/${this.id}/messages?limit=${arg.limit}`);
                const map = new Map<string, Message>();
                for (const r of raws) map.set(r.id, new Message(this.client, r));
                return map;
            }) as any,
        };
    }
    async send(content: any): Promise<Message> {
        const { body, files } = normalizeSendPayload(content);
        const raw = await this.client.request("POST", `/channels/${this.id}/messages`, { body, files });
        return new Message(this.client, raw);
    }
}

export class Message {
    private client: Client;
    raw: any;
    id: string;
    content: string;
    channelId: string;
    channel: Channel;
    author: { id: string; bot: boolean; username: string; displayName: string };
    createdTimestamp: number;
    reference?: { type: number; messageId?: string };
    mentions: { users: { has: (id: string) => boolean; values: () => any[] } };
    reactions: { cache: { get: (emoji: string) => any; values: () => any[] } };
    attachments: { values: () => any[] };

    constructor(client: Client, raw: any) {
        this.client = client;
        this.raw = raw;
        this.id = raw.id;
        this.content = raw.content ?? "";
        this.channelId = raw.channel_id;
        this.channel = new Channel(client, raw.channel_id);
        this.author = {
            id: raw.author?.id,
            bot: !!raw.author?.bot,
            username: raw.author?.username,
            displayName: raw.author?.global_name || raw.author?.username,
        };
        this.createdTimestamp = raw.timestamp ? Date.parse(raw.timestamp) : Date.now();
        if (raw.message_reference) {
            this.reference = { type: raw.message_reference.type ?? 0, messageId: raw.message_reference.message_id };
        }
        const mentionUsers: any[] = (raw.mentions || []).map((u: any) => ({
            id: u.id, username: u.username, displayName: u.global_name || u.username,
        }));
        this.mentions = {
            users: { has: (id) => mentionUsers.some((u) => u.id === id), values: () => mentionUsers },
        };
        const reactions: any[] = (raw.reactions || []).map((r: any) => ({ emoji: { name: r.emoji?.name }, count: r.count }));
        this.reactions = {
            cache: {
                values: () => reactions,
                // We only ever remove our own reactions, so always hand back a
                // remover regardless of local cache state.
                get: (_emoji: string) => ({
                    users: {
                        remove: async (_id: string) => {
                            const e = encodeURIComponent(_emoji);
                            await this.client.request("DELETE", `/channels/${this.channelId}/messages/${this.id}/reactions/${e}/@me`).catch(() => {});
                        },
                    },
                }),
            },
        };
        const atts: any[] = (raw.attachments || []).map((a: any) => ({
            url: a.url, contentType: a.content_type, size: a.size, name: a.filename,
        }));
        this.attachments = { values: () => atts };
    }

    async reply(content: any): Promise<Message> {
        const { body, files } = normalizeSendPayload(content);
        body.message_reference = { message_id: this.id, channel_id: this.channelId, fail_if_not_exists: false };
        const raw = await this.client.request("POST", `/channels/${this.channelId}/messages`, { body, files });
        return new Message(this.client, raw);
    }
    async edit(content: any): Promise<Message> {
        const { body } = normalizeSendPayload(content);
        const raw = await this.client.request("PATCH", `/channels/${this.channelId}/messages/${this.id}`, { body });
        this.content = raw.content ?? this.content;
        return this;
    }
    async react(emoji: string): Promise<void> {
        const e = encodeURIComponent(emoji);
        await this.client.request("PUT", `/channels/${this.channelId}/messages/${this.id}/reactions/${e}/@me`).catch(() => {});
    }
    async startThread({ name }: { name: string }): Promise<Channel> {
        const raw = await this.client.request("POST", `/channels/${this.channelId}/messages/${this.id}/threads`, { body: { name } });
        return new Channel(this.client, raw.id, raw.name);
    }
    awaitMessageComponent({ componentType, time }: { componentType?: number; time?: number }): Promise<ComponentInteraction> {
        return this.client.awaitComponent(this.id, componentType, time);
    }
    createMessageComponentCollector({ componentType }: { componentType?: number } = {}): ComponentCollector {
        return this.client.createCollector(this.id, componentType);
    }
}

export class ComponentInteraction {
    private client: Client;
    raw: any;
    customId: string;
    componentType: number;
    values: string[];
    user: { id: string; username: string };
    member: any;
    private responded = false;
    constructor(client: Client, raw: any) {
        this.client = client;
        this.raw = raw;
        this.customId = raw.data?.custom_id;
        this.componentType = raw.data?.component_type;
        this.values = raw.data?.values || [];
        const u = raw.member?.user || raw.user;
        this.user = { id: u?.id, username: u?.username };
        this.member = raw.member ? { displayName: raw.member.nick || u?.global_name || u?.username } : null;
    }
    async deferUpdate(): Promise<void> {
        if (this.responded) return;
        this.responded = true;
        await this.client.request("POST", `/interactions/${this.raw.id}/${this.raw.token}/callback`, { body: { type: 6 } }).catch(() => {});
    }
    async reply(content: any): Promise<void> {
        if (this.responded) return;
        this.responded = true;
        const data: any = typeof content === "string" ? { content } : { content: content.content };
        if (typeof content === "object" && content.ephemeral) data.flags = 64;
        await this.client.request("POST", `/interactions/${this.raw.id}/${this.raw.token}/callback`, { body: { type: 4, data } }).catch(() => {});
    }
}

export class CommandInteraction {
    private client: Client;
    raw: any;
    commandName: string;
    user: { id: string; username: string };
    member: any;
    options: { getString: (name: string) => string | null };
    private responded = false;
    constructor(client: Client, raw: any) {
        this.client = client;
        this.raw = raw;
        this.commandName = raw.data?.name;
        const u = raw.member?.user || raw.user;
        this.user = { id: u?.id, username: u?.username };
        this.member = raw.member || null;
        const opts: any[] = raw.data?.options || [];
        this.options = {
            getString: (name) => {
                const o = opts.find((x) => x.name === name);
                return o ? String(o.value) : null;
            },
        };
    }
    isChatInputCommand(): boolean { return this.raw.type === 2; }
    async reply(content: any): Promise<void> {
        if (this.responded) return;
        this.responded = true;
        const data: any = typeof content === "string" ? { content } : content;
        await this.client.request("POST", `/interactions/${this.raw.id}/${this.raw.token}/callback`, { body: { type: 4, data } }).catch(() => {});
    }
}

// A minimal event-emitter-shaped collector: only "collect" and "end" are used.
export class ComponentCollector {
    private collectCbs: ((i: ComponentInteraction) => void)[] = [];
    private endCbs: (() => void)[] = [];
    componentType?: number;
    constructor(componentType?: number) { this.componentType = componentType; }
    on(event: "collect", cb: (i: ComponentInteraction) => void): this;
    on(event: "end", cb: () => void): this;
    on(event: "collect" | "end", cb: any): this {
        if (event === "collect") this.collectCbs.push(cb);
        else this.endCbs.push(cb);
        return this;
    }
    _emit(i: ComponentInteraction) { for (const cb of this.collectCbs) cb(i); }
    _end() { for (const cb of this.endCbs) cb(); }
}

// ── Gateway client ───────────────────────────────────────────────────────────

type Waiter = { componentType?: number; resolve: (i: ComponentInteraction) => void; reject: (e: any) => void; timer?: ReturnType<typeof setTimeout> };

export class Client {
    intents: number;
    user: { id: string; tag: string } | null = null;

    private token = "";
    private ws: WebSocket | null = null;
    private seq: number | null = null;
    private sessionId: string | null = null;
    private resumeUrl: string | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private acked = true;
    private listeners = new Map<string, ((...a: any[]) => void)[]>();
    private onceReady: { resolve: () => void; reject: (e: any) => void } | null = null;
    private readyFired = false;
    private closed = false;

    // Component routing: message id → collectors and one-shot waiters.
    private collectors = new Map<string, ComponentCollector[]>();
    private waiters = new Map<string, Waiter[]>();

    constructor(opts: { intents: number[] | number }) {
        this.intents = Array.isArray(opts.intents) ? opts.intents.reduce((a, b) => a | b, 0) : opts.intents;
    }

    on(event: string, cb: (...a: any[]) => void) {
        const arr = this.listeners.get(event) || [];
        arr.push(cb);
        this.listeners.set(event, arr);
        return this;
    }
    once(event: string, cb: (...a: any[]) => void) {
        const wrap = (...a: any[]) => {
            this.off(event, wrap);
            cb(...a);
        };
        return this.on(event, wrap);
    }
    private off(event: string, cb: (...a: any[]) => void) {
        const arr = this.listeners.get(event);
        if (arr) this.listeners.set(event, arr.filter((f) => f !== cb));
    }
    private emit(event: string, ...a: any[]) {
        for (const cb of this.listeners.get(event) || []) {
            try { cb(...a); } catch (e) { console.error(`[discord] listener for ${event} threw:`, e); }
        }
    }

    request(method: string, path: string, opts: { body?: any; files?: AttachmentBuilder[] } = {}) {
        return restRequest(this.token, method, path, opts);
    }

    login(token: string): Promise<void> {
        this.token = token;
        return new Promise<void>((resolve, reject) => {
            this.onceReady = { resolve, reject };
            this.connect(false);
        });
    }

    destroy() {
        this.closed = true;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        try { this.ws?.close(1000); } catch {}
    }

    // ── component dispatch API (used by Message wrappers) ────────────────────
    awaitComponent(messageId: string, componentType?: number, time?: number): Promise<ComponentInteraction> {
        return new Promise((resolve, reject) => {
            const waiter: Waiter = { componentType, resolve, reject };
            if (time) {
                waiter.timer = setTimeout(() => {
                    this.removeWaiter(messageId, waiter);
                    reject(new Error("Component collector timed out."));
                }, time);
            }
            const arr = this.waiters.get(messageId) || [];
            arr.push(waiter);
            this.waiters.set(messageId, arr);
        });
    }
    private removeWaiter(messageId: string, waiter: Waiter) {
        const arr = this.waiters.get(messageId);
        if (arr) this.waiters.set(messageId, arr.filter((w) => w !== waiter));
    }
    createCollector(messageId: string, componentType?: number): ComponentCollector {
        const collector = new ComponentCollector(componentType);
        const arr = this.collectors.get(messageId) || [];
        arr.push(collector);
        this.collectors.set(messageId, arr);
        return collector;
    }

    // ── gateway internals ────────────────────────────────────────────────────
    private connect(resume: boolean) {
        const base = (resume && this.resumeUrl) ? this.resumeUrl : "wss://gateway.discord.gg";
        this.acked = true;
        const ws = new WebSocket(`${base}/?v=10&encoding=json`);
        this.ws = ws;

        ws.addEventListener("message", (ev) => this.onGatewayMessage(String(ev.data), resume));
        ws.addEventListener("close", (ev) => this.onGatewayClose(ev.code));
        ws.addEventListener("error", () => { /* close event follows */ });
    }

    private send(payload: any) {
        try { this.ws?.send(JSON.stringify(payload)); } catch {}
    }

    private onGatewayMessage(data: string, resuming: boolean) {
        let packet: any;
        try { packet = JSON.parse(data); } catch { return; }
        const { op, d, s, t } = packet;
        if (s !== null && s !== undefined) this.seq = s;

        if (op === 10) { // HELLO
            const interval = d.heartbeat_interval;
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            // First beat after a jittered delay, then on the interval.
            setTimeout(() => this.beat(), Math.floor(interval * 0.5));
            this.heartbeatTimer = setInterval(() => this.beat(), interval);
            if (resuming && this.sessionId) {
                this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
            } else {
                this.send({ op: 2, d: {
                    token: this.token,
                    intents: this.intents,
                    properties: { os: "linux", browser: "opoclaw", device: "opoclaw" },
                } });
            }
            return;
        }
        if (op === 11) { this.acked = true; return; } // HEARTBEAT_ACK
        if (op === 1) { this.beat(); return; } // server-requested heartbeat
        if (op === 7) { this.reconnect(true); return; } // RECONNECT
        if (op === 9) { this.reconnect(!!d); return; } // INVALID_SESSION (d = resumable?)
        if (op === 0) this.onDispatch(t, d);
    }

    private beat() {
        if (!this.acked) { this.reconnect(true); return; } // zombied connection
        this.acked = false;
        this.send({ op: 1, d: this.seq });
    }

    private onDispatch(type: string, d: any) {
        if (type === "READY") {
            this.user = { id: d.user.id, tag: `${d.user.username}` };
            this.sessionId = d.session_id;
            this.resumeUrl = d.resume_gateway_url || null;
            if (!this.readyFired) {
                this.readyFired = true;
                this.onceReady?.resolve();
                this.onceReady = null;
            }
            this.emit(Events.ClientReady, this);
            return;
        }
        if (type === "RESUMED") return;
        if (type === "MESSAGE_CREATE") {
            this.emit(Events.MessageCreate, new Message(this, d));
            return;
        }
        if (type === "INTERACTION_CREATE") {
            if (d.type === 2) { // APPLICATION_COMMAND
                this.emit(Events.InteractionCreate, new CommandInteraction(this, d));
            } else if (d.type === 3) { // MESSAGE_COMPONENT
                this.routeComponent(new ComponentInteraction(this, d), d.message?.id);
            }
        }
    }

    private routeComponent(interaction: ComponentInteraction, messageId?: string) {
        if (!messageId) return;
        const waiters = this.waiters.get(messageId) || [];
        for (const w of waiters) {
            if (w.componentType && interaction.componentType !== w.componentType) continue;
            if (w.timer) clearTimeout(w.timer);
            this.removeWaiter(messageId, w);
            w.resolve(interaction);
            return;
        }
        for (const c of this.collectors.get(messageId) || []) {
            if (c.componentType && interaction.componentType !== c.componentType) continue;
            c._emit(interaction);
        }
    }

    private onGatewayClose(code: number) {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        if (this.closed) return;
        // Fatal codes: bad auth / invalid intents — do not retry.
        const fatal = [4004, 4010, 4011, 4012, 4013, 4014];
        if (fatal.includes(code)) {
            const err = new Error(`Discord gateway closed with fatal code ${code}.`);
            if (this.onceReady) { this.onceReady.reject(err); this.onceReady = null; }
            else console.error(`[discord] ${err.message}`);
            return;
        }
        this.reconnect(true);
    }

    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnect(resume: boolean) {
        if (this.closed) return;
        try { this.ws?.close(); } catch {}
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect(resume && !!this.sessionId);
        }, 1500);
    }
}

// ── Types re-exported for annotations (drop-in for discord.js type imports) ──

export type TextChannel = Channel;
export type User = { id: string; username: string; displayName: string; bot?: boolean };
export type ReactionManager = { cache: { values: () => any[] } };
export type MessagePayload = any;
export type MessageReplyOptions = { content?: string; embeds?: any[]; components?: any[]; files?: AttachmentBuilder[] };
