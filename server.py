import json
import shutil
import subprocess
import time
from pathlib import Path

from aiohttp import web
from server import PromptServer
import folder_paths

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
WEB_DIR = ROOT / "web"
PROFILE_FILE = ROOT / "profiles" / "h3_fl2va.json"
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


def _media_root(folder_type):
    if folder_type == "input":
        return Path(folder_paths.get_input_directory())
    if folder_type == "temp":
        return Path(folder_paths.get_temp_directory())
    return Path(folder_paths.get_output_directory())


def _resolve_media_record(record):
    filename = Path(str(record.get("filename") or "")).name
    if not filename:
        raise ValueError("media record is missing filename")
    subfolder = str(record.get("subfolder") or "")
    folder_type = str(record.get("type") or "output")
    root = _media_root(folder_type).resolve()
    candidate = (root / subfolder / filename).resolve()
    if root != candidate and root not in candidate.parents:
        raise ValueError("media path escapes the ComfyUI media directory")
    if not candidate.exists():
        raise FileNotFoundError(str(candidate))
    return candidate


def _parse_fraction(value):
    try:
        if not value:
            return None
        if "/" in str(value):
            a, b = str(value).split("/", 1)
            b = float(b)
            return float(a) / b if b else None
        return float(value)
    except Exception:
        return None


def _probe_media(path):
    if not shutil.which("ffprobe"):
        return {"available": False, "error": "ffprobe is not installed"}
    cmd = [
        "ffprobe", "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate,r_frame_rate,nb_frames,duration,width,height",
        "-show_entries", "format=duration,size",
        "-of", "json",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        return {"available": False, "error": proc.stderr.strip() or "ffprobe failed"}
    data = json.loads(proc.stdout or "{}")
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format") or {}
    duration = stream.get("duration") or fmt.get("duration")
    fps = _parse_fraction(stream.get("avg_frame_rate")) or _parse_fraction(stream.get("r_frame_rate"))
    frames = stream.get("nb_frames")
    try:
        frames = int(frames) if frames not in (None, "N/A") else None
    except Exception:
        frames = None
    try:
        duration = float(duration) if duration not in (None, "N/A") else None
    except Exception:
        duration = None
    if frames is None and duration and fps:
        frames = int(round(duration * fps))
    return {
        "available": True,
        "duration": duration,
        "fps": fps,
        "frames": frames,
        "width": stream.get("width"),
        "height": stream.get("height"),
        "size": int(fmt.get("size")) if str(fmt.get("size", "")).isdigit() else path.stat().st_size,
    }


def register_routes():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    routes = PromptServer.instance.routes

    @routes.get("/live-h3-chat/")
    async def live_h3_chat_index(_request):
        return web.FileResponse(WEB_DIR / "index.html")

    @routes.get("/live-h3-chat/app.js")
    async def live_h3_chat_js(_request):
        return web.FileResponse(WEB_DIR / "app.js")

    @routes.get("/live-h3-chat/director-patch.js")
    async def live_h3_chat_director_js(_request):
        chunks = []
        for name in ("director-patch.js", "runtime-fixes.js", "runtime-v3.js", "runtime-v5.js", "runtime-v6.js", "runtime-v7.js"):
            path = WEB_DIR / name
            if path.exists():
                chunks.append(path.read_text(encoding="utf-8"))
        return web.Response(text="\n\n".join(chunks) + "\n", content_type="application/javascript")

    @routes.get("/live-h3-chat/styles.css")
    async def live_h3_chat_css(_request):
        chunks = []
        for name in ("styles.css", "v3.css"):
            path = WEB_DIR / name
            if path.exists():
                chunks.append(path.read_text(encoding="utf-8"))
        return web.Response(text="\n\n".join(chunks) + "\n", content_type="text/css")

    @routes.get("/live-h3-chat/api/workflow-profile")
    async def live_h3_chat_workflow_profile(_request):
        return _json_response(_load_json(PROFILE_FILE, {}))

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

    @routes.get("/live-h3-chat/api/loras")
    async def live_h3_chat_loras(_request):
        try:
            names = []
            for value in folder_paths.get_filename_list("loras"):
                name = str(value).replace("\\", "/")
                if name.lower().startswith("mmh3/"):
                    names.append(name)
            names.sort(key=str.lower)
            return _json_response({"ok": True, "root": "models/loras/mmh3/", "loras": names})
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

    @routes.post("/live-h3-chat/api/probe-media")
    async def live_h3_chat_probe_media(request):
        try:
            payload = await request.json()
            record = payload.get("media") or {}
            path = _resolve_media_record(record)
            return _json_response({"ok": True, "probe": _probe_media(path)})
        except Exception as exc:
            return _json_response({"error": str(exc)}, 500)

    @routes.post("/live-h3-chat/api/extract-last-frame")
    async def live_h3_chat_extract_last_frame(request):
        try:
            if not shutil.which("ffmpeg"):
                return _json_response({"error": "ffmpeg is not installed; cannot extract continuity frame"}, 500)
            payload = await request.json()
            record = payload.get("media") or {}
            source = _resolve_media_record(record)
            probe = _probe_media(source)

            target_dir = Path(folder_paths.get_input_directory()) / "live_h3_chat" / "continuity"
            target_dir.mkdir(parents=True, exist_ok=True)
            target_name = f"last_{int(time.time() * 1000)}.png"
            target = target_dir / target_name

            cmd = [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-sseof", "-1.0", "-i", str(source),
                "-an", "-vf", "reverse",
                "-frames:v", "1", str(target),
            ]

            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
            if proc.returncode != 0 or not target.exists():
                return _json_response({"error": proc.stderr.strip() or "ffmpeg failed to extract last frame"}, 500)

            return _json_response({
                "ok": True,
                "filename": f"live_h3_chat/continuity/{target_name}",
                "probe": probe,
            })
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
