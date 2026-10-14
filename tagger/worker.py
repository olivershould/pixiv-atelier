"""Offline pixel-based WD tagger. JSON Lines on stdin/stdout; no networking."""
from __future__ import annotations

import csv
import hashlib
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import warnings

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = Path(__file__).with_name("model-manifest.json")
MAX_LINE = 2 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 64_000_000
DESCRIPTOR_VERSION = "wd-swinv2-v3-pooled-v1"
DESCRIPTOR_NODE = "/core_model/head/global_pool/pool/ReduceMean_output_0"
DESCRIPTOR_DIMENSIONS = 1024
DESCRIPTOR_MODEL_SHA256 = "e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1"


def _read_varint(raw, offset):
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(raw):
            raise ValueError("Truncated protobuf varint")
        byte = raw[offset]
        offset += 1
        if shift == 63 and byte > 1:
            raise ValueError("Oversized protobuf varint")
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError("Invalid protobuf varint")


def _protobuf_fields(raw):
    """Walk field spans without decoding or copying the model's tensor weights."""
    offset = 0
    while offset < len(raw):
        start = offset
        key, offset = _read_varint(raw, offset)
        field, wire = key >> 3, key & 7
        if not field:
            raise ValueError("Invalid protobuf field")
        if wire == 0:
            value_start = offset
            _, offset = _read_varint(raw, offset)
        elif wire in (1, 5):
            value_start = offset
            offset += 8 if wire == 1 else 4
        elif wire == 2:
            length, offset = _read_varint(raw, offset)
            value_start = offset
            offset += length
        else:
            raise ValueError("Unsupported protobuf wire type")
        if offset > len(raw):
            raise ValueError("Truncated protobuf field")
        yield field, wire, start, value_start, offset


def _varint(value):
    encoded = bytearray()
    while value >= 128:
        encoded.append((value & 127) | 128)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


def _message(field, value):
    return _varint((field << 3) | 2) + _varint(len(value)) + value


def _integer(field, value):
    return _varint(field << 3) + _varint(value)


def with_descriptor_output(raw):
    """Expose the audited pool output in memory; keep every original field intact.

    This narrow protobuf edit avoids an additional ONNX dependency. The caller
    permits it only for the pinned, SHA-verified model above. It is never saved.
    """
    graphs = [span for span in _protobuf_fields(raw) if span[0] == 7]
    if len(graphs) != 1 or graphs[0][1] != 2:
        raise ValueError("Expected one ONNX graph")
    _, _, graph_start, value_start, graph_end = graphs[0]
    graph = memoryview(raw)[value_start:graph_end]
    found_pool = False
    for field, wire, _, start, end in _protobuf_fields(graph):
        if field not in (1, 12) or wire != 2:
            continue
        strings = {}
        for child_field, child_wire, _, child_start, child_end in _protobuf_fields(graph[start:end]):
            if child_wire == 2 and child_field in (1, 2, 4):
                # Node input/output/op_type and ValueInfo name are short strings.
                if field == 12 and child_field != 1:
                    continue
                strings.setdefault(child_field, []).append(bytes(graph[start + child_start:start + child_end]).decode("utf-8"))
        if field == 1 and DESCRIPTOR_NODE in strings.get(2, []):
            if found_pool or strings.get(4) != ["ReduceMean"]:
                raise ValueError("Unexpected descriptor node")
            found_pool = True
        elif field == 12 and DESCRIPTOR_NODE in strings.get(1, []):
            raise ValueError("Descriptor output already exists")
    if not found_pool:
        raise ValueError("Descriptor pool is unavailable")
    # ValueInfoProto -> TypeProto.tensor_type -> float32 TensorShapeProto [1, 1024].
    shape = _message(1, _integer(1, 1)) + _message(1, _integer(1, DESCRIPTOR_DIMENSIONS))
    tensor_type = _integer(1, 1) + _message(2, shape)
    output = _message(1, DESCRIPTOR_NODE.encode()) + _message(2, _message(1, tensor_type))
    extra = _message(12, output)
    return b"".join((raw[:graph_start], _varint((7 << 3) | 2), _varint(len(graph) + len(extra)), graph, extra, raw[graph_end:]))


class TaggerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def configured_path(name: str, fallback: Path) -> Path:
    value = os.environ.get(name)
    path = Path(value) if value else fallback
    if not path.is_absolute():
        raise TaggerError("CONFIG_INVALID", f"{name} must be an absolute path")
    return path.resolve()


class Predictor:
    def __init__(self):
        self.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        self.runtime = configured_path("TAGGER_RUNTIME", ROOT / ".runtime" / "tagger")
        self.model_dir = configured_path("TAGGER_MODEL_DIR", ROOT / ".data" / "models" / "wd-swinv2-v3")
        self.upload_dir = configured_path("TAGGER_UPLOAD_DIR", ROOT / ".data" / "uploads")
        self.session = None
        self.labels = []
        self.descriptor_name = None
        self.model_sha256 = None

    def provenance(self):
        return {
            "model": self.manifest["model"],
            "modelVersion": self.manifest["modelVersion"],
            "modelFiles": [
                {"name": item["name"], "sha256": item["sha256"], "size": item["size"], "sourceUrl": item["url"]}
                for item in self.manifest["files"]
            ],
            "manifestSha256": sha_file(MANIFEST_PATH),
            "sources": self.manifest["sources"],
        }

    def initialize(self):
        if self.session is not None:
            return
        if not self.runtime.is_dir():
            raise TaggerError("DEPENDENCIES_MISSING", "Run tagger/setup.py --install-deps first")
        installed = {
            re.sub(r"[-_.]+", "-", dist.metadata.get("Name", "")).lower(): dist.version
            for dist in importlib.metadata.distributions(path=[str(self.runtime)])
        }
        for package, version in self.manifest["dependencies"].items():
            normalized = re.sub(r"[-_.]+", "-", package).lower()
            if installed.get(normalized) != version:
                raise TaggerError("DEPENDENCIES_MISSING", f"Project runtime requires {package}=={version}; run setup.py --install-deps")
        sys.path.insert(0, str(self.runtime))
        try:
            import numpy as np
            import onnxruntime as ort
            from PIL import Image
        except Exception as exc:
            raise TaggerError("DEPENDENCY_IMPORT_FAILED", f"Cannot load local runtime: {exc}") from exc
        for module in (np, ort, Image):
            if not Path(module.__file__).resolve().is_relative_to(self.runtime):
                raise TaggerError("DEPENDENCY_IMPORT_FAILED", "Dependency was not imported from TAGGER_RUNTIME")
        for item in self.manifest["files"]:
            if item["name"] not in ("model.onnx", "selected_tags.csv"):
                raise TaggerError("MANIFEST_INVALID", "Unexpected model file in manifest")
            model_path = self.model_dir / item["name"]
            if not model_path.is_file():
                raise TaggerError("MODEL_MISSING", "Run tagger/setup.py --download-model first")
            if not model_path.resolve().is_relative_to(self.model_dir):
                raise TaggerError("MODEL_INVALID", "Model file resolves outside approved model directory")
            if model_path.stat().st_size != item["size"] or sha_file(model_path) != item["sha256"]:
                raise TaggerError("MODEL_INVALID", f"Model checksum mismatch: {item['name']}; run setup.py --download-model")
        with (self.model_dir / "selected_tags.csv").open(encoding="utf-8", newline="") as handle:
            self.labels = [(row["name"], int(row["category"])) for row in csv.DictReader(handle)]
        if not self.labels or any(category not in (0, 4, 9) for _, category in self.labels):
            raise TaggerError("MODEL_INVALID", "Unexpected label table")
        options = ort.SessionOptions()
        options.log_severity_level = 3
        options.intra_op_num_threads = min(4, os.cpu_count() or 1)
        model_path = self.model_dir / "model.onnx"
        self.model_sha256 = next(item["sha256"] for item in self.manifest["files"] if item["name"] == "model.onnx")
        session = None
        if self.model_sha256 == DESCRIPTOR_MODEL_SHA256:
            try:
                model_bytes = model_path.read_bytes()
                if hashlib.sha256(model_bytes).hexdigest() != self.model_sha256:
                    raise ValueError("Model changed before descriptor extraction")
                augmented = with_descriptor_output(model_bytes)
                del model_bytes
                session = ort.InferenceSession(augmented, sess_options=options, providers=["CPUExecutionProvider"])
                self.descriptor_name = DESCRIPTOR_NODE
            except Exception:
                # Optional visual memory must not make ordinary tag recognition fail.
                session = None
                self.descriptor_name = None
            finally:
                model_bytes = augmented = None
        try:
            if session is None:
                session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
        except Exception as exc:
            raise TaggerError("MODEL_LOAD_FAILED", f"Cannot initialize CPU model: {exc}") from exc
        inputs = session.get_inputs()
        outputs = session.get_outputs()
        if len(inputs) != 1 or not outputs or len(inputs[0].shape) != 4:
            raise TaggerError("MODEL_INVALID", "Unexpected model input/output signature")
        _, height, width, channels = inputs[0].shape
        if not isinstance(height, int) or height != width or channels != 3 or inputs[0].type != "tensor(float)":
            raise TaggerError("MODEL_INVALID", "Expected square float32 NHWC input")
        self.np, self.Image = np, Image
        self.target_size = height
        self.input_name, self.output_name = inputs[0].name, outputs[0].name
        self.session = session

    def descriptor(self, feature):
        """Return only a finite, unit-length vector suitable for local matching."""
        np = self.np
        if feature.shape != (1, DESCRIPTOR_DIMENSIONS) or not np.isfinite(feature).all():
            return None
        values = feature[0].astype(np.float64)
        norm = float(np.linalg.norm(values))
        if not math.isfinite(norm) or norm <= 1e-12:
            return None
        values = values / norm
        return {"version": DESCRIPTOR_VERSION, "modelSha256": self.model_sha256, "values": values.tolist()}

    def prepare(self, file):
        if not isinstance(file, dict) or not isinstance(file.get("id"), str) or not file["id"]:
            raise TaggerError("INPUT_INVALID", "Each image needs a nonempty string id")
        if not isinstance(file.get("path"), str) or not isinstance(file.get("sha256"), str):
            raise TaggerError("INPUT_INVALID", "Each image needs an absolute path and SHA-256")
        expected = file["sha256"].lower()
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise TaggerError("INPUT_INVALID", "Invalid image SHA-256")
        path = Path(file["path"])
        if not path.is_absolute():
            raise TaggerError("INPUT_INVALID", "Image paths must be absolute")
        path = path.resolve(strict=True)
        if not path.is_relative_to(self.upload_dir) or not path.is_file():
            raise TaggerError("INPUT_INVALID", "Image must be inside approved upload directory")
        with path.open("rb") as handle:
            raw = handle.read(MAX_IMAGE_BYTES + 1)
        if not raw or len(raw) > MAX_IMAGE_BYTES:
            raise TaggerError("IMAGE_INVALID", "Image is empty or exceeds the 32 MiB worker limit")
        actual = hashlib.sha256(raw).hexdigest()
        if actual != expected:
            raise TaggerError("IMAGE_CHANGED", "Uploaded image checksum changed")
        Image = self.Image
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in ("PNG", "JPEG", "GIF") or getattr(source, "n_frames", 1) != 1:
                    raise TaggerError("IMAGE_INVALID", "Only JPEG, PNG and static GIF are supported")
                width, height = source.size
                if width <= 0 or height <= 0 or max(width, height) ** 2 > MAX_PIXELS:
                    raise TaggerError("IMAGE_TOO_LARGE", "Image requires more than 64 million square-padding pixels; resize it before recognition")
                rgba = source.convert("RGBA")
        canvas = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        canvas.alpha_composite(rgba)
        rgb = canvas.convert("RGB")
        max_dim = max(rgb.size)
        square = Image.new("RGB", (max_dim, max_dim), (255, 255, 255))
        square.paste(rgb, ((max_dim - rgb.width) // 2, (max_dim - rgb.height) // 2))
        if max_dim != self.target_size:
            square = square.resize((self.target_size, self.target_size), Image.Resampling.BICUBIC)
        pixels = self.np.asarray(square, dtype=self.np.float32)[:, :, ::-1]
        tensor = self.np.ascontiguousarray(self.np.expand_dims(pixels, axis=0))
        return tensor, {"id": file["id"], "sha256": actual, "width": width, "height": height}

    def analyze(self, files):
        if not isinstance(files, list) or not files or len(files) > 200:
            raise TaggerError("INPUT_INVALID", "Supply between 1 and 200 images")
        ids = [file.get("id") for file in files if isinstance(file, dict)]
        if any(not isinstance(value, str) for value in ids) or len(ids) != len(files) or len(set(ids)) != len(ids):
            raise TaggerError("INPUT_INVALID", "Image ids must be unique strings")
        self.initialize()
        analyzed, predictions, ratings = [], [], []
        for file in files:
            tensor, metadata = self.prepare(file)
            feature = None
            if self.descriptor_name:
                try:
                    scores, feature = self.session.run([self.output_name, self.descriptor_name], {self.input_name: tensor})
                except Exception:
                    self.descriptor_name = None
                    scores = self.session.run([self.output_name], {self.input_name: tensor})[0]
            else:
                scores = self.session.run([self.output_name], {self.input_name: tensor})[0]
            if scores.shape != (1, len(self.labels)):
                raise TaggerError("MODEL_INVALID", "Prediction count does not match selected_tags.csv")
            if feature is not None:
                try:
                    descriptor = self.descriptor(feature)
                    if descriptor:
                        metadata["descriptor"] = descriptor
                except Exception:
                    pass
            for (name, category), value in zip(self.labels, scores[0]):
                score = float(value)
                if not math.isfinite(score) or not 0 <= score <= 1:
                    raise TaggerError("MODEL_INVALID", "Model produced an invalid score")
                candidate = {"fileId": file["id"], "name": name, "category": category, "score": score}
                if category == 9:
                    ratings.append(candidate)
                elif score > self.manifest["thresholds"]["character" if category == 4 else "general"]:
                    predictions.append(candidate)
            analyzed.append(metadata)
        predictions.sort(key=lambda value: value["score"], reverse=True)
        return {"analyzedFiles": analyzed, "predictions": predictions, "ratings": ratings}


def process(predictor, request):
    started = time.perf_counter()
    request_id = request.get("id") if isinstance(request, dict) else None
    if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
        request_id = None
    try:
        if not isinstance(request, dict):
            raise TaggerError("INPUT_INVALID", "Request must be an object")
        op = request.get("op", "analyze")
        if op == "health":
            predictor.initialize()
            result = {"ready": True, "provider": "CPUExecutionProvider", "labelCount": len(predictor.labels)}
        elif op == "analyze":
            result = predictor.analyze(request.get("files"))
        else:
            raise TaggerError("INPUT_INVALID", "Unknown operation")
        return {"id": request_id, "ok": True, **predictor.provenance(), **result, "durationMs": round((time.perf_counter() - started) * 1000)}
    except Exception as exc:
        return {"id": request_id, "ok": False, "ready": False, "error": {"code": getattr(exc, "code", "TAGGER_FAILED"), "message": str(exc)}, "durationMs": round((time.perf_counter() - started) * 1000)}


def main():
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    try:
        predictor = Predictor()
    except Exception as exc:
        print(json.dumps({"id": None, "ok": False, "ready": False, "error": {"code": "CONFIG_INVALID", "message": str(exc)}}), flush=True)
        return 1
    if "--health" in sys.argv:
        result = process(predictor, {"op": "health", "id": "setup"})
        print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
        return 0 if result["ok"] else 1
    while True:
        raw = sys.stdin.buffer.readline(MAX_LINE + 1)
        if not raw:
            return 0
        try:
            if len(raw) > MAX_LINE:
                while raw and not raw.endswith(b"\n"):
                    raw = sys.stdin.buffer.readline(MAX_LINE + 1)
                raise TaggerError("INPUT_INVALID", "JSON request exceeds 2 MiB")
            result = process(predictor, json.loads(raw.decode("utf-8")))
        except Exception as exc:
            result = {"id": None, "ok": False, "error": {"code": "INPUT_INVALID", "message": str(exc)}}
        print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
