#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path
from typing import Any

try:
    import webview
except ImportError:  # pragma: no cover - handled at runtime
    webview = None

if os.name == "nt":
    try:
        import ctypes
    except ImportError:  # pragma: no cover - Windows-only helper
        ctypes = None

    try:
        import winreg
    except ImportError:  # pragma: no cover - Windows-only helper
        winreg = None
else:  # pragma: no cover - Windows-only helper
    ctypes = None
    winreg = None

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    BASE_DIR = Path(sys._MEIPASS)
else:
    BASE_DIR = Path(__file__).resolve().parent

APP_TITLE = "XML Editor Desktop"
EXE_BASE_NAME = "XML_Editor_Desktop"
ENTRYPOINT = BASE_DIR / "index.html"
GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/oywino/xml-editor-desktop/releases/latest"
UPDATE_CHECK_TIMEOUT_SECONDS = 4
UPDATE_USER_AGENT = "XML-Editor-Desktop-Updater"
DEBUG_ENV_VAR = "XML_EDITOR_DEBUG"
WEBVIEW2_CLIENT_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"


def read_current_version() -> str:
    app_js_path = BASE_DIR / "app.js"
    if not app_js_path.exists():
        return "v0.0.0"

    try:
        content = app_js_path.read_text(encoding="utf-8")
    except OSError:
        return "v0.0.0"

    marker = "const APP_VERSION = '"
    start = content.find(marker)
    if start == -1:
        return "v0.0.0"

    start += len(marker)
    end = content.find("'", start)
    if end == -1:
        return "v0.0.0"
    return content[start:end]


def parse_version(version: str) -> tuple[int, ...]:
    cleaned = version.strip().lstrip("vV")
    number_part = cleaned.split("-", 1)[0]
    parts = []
    for token in number_part.split("."):
        try:
            parts.append(int(token))
        except ValueError:
            parts.append(0)
    return tuple(parts)


def is_newer_version(latest: str, current: str) -> bool:
    latest_parts = parse_version(latest)
    current_parts = parse_version(current)
    max_len = max(len(latest_parts), len(current_parts))
    latest_parts += (0,) * (max_len - len(latest_parts))
    current_parts += (0,) * (max_len - len(current_parts))
    return latest_parts > current_parts


def fetch_latest_release() -> dict[str, Any] | None:
    request = urllib.request.Request(
        GITHUB_LATEST_RELEASE_URL,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": UPDATE_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=UPDATE_CHECK_TIMEOUT_SECONDS) as response:
            return json.load(response)
    except Exception:
        return None


def ask_yes_no(title: str, message: str) -> bool:
    if os.name != "nt" or ctypes is None:
        return False

    mb_yesno = 0x00000004
    mb_iconquestion = 0x00000020
    id_yes = 6
    result = ctypes.windll.user32.MessageBoxW(None, message, title, mb_yesno | mb_iconquestion)
    return result == id_yes


def show_error_dialog(title: str, message: str) -> None:
    if os.name == "nt" and ctypes is not None:
        mb_ok = 0x00000000
        mb_iconerror = 0x00000010
        ctypes.windll.user32.MessageBoxW(None, message, title, mb_ok | mb_iconerror)
    else:
        print(f"{title}: {message}", file=sys.stderr)


def show_info_dialog(title: str, message: str) -> None:
    if os.name == "nt" and ctypes is not None:
        mb_ok = 0x00000000
        mb_iconinfo = 0x00000040
        ctypes.windll.user32.MessageBoxW(None, message, title, mb_ok | mb_iconinfo)
    else:
        print(f"{title}: {message}", file=sys.stderr)


def get_latest_release_asset(release: dict[str, Any]) -> tuple[str, str] | None:
    tag = str(release.get("tag_name") or "").strip()
    assets = release.get("assets") or []
    expected_name = f"{EXE_BASE_NAME}_{tag}.exe"

    for asset in assets:
        if asset.get("name") == expected_name:
            download_url = asset.get("browser_download_url")
            if download_url:
                return tag, str(download_url)
    return None


def download_update(download_url: str, version_tag: str) -> Path:
    temp_dir = Path(tempfile.mkdtemp(prefix="xml_editor_desktop_update_"))
    temp_path = temp_dir / f"{EXE_BASE_NAME}_{version_tag}.exe"
    request = urllib.request.Request(download_url, headers={"User-Agent": UPDATE_USER_AGENT})

    with urllib.request.urlopen(request, timeout=30) as response:
        with temp_path.open("wb") as fh:
            fh.write(response.read())

    return temp_path


def create_update_script(current_exe: Path, downloaded_exe: Path) -> Path:
    script_path = downloaded_exe.parent / "apply_update.cmd"
    lines = [
        "@echo off",
        "setlocal",
        f'set "TARGET={current_exe}"',
        f'set "SOURCE={downloaded_exe}"',
        f'set "PID={os.getpid()}"',
        ":waitloop",
        'tasklist /FI "PID eq %PID%" | find "%PID%" >nul',
        "if not errorlevel 1 (",
        "  timeout /t 1 /nobreak >nul",
        "  goto waitloop",
        ")",
        'move /Y "%SOURCE%" "%TARGET%" >nul',
        "if errorlevel 1 goto end",
        'start "" "%TARGET%"',
        ":end",
        'del "%~f0"',
    ]
    script_path.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
    return script_path


def maybe_apply_update() -> bool:
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return False

    current_exe = Path(sys.executable).resolve()
    if current_exe.suffix.lower() != ".exe":
        return False

    current_version = read_current_version()
    latest_release = fetch_latest_release()
    if not latest_release:
        return False

    asset_info = get_latest_release_asset(latest_release)
    if not asset_info:
        return False

    latest_version, download_url = asset_info
    if not is_newer_version(latest_version, current_version):
        return False

    prompt = (
        f"A newer version of {APP_TITLE} is available.\n\n"
        f"Current version: {current_version}\n"
        f"Latest version: {latest_version}\n\n"
        "Do you want to download and install the update now?"
    )
    if not ask_yes_no(f"{APP_TITLE} Update", prompt):
        return False

    try:
        downloaded_exe = download_update(download_url, latest_version)
        update_script = create_update_script(current_exe, downloaded_exe)
        subprocess.Popen(
            ["cmd.exe", "/c", str(update_script)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return True
    except Exception:
        show_error_dialog(
            f"{APP_TITLE} Update",
            "The update could not be downloaded or installed. The current version will continue to start normally.",
        )
        return False


def is_valid_runtime_version(version: str | None) -> bool:
    if not version:
        return False

    cleaned = version.strip()
    if not cleaned or cleaned == "0.0.0.0":
        return False

    return any(part.isdigit() and int(part) > 0 for part in cleaned.split("."))


def get_webview2_runtime_version() -> str | None:
    if os.name != "nt" or winreg is None:
        return None

    registry_locations = [
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_GUID}"),
        (winreg.HKEY_CURRENT_USER, rf"Software\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_GUID}"),
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_GUID}"),
    ]

    for root, subkey in registry_locations:
        try:
            with winreg.OpenKey(root, subkey) as key:
                version = str(winreg.QueryValueEx(key, "pv")[0])
        except OSError:
            continue

        if is_valid_runtime_version(version):
            return version

    return None


def is_webview2_runtime_available() -> bool:
    if os.name != "nt":
        return True
    return get_webview2_runtime_version() is not None


def ensure_webview2_runtime() -> bool:
    if is_webview2_runtime_available():
        return True

    show_error_dialog(
        APP_TITLE,
        f"{APP_TITLE} requires Microsoft Edge WebView2 Runtime to display the app window.\n\n"
        "Please install WebView2 Runtime from Microsoft, then start XML Editor Desktop again.\n\n"
        "XML Editor Desktop will now close.",
    )
    return False


def read_text_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")


def write_clipboard_text(text: str) -> bool:
    try:
        import tkinter

        root = tkinter.Tk()
        root.withdraw()
        root.clipboard_clear()
        root.clipboard_append(text)
        root.update()
        root.destroy()
        return True
    except Exception:
        return False


def file_dialog_type(name: str) -> Any:
    dialog = getattr(webview, "FileDialog", None)
    if dialog is not None and hasattr(dialog, name):
        return getattr(dialog, name)
    return getattr(webview, f"{name}_DIALOG")


class DesktopApi:
    def __init__(self) -> None:
        self._window = None
        self._dirty = False
        self._lock = threading.Lock()

    def set_window(self, window: Any) -> None:
        self._window = window

    def get_app_info(self) -> dict[str, Any]:
        return {
            "name": APP_TITLE,
            "version": read_current_version(),
            "native": True,
        }

    def set_dirty(self, dirty: bool) -> dict[str, bool]:
        with self._lock:
            self._dirty = bool(dirty)
        return {"ok": True}

    def has_unsaved_changes(self) -> bool:
        with self._lock:
            return self._dirty

    def confirm_discard_changes(self) -> bool:
        if not self.has_unsaved_changes():
            return True
        if self._window is None:
            return False
        return bool(
            self._window.create_confirmation_dialog(
                "Discard unsaved changes?",
                "The current document has unsaved changes. Continue and discard them?",
            )
        )

    def open_file(self) -> dict[str, Any]:
        if self._window is None:
            return {"ok": False, "cancelled": True}

        selection = self._window.create_file_dialog(
            file_dialog_type("OPEN"),
            allow_multiple=False,
            file_types=(
                "XML editor documents (*.md;*.txt;*.xml)",
                "All files (*.*)",
            ),
        )
        if not selection:
            return {"ok": False, "cancelled": True}

        selected_path = selection[0] if isinstance(selection, (list, tuple)) else selection
        path = Path(selected_path)
        try:
            content = read_text_file(path)
        except OSError as exc:
            return {"ok": False, "cancelled": False, "error": str(exc)}

        return {
            "ok": True,
            "name": path.name,
            "path": str(path),
            "content": content,
        }

    def save_file(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._window is None:
            return {"ok": False, "cancelled": True}

        content = str(payload.get("content") or "")
        suggested_name = str(payload.get("suggestedName") or "xml_editor_document.md")
        selection = self._window.create_file_dialog(
            file_dialog_type("SAVE"),
            save_filename=suggested_name,
            file_types=(
                "Markdown files (*.md)",
                "Text files (*.txt)",
                "XML files (*.xml)",
                "All files (*.*)",
            ),
        )
        if not selection:
            return {"ok": False, "cancelled": True}

        selected_path = selection[0] if isinstance(selection, (list, tuple)) else selection
        path = Path(selected_path)
        try:
            path.write_text(content, encoding="utf-8")
        except OSError as exc:
            return {"ok": False, "cancelled": False, "error": str(exc)}

        self.set_dirty(False)
        return {
            "ok": True,
            "path": str(path),
            "name": path.name,
        }

    def write_clipboard(self, content: str) -> dict[str, Any]:
        if write_clipboard_text(str(content or "")):
            self.set_dirty(False)
            return {"ok": True}
        return {"ok": False, "error": "Clipboard is unavailable."}


def handle_window_closing(api: DesktopApi) -> bool:
    if not api.has_unsaved_changes():
        return True
    if api._window is None:
        return False
    return bool(
        api._window.create_confirmation_dialog(
            "Close XML Editor Desktop?",
            "The current document has unsaved changes. Close anyway?",
        )
    )


def is_debug_enabled() -> bool:
    value = os.environ.get(DEBUG_ENV_VAR, "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def main() -> None:
    if maybe_apply_update():
        return

    if not ensure_webview2_runtime():
        return

    if webview is None:
        show_error_dialog(
            APP_TITLE,
            "pywebview is not installed. Install Python 3.10-3.13, then run: py -3.13 -m pip install -r requirements.txt",
        )
        return

    if not ENTRYPOINT.exists():
        show_error_dialog(APP_TITLE, f"Missing application entrypoint: {ENTRYPOINT}")
        return

    api = DesktopApi()
    window = webview.create_window(
        APP_TITLE,
        str(ENTRYPOINT),
        js_api=api,
        width=1180,
        height=820,
        min_size=(900, 620),
        text_select=True,
    )
    api.set_window(window)
    window.events.closing += lambda: handle_window_closing(api)
    webview.start(debug=is_debug_enabled())


if __name__ == "__main__":
    main()
