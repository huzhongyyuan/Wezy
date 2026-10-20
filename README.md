# Wezy

A lightweight desktop workspace for **Claude Code and Codex**, built with Electron and xterm.js. 中文界面，支持项目终端、双窗格和本机会话管理。

## Download / 安装

Download the macOS Apple Silicon (`arm64`) DMG or ZIP from [Releases](https://github.com/huzhongyyuan/Wezy/releases/latest). Open the DMG and drag **Wezy.app** into Applications, or extract the ZIP.

The initial release is ad-hoc signed, **not Apple Developer ID signed or notarized**. macOS may block first launch; use System Settings → Privacy & Security → Open Anyway after checking the release and checksum. There is no automatic updater.

Install and sign in to Claude Code and/or Codex separately before using their terminals. Wezy ships no API keys, accounts or model credits. It uses your local CLI configuration, including provider, model and permissions. You do not need a provider named `shared` or `codexcn`.

Only macOS Apple Silicon has been built and checked for this release. Windows/Linux build targets exist in the project but are not validated release platforms.

## Features / 功能

- Claude and Codex terminal panes, each with its own tab bar.
- Drag to reorder sessions; hover near an edge to scroll through long lists. Arrow buttons keep the moved session visible.
- Keep terminal output and exit details after a process exits; reopen explicitly. On macOS, closing a window with live terminals hides it; quitting the app still ends them.
- Bind local Claude sessions to their actual running process so reopening can use the original conversation UUID.
- Terminal history, preserved reading position during output, and a return-to-latest button.
- Import local Claude sessions; synchronize local Codex session names, pins and archive state.
- Local Claude usage summaries and connection diagnostics.
- Optional Anthropic-compatible gateway profiles; changes apply to newly opened terminals.

Codex session metadata requires `state_5.sqlite` and `/usr/bin/sqlite3`. Both current section-based pins (`thread_section_id` / `section_position`) and the legacy `is_pinned` layout are supported. Incompatible schemas show a synchronization error and retain the previous list. Archive operations use the installed Codex app-server protocol.

When the official Codex desktop configuration already contains discovered SSH connections and their data directories, Wezy also reads their pinned session metadata over noninteractive SSH (remote Python 3 required). It does not start remote tasks. Remote entries open a `codex://` link for the owning desktop; this requires a compatible Codex desktop app, and real cross-host navigation has not been verified for this release. Remote failures are shown with a stale-data warning.

## Build from source

Use Node.js 20 or 22 and npm. On macOS, install Xcode Command Line Tools (`xcode-select --install`) for node-pty.

```sh
npm ci
npm start
npm run dist:mac
```

`npm ci` rebuilds node-pty against the locked Electron version. Packages are written to `dist/`. The lockfile fixes dependency versions; package signing/notarization requires your own Apple credentials.

## Data and network / 数据与网络

Wezy stores window/project state and gateway profiles in its Electron user-data directory. It reads local Claude logs for usage and session import, the Claude session registry and process ancestry for conversation identity, and local Codex metadata for synchronization. It also reads pinned metadata from existing discovered Codex SSH connections, caching each remote for one minute; these reads use your existing SSH configuration. A rotating lifecycle log records process metadata, without terminal contents or prompts. Source and installer archives contain no user histories, SSH configuration or credentials.

The diagnostics view probes the configured API (or api.anthropic.com), claude.ai and ipinfo.io; the latter receives your public IP. Diagnostics may repeat every five minutes while the app is open. Your CLIs send prompts to the providers you configured. Wezy is a terminal wrapper, not an additional sandbox.

Gateway tokens use Electron safeStorage when encryption is available; the current compatibility fallback stores reversible base64 in a user-only file. Claude gateway launch also uses a mode-0600 settings file. Prefer your CLI's normal login when avoiding these gateway files is important. Never include your app data, auth files or logs in a public issue.

For isolated UI previews, use a fresh directory:

```sh
LANE_USERDATA=/tmp/wezy-preview LANE_SNAPSHOT=/tmp/wezy-preview.png npm start
```

## License

MIT for Wezy's own source. See [third-party notices](THIRD_PARTY_NOTICES.md) for dependencies.
