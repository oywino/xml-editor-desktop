# Architecture

## Overview

The desktop app has two layers:

1. `XML_Editor.py` creates a native pywebview window and exposes a Python API bridge.
2. `app.js` implements the XML editor as a plain JavaScript single-page app.

There is no remote backend, database, or framework runtime. All editing happens in memory in the WebView renderer. Native operations are requested explicitly through the host bridge.

## Runtime Flow

1. `XML_Editor.py` checks for packaged updates when running as a frozen Windows executable.
2. It creates a pywebview window pointed at `index.html`.
3. pywebview exposes `window.pywebview.api` to JavaScript.
4. `app.js` creates `window.nativeHost`, a small adapter around that API.
5. The editor initializes with a sample document.
6. Open, save, clipboard, version, and dirty-state calls go through the native host when available.

The previous browser heartbeat/server lifecycle is intentionally bypassed in native mode.

## Native Host Responsibilities

`XML_Editor.py` owns:

- desktop window creation
- native open/save dialogs
- file reading and writing
- clipboard writes
- dirty-state tracking for close confirmation
- GitHub release update checks
- PyInstaller compatibility paths for bundled assets

The exposed bridge methods are:

- `get_app_info()`
- `set_dirty(dirty)`
- `confirm_discard_changes()`
- `open_file()`
- `save_file(payload)`
- `write_clipboard(content)`

## Front-End Structure

The JavaScript is organized as a single file with a few logical layers:

- parsing helpers that split preamble text from XML and build a node tree
- serialization helpers that convert the node tree back into text
- tree update helpers for add, remove, rename, reorder, and move operations
- a `nativeHost` adapter for optional desktop APIs
- rendering functions that rebuild the UI from current state

The app uses a full re-render approach. After significant state changes, it calls `render()` and reconstructs the visible interface.

## State Model

Global state lives in a single `state` object in `app.js`.

UI state includes:

- current export modal visibility and export mode
- raw view toggle
- help panel toggle
- copied-to-clipboard status
- drag-and-drop state
- collapsed tree state
- preamble editing state

Document state includes:

- `doc.preamble`: free-form text before the XML block
- `doc.root`: array of root nodes

The native host also receives a boolean dirty state so it can warn on close.

## Node Model

The XML tree uses two node shapes.

Element nodes contain:

- `id`
- `type: "element"`
- `tag`
- `attributes`
- `children`
- optional `parent`

Text nodes contain:

- `id`
- `type: "text"`
- `text`
- `children`
- optional `parent`

## Parsing Model

The editor accepts documents with a free-form preamble followed by XML.

`parseDocument()`:

1. scans line-by-line until it finds the start of XML
2. treats everything before that as preamble
3. tokenizes the XML text
4. builds a nested tree structure from the tokens

The parser is custom and lightweight. It is built for prompt-style XML rather than strict general-purpose XML compatibility.

Current parser/serializer behavior intentionally includes a few pragmatic rules:

- common XML entities in imported text and attribute values are decoded into the in-memory document model
- exported text and attribute values are escaped again so special characters remain valid XML
- attribute names support common XML-style characters such as `.`, `-`, `_`, and `:`
- tag rename validation uses a lightweight XML-name check to avoid exporting obviously invalid tag names

## Export Model

The app supports two export modes:

- AI-ready export: clean XML without the preamble
- editor export: preamble plus XML, suitable for reopening in the editor

In native mode, saving uses the Python host and a native save dialog. In browser fallback mode, the app keeps the original download behavior.

## Maintenance Notes

- there is currently no autosave or persistent storage layer
- pywebview is the only runtime dependency
- frontend/editor changes should usually stay in `app.js` and `style.css`
- native shell, file-system, update, and packaging changes belong in `XML_Editor.py` and `build_exe.ps1`
