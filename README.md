# Blade Bridge

**Zero-dependency CLI-to-Chrome-extension bridge via Native Messaging.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

## What It Does

Blade Bridge lets you control Chrome from your terminal. It connects a CLI to a Chrome extension through Chrome's Native Messaging protocol -- no network ports, no HTTP servers, no dependencies. The entire bridge is ~330 lines of JavaScript.

## Architecture

```
+-----------+         IPC socket         +--------+     stdin/stdout     +-----------+
|           | <========================> |        | <==================> |  Chrome   |
|    CLI    |    (named pipe / unix)      |  Host  |   (native message   | Extension |
|           |                            |        |    4-byte + JSON)    |           |
+-----------+         blade-bridge       +--------+   spawned by Chrome  +-----------+

              blade-bridge ping
              blade-bridge tabs.list
              blade-bridge (interactive)
```

Chrome spawns the Host process automatically when the extension connects via `connectNative`. The Host opens an IPC socket so the CLI can send commands at any time. Messages flow bidirectionally through the same channel.

## Quick Start

1. Install the CLI globally:
   ```sh
   npm install -g blade-bridge
   ```

2. Load the extension in Chrome:
   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** and select the `extension/` directory

3. Copy the **Extension ID** shown on the extensions page.

4. Register the native messaging host:
   ```sh
   blade-bridge install <extension-id>
   ```

5. Reload the extension in Chrome, then test:
   ```sh
   blade-bridge ping
   ```

## Usage

### One-shot mode

Pass the method (and optional JSON params) as arguments:

```sh
blade-bridge ping
```
```json
{
  "pong": true,
  "timestamp": 1711234567890
}
```

```sh
blade-bridge tabs.list
```
```json
[
  { "id": 123, "url": "https://example.com", "title": "Example" },
  { "id": 456, "url": "https://github.com", "title": "GitHub" }
]
```

```sh
blade-bridge tabs.open '{"url": "https://example.com"}'
```

### Interactive mode

Run without arguments to enter the REPL:

```sh
blade-bridge
blade> ping
{ "pong": true, "timestamp": 1711234567890 }
blade> tabs.list
[ ... ]
blade> quit
```

## Available Methods

| Method              | Params                                      | Returns                            |
|---------------------|---------------------------------------------|------------------------------------|
| `ping`              | none                                        | `{ pong: true, timestamp }`        |
| `tabs.list`         | optional query object (e.g. `{ active: true }`) | array of Tab objects           |
| `tabs.open`         | `{ url }` and any `chrome.tabs.create` opts | Tab object                         |
| `tabs.close`        | `{ tabId }`                                 | `{ ok: true }`                     |
| `tabs.navigate`     | `{ tabId, url }`                            | Tab object                         |
| `tabs.executeScript`| `{ tabId, code }`                           | script return value (via chrome.debugger) |
| `tabs.detachDebugger`| `{ tabId }`                                | `{ ok: true }`                     |
| `tabs.waitForLoad`  | `{ tabId, timeout? }`                       | `{ ok: true }`                     |
| `tabs.screenshot`   | `{ windowId?, format? }`                    | base64 data URI                    |
| `extension.getPopupUrl` | `{ extensionId, popup? }`               | `{ url }`                          |

## Adding Custom Methods

Add a handler to the `handlers` object in `extension/background.js`:

```js
handlers['bookmarks.list'] = (params) => chrome.bookmarks.getTree()
```

Restart the extension. The new method is immediately available from the CLI:

```sh
blade-bridge bookmarks.list
```

## How It Works

The `blade.js` entry point serves as a **dual-mode binary**:

- **Host mode** -- When Chrome spawns the process with a `chrome-extension://` argument, it starts the Native Messaging host. The host reads/writes Chrome's stdin/stdout using the native messaging protocol (4-byte little-endian length prefix + JSON payload) and opens an IPC socket (named pipe on Windows, Unix socket elsewhere) for CLI connections.

- **CLI mode** -- When run from the terminal, it connects to the IPC socket and sends JSON-RPC 2.0 messages. In one-shot mode, it sends a single request and exits after receiving the response. In interactive mode, it opens a REPL.

The extension's service worker connects to the host via `chrome.runtime.connectNative` and dispatches incoming RPC calls to the `handlers` map, returning results or errors over the same channel. It auto-reconnects with exponential backoff if the host disconnects.

## Platform Support

| Platform | Native Messaging Manifest Location |
|----------|-------------------------------------|
| Windows  | Registry key `HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.blade.bridge` pointing to the JSON manifest in the project directory |
| macOS    | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.blade.bridge.json` |
| Linux    | `~/.config/google-chrome/NativeMessagingHosts/com.blade.bridge.json` |

## Uninstall

```sh
blade-bridge uninstall
```

This removes the native messaging manifest (and the registry key on Windows). Remove the extension from `chrome://extensions` separately.

## Security

- **No network ports** -- The host communicates exclusively over stdin/stdout (to Chrome) and a local IPC socket (to the CLI). Nothing listens on a TCP port.
- **Extension ID pinning** -- The native messaging manifest restricts connections to the specific extension ID provided during `blade-bridge install`.
- **Local-only IPC** -- The named pipe / Unix socket is scoped to the current user.

## License

[MIT](LICENSE)
