"""Explicit, project-local installer. Running without flags performs no download."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = Path(__file__).with_name("model-manifest.json")
RUNTIME = ROOT / ".runtime" / "tagger"
MODELS = ROOT / ".data" / "models" / "wd-swinv2-v3"


def digest(path):
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def valid_file(path, item):
    return path.is_file() and path.stat().st_size == item["size"] and digest(path) == item["sha256"]


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def install_dependencies(manifest):
    if sys.version_info < (3, 10):
        raise RuntimeError("Python 3.10 or newer is required; tested target is Python 3.12 x64")
    RUNTIME.parent.mkdir(parents=True, exist_ok=True)
    stage = RUNTIME.with_name("tagger.install-" + uuid.uuid4().hex)
    pins = [f"{name}=={version}" for name, version in manifest["dependencies"].items()]
    print(f"Installing pinned wheels into project staging directory: {stage}", flush=True)
    command = [sys.executable, "-m", "pip", "--isolated", "--disable-pip-version-check", "--no-cache-dir", "install", "--index-url", "https://pypi.org/simple", "--only-binary=:all:", "--no-deps", "--target", str(stage), *pins]
    try:
        subprocess.run(command, check=True)
        check = "import sys;sys.path.insert(0,sys.argv[1]);import numpy,onnxruntime;from PIL import Image;print('Local dependency imports passed')"
        subprocess.run([sys.executable, "-I", "-c", check, str(stage)], check=True)
        atomic_json(stage / "installed-pins.json", {"dependencies": manifest["dependencies"], "pythonVersion": sys.version, "installedAt": datetime.now(timezone.utc).isoformat()})
    except Exception:
        print(f"Installation failed. Incomplete staging directory is not activated and remains at {stage}", file=sys.stderr)
        raise
    backup = None
    if RUNTIME.exists():
        backup = RUNTIME.with_name("tagger.previous-" + uuid.uuid4().hex)
        os.replace(RUNTIME, backup)
    try:
        os.replace(stage, RUNTIME)
    except Exception:
        if backup is not None and not RUNTIME.exists():
            os.replace(backup, RUNTIME)
        raise
    print(f"Dependencies ready: {RUNTIME}", flush=True)
    if backup:
        print(f"Previous runtime retained at {backup}; no files were recursively deleted.", flush=True)


def download_file(item):
    if item["name"] not in ("model.onnx", "selected_tags.csv") or not item["url"].startswith("https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3/resolve/"):
        raise RuntimeError("Manifest contains an unapproved model source or filename")
    MODELS.mkdir(parents=True, exist_ok=True)
    destination = MODELS / item["name"]
    if valid_file(destination, item):
        print(f"Already verified: {item['name']}", flush=True)
        return
    partial = destination.with_suffix(destination.suffix + ".part")
    if partial.exists() and partial.stat().st_size > item["size"]:
        quarantined = partial.with_name(partial.name + ".invalid-" + uuid.uuid4().hex)
        os.replace(partial, quarantined)
        print(f"Oversized partial download moved to {quarantined}", flush=True)
    if valid_file(partial, item):
        os.replace(partial, destination)
        print(f"Recovered complete verified download: {item['name']}", flush=True)
        return
    offset = partial.stat().st_size if partial.exists() else 0
    if offset == item["size"]:
        quarantined = partial.with_name(partial.name + ".invalid-" + uuid.uuid4().hex)
        os.replace(partial, quarantined)
        offset = 0
    headers = {"User-Agent": "PixivPublisherLocalTagger/1.0", "Accept-Encoding": "identity"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = urllib.request.Request(item["url"], headers=headers)
    context = ssl.create_default_context()
    try:
        with urllib.request.urlopen(request, timeout=90, context=context) as response:
            if not response.geturl().startswith("https://"):
                raise RuntimeError("Refusing a non-HTTPS download redirect")
            status = response.status
            if offset and status == 206:
                expected_range = f"bytes {offset}-"
                if not response.headers.get("Content-Range", "").startswith(expected_range):
                    raise RuntimeError("Resume response does not match the requested byte offset")
                mode = "ab"
            elif status == 200:
                offset, mode = 0, "wb"
            else:
                raise RuntimeError(f"Unexpected download status: {status}")
            received, last_report = offset, time.monotonic()
            print(f"Downloading {item['name']}: {received}/{item['size']} bytes", flush=True)
            with partial.open(mode) as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    if received + len(chunk) > item["size"]:
                        raise RuntimeError("Remote file exceeds pinned size")
                    handle.write(chunk)
                    received += len(chunk)
                    if time.monotonic() - last_report >= 5:
                        print(f"{item['name']}: {received}/{item['size']} bytes ({received/item['size']:.1%})", flush=True)
                        last_report = time.monotonic()
                handle.flush()
                os.fsync(handle.fileno())
        if not valid_file(partial, item):
            raise RuntimeError("Downloaded file failed exact size or SHA-256 verification")
        os.replace(partial, destination)
        print(f"Verified and activated {item['name']}: {item['sha256']}", flush=True)
    except Exception:
        print(f"Download did not complete. Untrusted partial file remains at {partial}; rerun --download-model to resume/restart. It is not loaded as a model.", file=sys.stderr)
        raise


def verify():
    environment = dict(os.environ, TAGGER_RUNTIME=str(RUNTIME), TAGGER_MODEL_DIR=str(MODELS), PYTHONDONTWRITEBYTECODE="1")
    result = subprocess.run([sys.executable, "-u", str(Path(__file__).with_name("worker.py")), "--health"], env=environment, text=True, encoding="utf-8", capture_output=True, timeout=180)
    if result.stderr:
        print(result.stderr, file=sys.stderr, end="")
    try:
        response = json.loads(result.stdout.strip())
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Worker health did not return JSON: {result.stdout[:500]}") from exc
    if result.returncode or response.get("ok") is not True or response.get("ready") is not True:
        raise RuntimeError(response.get("error", {}).get("message", "Worker is not ready"))
    return response


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", default=str(ROOT), help="Project root (must match the project containing this script)")
    parser.add_argument("--install-deps", action="store_true", help="Install fixed wheels only into project .runtime/tagger")
    parser.add_argument("--download-model", action="store_true", help="Download the fixed 467 MB ONNX model and 308 KB labels, verifying SHA-256")
    parser.add_argument("--verify", action="store_true", help="Require successful offline worker initialization and save its local configuration")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if Path(args.project_root).resolve() != ROOT:
        parser.error("--project-root must be the project containing tagger/setup.py")
    if not (args.install_deps or args.download_model or args.verify):
        parser.print_help()
        print(f"\nPython: {sys.executable}\nDependencies: {RUNTIME}\nModels: {MODELS}\nNo downloads or installation performed.")
        return 0
    try:
        if args.install_deps:
            install_dependencies(manifest)
        if args.download_model:
            for item in manifest["files"]:
                download_file(item)
        both_present = RUNTIME.is_dir() and all((MODELS / item["name"]).is_file() for item in manifest["files"])
        if args.verify or both_present:
            health = verify()
            configuration = {
                "pythonPath": sys.executable,
                "runtimeDir": str(RUNTIME),
                "modelDir": str(MODELS),
                "modelRevision": manifest["modelVersion"],
                "configuredAt": datetime.now(timezone.utc).isoformat(),
            }
            atomic_json(ROOT / ".data" / "tagger-config.json", configuration)
            print(json.dumps({"ready": True, "configuration": configuration, "health": health}, ensure_ascii=False, indent=2))
        else:
            print("Requested stage completed. Remaining dependencies/model stage is required; worker is not yet declared ready.")
        return 0
    except Exception as exc:
        print(f"Setup failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
