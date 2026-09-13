import json
import shutil
from pathlib import Path

from aiohttp import web
from server import PromptServer
import folder_paths

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
WEB_DIR = ROOT / "web"
SETTINGS_FILE = DATA_DIR / "settings.json"
WORKFLOW_FILE = DATA_DIR / "workflow.json"


def _json_response(payload, status=200):
    return web.json_response(payload, status=status)


def _load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except Exception:
        return default


def register_routes():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    routes = PromptServer.instance.routes

    @routes.get("/live-h3-chat/")
    async def live_h3_chat_index(_request):
        return web.FileResponse(WEB_DIR / "index.html")

    @routes.get("/live-h3-chat/app.js")
    async def live_h3_chat_js(_request):
        return web.FileResponse(WEB_DIR / "app.js")

    @routes.get("/live-h3-chat/styles.css")
    async def live_h3_chat_css(_request):
        return web.FileResponse(WEB_DIR / "styles.css")

    @routes.get("/live-h3-chat/api/config")
    async def live_h3_chat_config(_request):
        return _json_response({
            "settings": _load_json(SETTINGS_FILE, {}),
            "workflow": _load_json(WORKFLOW_FILE, {}),
        })

    @routes.post("/live-h3-chat/api/config")
    async def live_h3_chat_save_config(request):
        try:
            payload = await request.json()
            settings = payload.get("settings") or {}
            workflow = payload.get("workflow") or {}
            if not isinstance(settings, dict) or not isinstance(workflow, dict):
                return _json_response({"error": "settings and workflow must be JSON objects"}, 400)
            SETTINGS_FILE.write_text(json.dumps(settings, indent=2), encoding="utf-8")
            WORKFLOW_FILE.write_text(json.dumps(workflow, indent=2), encoding="utf-8")
            return _json_response({"ok": True})
        except Exception as exc:
            return _json_response({"error": str(exc)}, 500)

    @routes.post("/live-h3-chat/api/upload-reference")
    async def live_h3_chat_upload_reference(request):
        try:
            reader = await request.multipart()
            field = await reader.next()
            if field is None or field.name != "file":
                return _json_response({"error": "missing file field"}, 400)

            original_name = Path(field.filename or "reference.png").name
            target_dir = Path(folder_paths.get_input_directory()) / "live_h3_chat"
            target_dir.mkdir(parents=True, exist_ok=True)
            target = target_dir / original_name

            suffix = target.suffix
            stem = target.stem
            counter = 1
            while target.exists():
                target = target_dir / f"{stem}_{counter}{suffix}"
                counter += 1

            with target.open("wb") as out:
                while True:
                    chunk = await field.read_chunk()
                    if not chunk:
                        break
                    out.write(chunk)

            comfy_name = f"live_h3_chat/{target.name}"
            return _json_response({"ok": True, "filename": comfy_name})
        except Exception as exc:
            return _json_response({"error": str(exc)}, 500)

    @routes.post("/live-h3-chat/api/reset")
    async def live_h3_chat_reset(_request):
        for path in (SETTINGS_FILE, WORKFLOW_FILE):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
        return _json_response({"ok": True})
