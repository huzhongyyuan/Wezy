# Verification

Run from the repository root after `npm ci`:

```sh
codex app-server generate-json-schema --out /tmp/wezy-codex-schema
CODEX_SCHEMA=/tmp/wezy-codex-schema node tests/test.cjs . tests/results.json
node tests/lifecycle-test.cjs .
node tests/resume-binding-test.cjs
node tests/section-test.cjs .
node tests/pin-order-test.cjs .
node tests/remote-test.cjs .
npx electron tests/pin-gui-test.cjs
npx electron tests/pane-test.cjs
npx electron tests/drag-test.cjs
npx electron tests/scroll-test.cjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/release-test.cjs
```

The tests use temporary SQLite databases, fixture IPC, hidden windows and short-lived fixture shells that print a marker or exit with a known code. They do not start model turns or resume real sessions. The last command is specific to macOS. GUI previews and result files are ignored by Git.
