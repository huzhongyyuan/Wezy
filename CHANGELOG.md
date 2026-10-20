# Changelog

## 0.1.1 — 2026-10-20

First public release of Wezy for macOS Apple Silicon.

- Claude and Codex tabs live above their respective terminal panes.
- Dragging near a list or tab-bar edge scrolls continuously. Arrow-based ordering keeps the selected row visible.
- Terminal output, exit codes and explicit reopen controls remain visible after a process exits.
- Closing a macOS window with live terminals hides it; explicit application quit still ends those terminals.
- Local Claude conversations are matched by process ancestry, allowing explicit reopening with the original session UUID.
- Codex names, archives and pins follow official metadata, including current section ordering and legacy pins. Existing discovered remote connections can supply pinned metadata over SSH.
- Terminal scroll position is preserved while reading earlier output, with a return-to-latest control.

The public build uses the installed CLIs' provider, model and permission settings. It contains no accounts, credentials, histories or bundled model access. macOS packages are ad-hoc signed and are not notarized. Windows and Linux builds are not included in this release.
