# Bun WebView Tool - Usage Guide

## Overview

The WebView tool provides a complete, interactive browser automation interface for the AI model. It uses Bun's built-in WebView API (powered by WKWebView on macOS and Chrome DevTools Protocol on Linux/Windows) to control a headless browser with full interactivity including clicks, typing, scrolling, and screenshots.

## Configuration

Enable the webview tool in `config.toml`:

```toml
enable_webview = true
```

The tool is optional and can be disabled by setting this to `false` or removing it.

## Available Tools

### 1. **webview_navigate**
Navigate to a URL or create a new webview instance.

```
Parameters:
  - url (required): The URL to navigate to
  - webview_id (optional): Reuse existing webview ID

Returns: webview_id for use in subsequent operations
```

**Example:**
- "Navigate to https://example.com"
- "Open the file at file:///home/user/page.html in webview-1"

---

### 2. **webview_click**
Click on elements by CSS selector or viewport coordinates.

```
Parameters:
  - webview_id (required): The webview to interact with
  - target (required): CSS selector (e.g., "button.submit") or coordinates "x,y"
  - button (optional): "left" (default), "right", or "middle"
  - double_click (optional): true for double-click

Returns: Confirmation of click action
```

**Examples:**
- "Click the submit button: webview_id=webview-1, target=button.submit"
- "Right-click at coordinates 150,200 in webview-1"
- "Double-click the input field with selector #username"

---

### 3. **webview_type**
Type text into the currently focused element.

```
Parameters:
  - webview_id (required)
  - text (required): Text to type

Returns: Confirmation of typed text
```

**Example:**
- "Type 'hello world' into the focused input"

---

### 4. **webview_press**
Press keyboard keys or key combinations.

```
Parameters:
  - webview_id (required)
  - key (required): Named keys (Enter, Tab, Escape, ArrowUp, ArrowDown, etc.)
                     or single characters
  - modifiers (optional): Comma-separated modifiers (Shift, Control, Alt, Meta)

Returns: Confirmation of key press
```

**Examples:**
- "Press Enter"
- "Press Ctrl+A to select all"
- "Press Escape to close the modal"

---

### 5. **webview_scroll**
Scroll the page by pixels or scroll elements into view.

```
Parameters:
  - webview_id (required)
  - action (required): "by" for delta scroll, "to" for scroll into view
  - dx_or_selector (required): For "by"=delta X, for "to"=CSS selector
  - dy (optional): For "by" action only, vertical delta
  - block (optional): For "to" action, "start", "center" (default), or "nearest"

Returns: Confirmation of scroll action
```

**Examples:**
- "Scroll down 500 pixels"
- "Scroll left 100 pixels"
- "Scroll the footer into view"
- "Scroll #hero into view at the top (start)"

---

### 6. **webview_screenshot**
Capture and save a screenshot of the current viewport.

```
Parameters:
  - webview_id (required)
  - path (required): File path to save (e.g., "screenshot.png")
  - format (optional): "png" (default), "jpeg", or "webp"
  - quality (optional): 0-100 for jpeg/webp (default 80)

Returns: File path and size information
```

**Examples:**
- "Take a screenshot and save it as page.png"
- "Capture as JPEG with quality 90 to output.jpg"

---

### 7. **webview_evaluate**
Run JavaScript expressions in the page and get results.

```
Parameters:
  - webview_id (required)
  - script (required): JavaScript expression (must return a value)

Returns: Evaluation result (JSON serialized)
```

**Examples:**
- "Get the page title: document.title"
- "Get all links: [...document.querySelectorAll('a')].map(a => a.href)"
- "Check if element exists: document.querySelector('#id') !== null"
- "Get form values: Object.fromEntries(new FormData(document.querySelector('form')))"

---

### 8. **webview_get_content**
Extract page content (HTML, text, or specific elements).

```
Parameters:
  - webview_id (required)
  - content_type (required): "html", "text", "title", or CSS selector

Returns: Page content (truncated to 5000 chars if HTML/text)
```

**Examples:**
- "Get the page HTML"
- "Get the page text"
- "Get the page title"
- "Get all article elements: article.post"
- "Extract all form inputs: input[type='text']"

---

### 9. **webview_fill**
Fill an input field or textarea with text (click, select all, type).

```
Parameters:
  - webview_id (required)
  - selector (required): CSS selector of input/textarea
  - value (required): Text to fill

Returns: Confirmation of fill action
```

**Example:**
- "Fill the email input with user@example.com"

---

### 10. **webview_resize**
Resize the webview viewport.

```
Parameters:
  - webview_id (required)
  - width (required): 1-16384 pixels
  - height (required): 1-16384 pixels

Returns: Confirmation of new size
```

**Example:**
- "Resize to 1920x1080"
- "Set mobile viewport: 375x667"

---

### 11. **webview_reload**
Reload the current page.

```
Parameters:
  - webview_id (required)

Returns: New page title
```

---

### 12. **webview_history**
Navigate back or forward in history.

```
Parameters:
  - webview_id (required)
  - direction (required): "back" or "forward"

Returns: New URL
```

---

### 13. **webview_list**
List all active webview instances.

```
Parameters: None

Returns: List of active webviews with URLs and titles
```

---

### 14. **webview_close**
Close a webview instance or all webviews.

```
Parameters:
  - webview_id (required): Specific ID or "all"

Returns: Confirmation of closed instance(s)
```

## Complete Workflow Example

Here's a complete example of automating a form submission:

1. **Create a webview and navigate:**
   ```
   webview_navigate: url="https://example.com/form"
   → Returns: webview-1
   ```

2. **Fill form fields:**
   ```
   webview_fill: webview_id="webview-1", selector="input#email", value="test@example.com"
   webview_fill: webview_id="webview-1", selector="input#password", value="secretpass"
   ```

3. **Click submit button:**
   ```
   webview_click: webview_id="webview-1", target="button[type='submit']"
   ```

4. **Wait for page and capture screenshot:**
   ```
   webview_evaluate: webview_id="webview-1", script="document.readyState === 'complete'"
   webview_screenshot: webview_id="webview-1", path="success.png"
   ```

5. **Get confirmation message:**
   ```
   webview_get_content: webview_id="webview-1", content_type=".success-message"
   ```

6. **Close the webview:**
   ```
   webview_close: webview_id="webview-1"
   ```

## Features

- **Full interactivity:** Click, type, press keys, scroll like a real user
- **Native events:** Events have `isTrusted: true`, indistinguishable from real user input
- **JavaScript execution:** Run arbitrary JS and get JSON results
- **Screenshots:** Capture as PNG, JPEG, or WebP
- **History navigation:** Go back/forward through browser history
- **Multiple instances:** Manage multiple webviews simultaneously
- **Persistent storage (optional):** Configure data directory for cookies/localStorage
- **Cross-platform:** WKWebView on macOS, Chrome DevTools Protocol on Linux/Windows

## Technical Details

- **Backend (macOS):** WKWebView via lightweight host subprocess
- **Backend (Linux/Windows):** Chrome/Chromium via CDP (requires browser installed)
- **Viewport:** Default 1280x720, resizable 1-16384 pixels
- **Storage:** Ephemeral by default (in-memory)
- **Concurrency:** One operation per slot per webview (events queue naturally)

## Notes

- The tool manages webview instances in memory during the session
- Each webview runs in a separate renderer process
- Screenshots can be base64-encoded or saved directly
- JavaScript errors in evaluate() are reported as tool errors
- The model can keep multiple webviews open simultaneously
