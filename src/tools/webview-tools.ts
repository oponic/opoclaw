import { defineTool, type ToolDefinition } from "./types.ts";
import { getChromiumPath, type OpoclawConfig } from "../config.ts";

// Global webview instances storage
const WEBVIEW_INSTANCES = new Map<string, Bun.WebView>();
let NEXT_WEBVIEW_ID = 1;

const isWebViewEnabled = (config: { enable_webview?: boolean }) => {
    // Check if WebView is enabled AND we're not on a Windows system with broken Chrome spawning
    const enabled = config.enable_webview ?? false;
    if (!enabled) return false;
    
    // On Windows, WebView spawning may fail even with Chrome installed due to Bun bugs
    // Users should upgrade Bun or use alternatives
    if (process.platform === "win32") {
        console.warn("[webview] WebView on Windows may have spawning issues. If it fails, try:");
        console.warn("  - Closing all Chrome/Edge browser windows");
        console.warn("  - Upgrading Bun to the latest version");
        console.warn("  - Disabling webview and using fetch/web APIs instead");
    }
    
    return enabled;
};

async function initializeWebView(url: string, config: OpoclawConfig): Promise<string> {
    try {
        const chromiumPath = getChromiumPath(config);
        
        // Try with explicit path first if configured
        if (chromiumPath) {
            try {
                const view = new Bun.WebView({
                    width: 1280,
                    height: 720,
                    url,
                    backend: { type: "chrome", path: chromiumPath },
                });
                const id = `webview-${NEXT_WEBVIEW_ID++}`;
                WEBVIEW_INSTANCES.set(id, view);
                return id;
            } catch (pathError) {
                console.warn(`[webview] Failed with configured path (${chromiumPath}): ${String(pathError)}`);
                console.warn(`[webview] Attempting fallback: auto-detection without explicit path`);
            }
        }
        
        // Fallback: try auto-detection without explicit path
        try {
            const view = new Bun.WebView({
                width: 1280,
                height: 720,
                url,
                backend: { type: "chrome", url: false }, // Force spawn, skip auto-detect of running instances
            });
            const id = `webview-${NEXT_WEBVIEW_ID++}`;
            WEBVIEW_INSTANCES.set(id, view);
            return id;
        } catch (autoError) {
            console.warn(`[webview] Auto-detection also failed: ${String(autoError)}`);
            throw new Error(`Failed to create webview: Chrome/Chromium could not be started. Ensure Chrome is installed and not blocked by antivirus. Configured path: ${chromiumPath || 'none'}`);
        }
    } catch (error) {
        throw new Error(`Failed to create webview: ${String(error)}`);
    }
}

function getWebView(id: string): Bun.WebView {
    const view = WEBVIEW_INSTANCES.get(id);
    if (!view) {
        throw new Error(`WebView "${id}" not found. Create one first with webview_navigate.`);
    }
    return view;
}

export const WEBVIEW_TOOLS = {
    webview_navigate: defineTool(
        "webview_navigate",
        "Navigate to a URL in a webview. Returns a webview ID that can be used for subsequent operations.",
        {
            url: {
                type: "string",
                description: "The URL to navigate to (e.g., 'https://example.com', 'file:///path/to/page.html')",
            },
            webview_id: {
                type: "string",
                description: "Optional: existing webview ID to reuse. If not provided, a new webview is created.",
            },
        },
        ["url"],
        {
            enabled: isWebViewEnabled,
            handler: async (args, context) => {
                const url = String(args.url);
                let viewId = args.webview_id ? String(args.webview_id) : null;

                if (viewId && !WEBVIEW_INSTANCES.has(viewId)) {
                    throw new Error(`WebView "${viewId}" not found.`);
                }

                if (!viewId) {
                    viewId = await initializeWebView(url, context.config);
                } else {
                    const view = getWebView(viewId);
                    await view.navigate(url);
                }

                const view = getWebView(viewId);
                return `Navigated to ${view.url} (webview_id: ${viewId}). Title: "${view.title}"`;
            },
        },
    ),

    webview_click: defineTool(
        "webview_click",
        "Click on an element in the webview. Can click by CSS selector or by viewport coordinates.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to interact with",
            },
            target: {
                type: "string",
                description: "CSS selector (e.g., 'button.submit', '#login-btn') or 'x,y' for coordinates (e.g., '150,200')",
            },
            button: {
                type: "string",
                description: "Mouse button: 'left' (default), 'right', or 'middle'",
            },
            double_click: {
                type: "boolean",
                description: "If true, perform a double-click instead of single click",
            },
        },
        ["webview_id", "target"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                const target = String(args.target);
                const button = String(args.button || "left");
                const doubleClick = Boolean(args.double_click);
                const clickCount = doubleClick ? (2 as const) : (1 as const);

                if (target.includes(",")) {
                    const [xRaw, yRaw] = target.split(",");
                    const x = Number.parseInt(xRaw?.trim() ?? "", 10);
                    const y = Number.parseInt(yRaw?.trim() ?? "", 10);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) {
                        throw new Error("Invalid coordinates format. Use 'x,y' (e.g., '150,200')");
                    }
                    const options = {
                        button: button as "left" | "right" | "middle",
                        clickCount,
                    };
                    await view.click(x, y, options);
                    return `Clicked at (${x}, ${y}) with ${button} button${doubleClick ? " (double-click)" : ""}.`;
                } else {
                    const options = {
                        button: button as "left" | "right" | "middle",
                        clickCount,
                        timeout: 30000,
                    };
                    await view.click(target, options);
                    return `Clicked on "${target}" with ${button} button${doubleClick ? " (double-click)" : ""}.`;
                }
            },
        },
    ),

    webview_type: defineTool(
        "webview_type",
        "Type text into the focused element in the webview.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to interact with",
            },
            text: {
                type: "string",
                description: "The text to type",
            },
        },
        ["webview_id", "text"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                const text = String(args.text);
                await view.type(text);
                return `Typed "${text}" into focused element.`;
            },
        },
    ),

    webview_press: defineTool(
        "webview_press",
        "Press a key or key combination in the webview.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to interact with",
            },
            key: {
                type: "string",
                description: "Named key (Enter, Tab, Space, Escape, ArrowUp, ArrowDown, etc.) or single character",
            },
            modifiers: {
                type: "string",
                description: "Comma-separated modifiers: Shift, Control, Alt, Meta (e.g., 'Control,Shift')",
            },
        },
        ["webview_id", "key"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                const key = String(args.key);
                const modifiersStr = args.modifiers ? String(args.modifiers) : "";
                const modifiers = modifiersStr
                    .split(",")
                    .map((m) => m.trim())
                    .filter((m) => m.length > 0) as Array<"Shift" | "Control" | "Alt" | "Meta">;

                const options = modifiers.length > 0 ? { modifiers } : undefined;
                await view.press(key, options);
                return `Pressed "${key}"${modifiers.length > 0 ? ` with modifiers: ${modifiers.join(", ")}` : ""}.`;
            },
        },
    ),

    webview_scroll: defineTool(
        "webview_scroll",
        "Scroll the webview by a pixel amount or scroll element into view.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to interact with",
            },
            action: {
                type: "string",
                description: "'by' for pixel delta scroll, 'to' for scroll element into view",
            },
            dx_or_selector: {
                type: "string",
                description: "For 'by': horizontal delta (positive=right, negative=left). For 'to': CSS selector",
            },
            dy: {
                type: "number",
                description: "For 'by' action only: vertical delta (positive=down, negative=up)",
            },
            block: {
                type: "string",
                description: "For 'to' action only: 'start', 'center' (default), or 'nearest'",
            },
        },
        ["webview_id", "action", "dx_or_selector"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                const action = String(args.action);

                if (action === "by") {
                    const dx = parseInt(String(args.dx_or_selector), 10);
                    const dy = parseInt(String(args.dy || 0), 10);
                    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
                        throw new Error("Invalid scroll deltas. Must be integers.");
                    }
                    await view.scroll(dx, dy);
                    return `Scrolled by (${dx}, ${dy}) pixels.`;
                } else if (action === "to") {
                    const selector = String(args.dx_or_selector);
                    const block = (args.block ? String(args.block) : "center") as "start" | "center" | "nearest";
                    await view.scrollTo(selector, { block });
                    return `Scrolled element "${selector}" into view (${block}).`;
                } else {
                    throw new Error("action must be 'by' or 'to'");
                }
            },
        },
    ),

    webview_screenshot: defineTool(
        "webview_screenshot",
        "Capture a screenshot of the webview and save it to a file.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to capture from",
            },
            path: {
                type: "string",
                description: "Path to save the screenshot (should end with .png, .jpg, or .webp)",
            },
            format: {
                type: "string",
                description: "'png' (default, lossless), 'jpeg' (lossy), or 'webp'",
            },
            quality: {
                type: "number",
                description: "For jpeg/webp: quality 0-100 (default 80)",
            },
        },
        ["webview_id", "path"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                const path = String(args.path);
                const format = (args.format ? String(args.format) : "png") as "png" | "jpeg" | "webp";
                const quality = args.quality ? Math.min(100, Math.max(0, Number(args.quality))) : 80;

                const options = {
                    format,
                    quality: format === "png" ? undefined : quality,
                    encoding: "blob" as const,
                };

                const screenshot = await view.screenshot(options);
                await Bun.write(path, screenshot);
                return `Screenshot saved to ${path} (${format.toUpperCase()}, size: ${(screenshot as Blob).size} bytes).`;
            },
        },
    ),

    webview_evaluate: defineTool(
        "webview_evaluate",
        "Run JavaScript code in the webview and return the result. The code must be an expression (return a value).",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to interact with",
            },
            script: {
                type: "string",
                description: "JavaScript expression to evaluate (must return a value, not statements)",
            },
        },
        ["webview_id", "script"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                const script = String(args.script);

                try {
                    const result = await view.evaluate(script);
                    // Serialize result nicely
                    let resultStr: string;
                    if (typeof result === "string") {
                        resultStr = result;
                    } else if (typeof result === "object" && result !== null) {
                        resultStr = JSON.stringify(result, null, 2);
                    } else {
                        resultStr = String(result);
                    }
                    return `Evaluation result:\n${resultStr}`;
                } catch (error) {
                    throw new Error(`Script execution failed: ${String(error)}`);
                }
            },
        },
    ),

    webview_get_content: defineTool(
        "webview_get_content",
        "Get the current page content (HTML, text, or specific elements) from the webview.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to interact with",
            },
            content_type: {
                type: "string",
                description: "'html' (full HTML), 'text' (innerText), 'title', or CSS selector for specific elements",
            },
        },
        ["webview_id", "content_type"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                const contentType = String(args.content_type);

                if (contentType === "html") {
                    const html = await view.evaluate("document.documentElement.outerHTML");
                    return `Page HTML (first 5000 chars):\n${String(html).slice(0, 5000)}${String(html).length > 5000 ? "\n...(truncated)" : ""}`;
                } else if (contentType === "text") {
                    const text = await view.evaluate("document.body.innerText");
                    return `Page text (first 5000 chars):\n${String(text).slice(0, 5000)}${String(text).length > 5000 ? "\n...(truncated)" : ""}`;
                } else if (contentType === "title") {
                    return `Page title: "${view.title}"`;
                } else {
                    // Treat as CSS selector
                    const selector = contentType.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
                    const elements = await view.evaluate(
                        `Array.from(document.querySelectorAll('${selector}'))
                            .slice(0, 10)
                            .map(el => ({
                                text: el.innerText || el.textContent || '',
                                html: el.outerHTML,
                                classes: el.className
                            }))`,
                    );
                    if (Array.isArray(elements) && elements.length > 0) {
                        return `Found ${elements.length} element(s) matching "${contentType}":\n${JSON.stringify(elements, null, 2)}`;
                    } else {
                        return `No elements found matching selector "${contentType}".`;
                    }
                }
            },
        },
    ),

    webview_fill: defineTool(
        "webview_fill",
        "Fill an input field or textarea with text. First clicks the element, then clears it, then types the text.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to interact with",
            },
            selector: {
                type: "string",
                description: "CSS selector of the input/textarea element",
            },
            value: {
                type: "string",
                description: "The text to fill into the element",
            },
        },
        ["webview_id", "selector", "value"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                const selector = String(args.selector);
                const value = String(args.value);

                await view.click(selector, { timeout: 30000 });
                await view.press("a", { modifiers: ["Control"] }); // Select all
                await view.type(value);
                return `Filled "${selector}" with value: "${value}"`;
            },
        },
    ),

    webview_resize: defineTool(
        "webview_resize",
        "Resize the webview viewport.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to resize",
            },
            width: {
                type: "number",
                description: "New width in pixels (1-16384)",
            },
            height: {
                type: "number",
                description: "New height in pixels (1-16384)",
            },
        },
        ["webview_id", "width", "height"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                const width = Number(args.width);
                const height = Number(args.height);

                if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16384 || height > 16384) {
                    throw new Error("Width and height must be integers between 1 and 16384");
                }

                await view.resize(width, height);
                return `Resized webview to ${width}x${height} pixels.`;
            },
        },
    ),

    webview_reload: defineTool(
        "webview_reload",
        "Reload the current page in the webview.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to reload",
            },
        },
        ["webview_id"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                await view.reload();
                return `Reloaded page. New title: "${view.title}"`;
            },
        },
    ),

    webview_history: defineTool(
        "webview_history",
        "Navigate back or forward in the webview history.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to interact with",
            },
            direction: {
                type: "string",
                description: "'back' to go to previous page, 'forward' to go to next page",
            },
        },
        ["webview_id", "direction"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const view = getWebView(String(args.webview_id));
                const direction = String(args.direction);

                if (direction === "back") {
                    await view.back();
                    return `Navigated back. Current URL: ${view.url}`;
                } else if (direction === "forward") {
                    await view.forward();
                    return `Navigated forward. Current URL: ${view.url}`;
                } else {
                    throw new Error("direction must be 'back' or 'forward'");
                }
            },
        },
    ),

    webview_list: defineTool(
        "webview_list",
        "List all active webview instances.",
        {},
        [],
        {
            enabled: isWebViewEnabled,
            handler: async () => {
                if (WEBVIEW_INSTANCES.size === 0) {
                    return "No active webviews.";
                }

                const instances = Array.from(WEBVIEW_INSTANCES.entries())
                    .map(([id, view]) => `• ${id}: ${view.url} (title: "${view.title}")`)
                    .join("\n");

                return `Active webviews (${WEBVIEW_INSTANCES.size}):\n${instances}`;
            },
        },
    ),

    webview_close: defineTool(
        "webview_close",
        "Close a webview instance and free its resources.",
        {
            webview_id: {
                type: "string",
                description: "The webview ID to close, or 'all' to close all webviews",
            },
        },
        ["webview_id"],
        {
            enabled: isWebViewEnabled,
            handler: async (args) => {
                const webviewId = String(args.webview_id);

                if (webviewId === "all") {
                    const count = WEBVIEW_INSTANCES.size;
                    for (const view of WEBVIEW_INSTANCES.values()) {
                        view.close();
                    }
                    WEBVIEW_INSTANCES.clear();
                    return `Closed all ${count} webview instance(s).`;
                } else {
                    const view = getWebView(webviewId);
                    view.close();
                    WEBVIEW_INSTANCES.delete(webviewId);
                    return `Closed webview "${webviewId}".`;
                }
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;
