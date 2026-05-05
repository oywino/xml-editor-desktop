# XML Editor Desktop

`xml-editor-desktop` is the native desktop edition of the local XML editor. It started from the `python_xml_editor` `v0.8.0` release and now runs the existing HTML/CSS/JavaScript editor inside a Python-hosted native WebView window.

The app remains local-first. The JavaScript editor owns XML parsing, visual editing, raw editing, and export formatting. The Python host owns the desktop window, native file dialogs, clipboard access, app lifecycle, packaging, and update checks.

## Features

- native desktop window instead of launching the system browser
- open `.md`, `.txt`, and `.xml` files through native file dialogs
- save AI-ready XML or full editor format through native save dialogs
- copy export output through the host clipboard bridge
- edit a prompt preamble separately from the XML structure
- rename tags and edit attributes inline
- add root, child, and sibling elements
- reorder nodes with buttons or drag-and-drop
- edit text nodes directly
- preview and repair raw XML text
- check GitHub Releases for packaged EXE updates

## Project Structure

- `XML_Editor.py`: Python/pywebview native host and desktop API bridge
- `index.html`: single HTML mount point
- `app.js`: editor logic, native-host adapter, parsing, rendering, and export
- `style.css`: application styling
- `requirements.txt`: desktop runtime dependency list
- `build_exe.ps1`: Windows PyInstaller build script
- `docs/ARCHITECTURE.md`: architecture and state model notes

## Requirements

- Python 3.10-3.13
- pywebview
- PyInstaller for packaged Windows builds
- Microsoft Edge WebView2 Runtime on Windows. The app checks for it at startup and exits with a clear message if it is missing.

Install runtime dependencies with a supported Python runtime:

```bash
py -3.13 -m pip install -r requirements.txt
```

For packaging:

```bash
py -3.13 -m pip install pyinstaller
```

## Run Locally

From the repository root:

```bash
python XML_Editor.py
```

or on Windows:

```bash
py XML_Editor.py
```

The launcher opens `index.html` in a native WebView window and exposes a small Python API to JavaScript for desktop operations.

To open WebView DevTools during development:

```powershell
$env:XML_EDITOR_DEBUG = "1"
python XML_Editor.py
```

## Build Windows EXE

From the repository root:

```powershell
.\build_exe.ps1
```

The build script will:

1. read the current app version from `app.js`
2. verify PyInstaller and pywebview are installed
3. bundle `index.html`, `app.js`, and `style.css`
4. create a versioned executable in `release/`

Example output:

```text
release\XML_Editor_Desktop_vX.Y.Z.exe
```

## WebView2 Runtime

On Windows, XML Editor Desktop uses Microsoft Edge WebView2 Runtime for the native WebView.

At startup:

1. if WebView2 Runtime is present, XML Editor Desktop runs normally
2. if WebView2 Runtime is missing, XML Editor Desktop shows a clear message and terminates
3. XML Editor Desktop does not download or install WebView2 Runtime on behalf of the user

Packaged builds check releases from:

```text
https://github.com/oywino/xml-editor-desktop/releases
```

## Updates

When running as a packaged Windows EXE, XML Editor Desktop checks the latest GitHub Release at startup.

If a newer version exists and the user accepts the prompt, the app downloads the matching release EXE, exits, and runs a small replacement script. The script first tries to replace the currently running EXE in the folder it was launched from. If Windows blocks replacement because of folder permissions or file access, the downloaded update remains available instead:

1. the updater tries to save the new EXE beside the current EXE
2. if that also fails, the updater keeps the temp download
3. File Explorer opens with the available update selected
4. diagnostic details are written to `update.log` in the temp update folder

This avoids requiring administrator rights for arbitrary launch folders while still allowing automatic replacement when the folder permits it.

For public distribution, sign release artifacts before uploading them. See `docs/RELEASE_SECURITY.md`.

Release policy:

- every repository modification must be committed and tagged
- every tag must update `APP_VERSION` in `app.js`, which also updates the About section
- major/minor milestones are published as GitHub Releases with EXE assets
- patch tags are normally used for local validation before the next public minor release

## Development Workflow

1. branch from `main`
2. make and test your changes locally
3. open a pull request with a clear summary
4. include screenshots for UI changes when useful

## Architecture

The application has two parts:

1. a Python native host in `XML_Editor.py` that starts a desktop WebView window
2. a plain JavaScript single-page app in `app.js` that parses mixed preamble + XML text into a tree, renders it visually, and serializes it back out for export

The editor keeps document state in memory. Native open/save operations are explicit.

More detail is available in `docs/ARCHITECTURE.md`.
