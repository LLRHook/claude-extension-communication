# Blade Bridge

**CLI-to-Chrome-extension bridge with a Rust Native Messaging host.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

## What It Does

Blade Bridge lets you control Chrome from your terminal. It connects a Node.js CLI to a Chrome extension through a Rust host using Chrome's Native Messaging protocol. There are no network ports, HTTP servers, or npm runtime dependencies.

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

Multiple CLI clients can use the same host concurrently. The host assigns unique request IDs on the Chrome connection and returns each response only to its requesting client, restoring the original ID. Extension notifications are broadcast to connected clients.

## Quick Start

Node.js 18 or newer is required for the CLI and launcher. Packages include a Rust
host for the platform/architecture used to build them. Installing from source or
on another platform requires Rust 1.85 or newer and Cargo on `PATH`; installation
builds the matching host locally from the locked dependencies. The host never
downloads or compiles code at launch time.

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

Commands exit with status `0` after a successful response and status `1` for RPC errors, protocol errors, or a host disconnect before the response. Output is flushed before the process exits, including when redirected to a file or another command.

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

- **Host mode** -- When Chrome spawns the process with a `chrome-extension://` argument, the Node launcher starts the packaged `native/bin/blade-host-<platform>-<arch>` binary (`.exe` on Windows), inheriting stdin/stdout directly. Rust owns native-endian framing, strict UTF-8/JSON validation, JSON-RPC routing, IPC connections and shutdown. One Rust process serves all clients; no subprocess is started per command.

- **CLI mode** -- When run from the terminal, it connects to the IPC socket and sends JSON-RPC 2.0 messages. In one-shot mode, it sends a single request and exits after receiving the response. In interactive mode, it opens a REPL.

The extension's service worker connects to the host via `chrome.runtime.connectNative` and dispatches incoming RPC calls to the `handlers` map, returning results or errors over the same channel. It auto-reconnects with exponential backoff if the host disconnects.

Frames are limited to 1 MiB toward Chrome and 64 MiB from the extension, following [Chrome's native messaging limits](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). Invalid client frames disconnect that client; invalid or truncated Chrome frames shut down the host and close its clients. Results from commands still running on a disconnected extension port are discarded instead of being sent through a new connection.

The host preserves a socket used by another running host and recovers stale Unix sockets after an abrupt exit. Unix sockets are created with mode `0600`. Stale recovery requires an owned socket, a refused connection, and unchanged filesystem identity. An adjacent `.lock` file serializes host lifetimes and stale recovery; this file remains after exit and is never truncated or deleted. Regular files, symlinks, directories and sockets owned by another user are preserved. Shutdown removes only the socket the host created. Windows uses a local named pipe and refuses a second host instance.

Output is bounded by message count and bytes. A stalled client is disconnected
without blocking other clients. On Windows, IPC writes use at most 64 KiB per
transport operation and retain the queued frame's byte budget until the last
pending write completes. Aborting a client disconnects its named pipe, cancelling
pending output. A failed or stalled Chrome output shuts down the host. Writes
have a 10-second deadline. Clean native-input EOF and termination signals stop
new input and drain already accepted output within one shared write deadline;
malformed input and output errors abort immediately. An unread client can lose
its remaining output when that shutdown deadline expires. The host permits at most 32 clients and
1,024 pending requests per client and a shared 16 MiB budget for saved request IDs;
overload disconnects the sending client. It
does not impose a command execution timeout, so methods such as `tabs.waitForLoad`
retain their extension-side timeout behavior. Notifications never allocate a
pending request or receive an RPC result.

## Development and Packaging

```sh
npm run build:host
npm test
npm run test:rust
cargo fmt --manifest-path native/Cargo.toml --check
cargo clippy --locked --manifest-path native/Cargo.toml --all-targets -- -D warnings
npm pack
```

`build:host` compiles the locked Rust host and copies it to `native/bin/` for the
current platform/architecture. It honors `CARGO_TARGET_DIR`. `npm pack` runs this
build and includes the binary, Rust sources, Cargo lockfile and local build
scripts. `postinstall` builds only when the matching binary is absent. After
editing Rust, rebuild before running the Node integration tests. `install` refuses
to write a native manifest if the binary is missing; `doctor` reports that case.

The PR CI checks the exact head on Node 18/20/22 across Linux, Windows and macOS,
including the real Rust host and Node launcher. Backpressure tests keep peers
unread, exercise independent clients and late responses, and bound teardown.
Windows Rust tests also check overlapped-write completion, cancellation, chunk
size and graceful delivery of the final bytes. Platform-specific Unix filesystem
and signal tests retain their Windows skips.

Tests use synthetic extension frames, temporary sockets, and an isolated
temporary HOME for manifest installation. They never launch a browser or register
a Windows native host. The JavaScript extension, CLI, setup commands and protocol
helpers remain in JavaScript; the host core runs exclusively in Rust.

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
