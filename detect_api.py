"""
detect_api.py - Fish Eye additive backend (detect-only: no video re-encoding).

Hook it up in app.py with these lines (right after `model = YOLO(MODEL_PATH)`):

    import detect_api
    detect_api.init(model, tracker=TRACKER, conf=CONF, iou=IOU, imgsz=IMGSZ)
    app.register_blueprint(detect_api.bp)

Extra dependency:  pip install openpyxl

Endpoints
    POST /api/upload            multipart "video"  -> {video_id, duration, fps, ...}
    POST /api/detect            JSON params        -> {job_id}
    GET  /api/progress/<job_id>                    -> {status, progress, message, result?}
    POST /api/export            JSON annotations   -> .xlsx / .csv / .zip download
"""
import base64
import csv
import hashlib
import io
import json
import os
import re
import statistics
import threading
import uuid
import zipfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import cv2
import numpy as np
from flask import Blueprint, jsonify, request, send_file
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

bp = Blueprint("detect_api", __name__, url_prefix="/api")

UPLOAD_DIR = "uploads"
CACHE_DIR = "cache"
ALLOWED_EXT = {".mp4", ".mov", ".avi", ".mkv", ".m4v", ".webm"}
UNKNOWN_COL = "Unknown/Unable to ID due to visibility"
QC_MAX_PCT_DIFF = 6.0        # protocol: <6% difference between two blind counts

_cfg = {}
_model = None
model_lock = threading.Lock()                    # wrap the legacy /process-video route in this too
_executor = ThreadPoolExecutor(max_workers=1)    # one detection job at a time, the rest queue
_jobs = {}


def init(model, tracker="bytetrack.yaml", conf=0.25, iou=0.5, imgsz=960):
    """Reuse the YOLO model that app.py already loaded."""
    global _model
    _model = model
    _cfg.update(tracker=tracker, conf=conf, iou=iou, imgsz=imgsz)
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    os.makedirs(CACHE_DIR, exist_ok=True)


# --------------------------------------------------------------------------
# video helpers
# --------------------------------------------------------------------------
def _video_path(video_id):
    """Unique file per upload; the id is validated so it cannot escape UPLOAD_DIR."""
    if not re.fullmatch(r"[0-9a-f]{32}", video_id or ""):
        return None
    for name in os.listdir(UPLOAD_DIR):
        if name.startswith(video_id + "."):
            return os.path.join(UPLOAD_DIR, name)
    return None


def _probe(path):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    meta = {
        "fps": fps,
        "frames": frames,
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "duration": frames / fps if frames else 0.0,
    }
    cap.release()
    return meta


def _quick_hash(path):
    """Fast fingerprint (size + first/last 4 MB) used as part of the cache key."""
    size = os.path.getsize(path)
    h = hashlib.sha1(str(size).encode())
    with open(path, "rb") as f:
        h.update(f.read(4 << 20))
        f.seek(max(0, size - (4 << 20)))
        h.update(f.read(4 << 20))
    return h.hexdigest()


# --------------------------------------------------------------------------
# frame preprocessing - mirrors the browser sliders so YOLO sees what the user sees
# --------------------------------------------------------------------------
@lru_cache(maxsize=8)
def _clahe(clip):
    return cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8))


def _preprocess(frame, p):
    # same maths as the CSS filter in script.js: brightness*2^exposure, then contrast around 0.5
    gain = (1 + p["brightness"] / 100.0) * (2 ** (p["exposure"] / 100.0))
    contrast = 1 + p["contrast"] / 100.0
    out = frame
    if abs(gain - 1) > 1e-3 or abs(contrast - 1) > 1e-3:
        x = np.arange(256, dtype=np.float32) / 255.0
        lut = (np.clip((x * gain - 0.5) * contrast + 0.5, 0, 1) * 255 + 0.5).astype(np.uint8)
        out = cv2.LUT(frame, lut)
    if p["clahe"]:
        h, s, v = cv2.split(cv2.cvtColor(out, cv2.COLOR_BGR2HSV))
        out = cv2.cvtColor(cv2.merge((h, s, _clahe(p["clip"]).apply(v))), cv2.COLOR_HSV2BGR)
    return out


def _track(frame, p, reset=False):
    """Run YOLO+tracker on one frame; boxes are returned normalised (0-1)."""
    if reset:
        _model.predictor = None          # fresh tracker state (same trick as the original code)
    res = _model.track(frame, persist=True, tracker=_cfg["tracker"], conf=p["conf"],
                       iou=_cfg["iou"], imgsz=p["imgsz"], verbose=False)[0]
    boxes = res.boxes
    if boxes is None or len(boxes) == 0:
        return []
    h, w = frame.shape[:2]
    xyxy = boxes.xyxy.cpu().numpy()
    conf = boxes.conf.cpu().numpy()
    cls = boxes.cls.cpu().numpy().astype(int)
    ids = boxes.id.cpu().numpy().astype(int) if boxes.id is not None else [None] * len(xyxy)
    out = []
    for (x1, y1, x2, y2), cf, c, tid in zip(xyxy, conf, cls, ids):
        out.append({
            "track": int(tid) if tid is not None else None,
            "x1": round(float(x1) / w, 4), "y1": round(float(y1) / h, 4),
            "x2": round(float(x2) / w, 4), "y2": round(float(y2) / h, 4),
            "conf": round(float(cf), 3),
            "cls": res.names.get(int(c), "fish"),
        })
    return out


def _read_frames(cap, fps, total, times):
    """Yield (t, frame) for ascending `times`: one seek, then grab() to skip unused frames."""
    idx = [min(max(int(round(t * fps)), 0), max(total - 1, 0)) for t in times]
    if not idx:
        return
    cap.set(cv2.CAP_PROP_POS_FRAMES, idx[0])
    pos, last = idx[0], None
    for t, i in zip(times, idx):
        if i < pos and last is not None:        # two requested times mapped to the same frame
            yield t, last
            continue
        while pos < i:
            if not cap.grab():
                return
            pos += 1
        ok, frame = cap.read()
        pos += 1
        if not ok:
            return
        last = frame
        yield t, frame


# --------------------------------------------------------------------------
# analysis modes
# --------------------------------------------------------------------------
def _analyse_sample(cap, meta, t, p):
    """Track fish over t +/- context seconds, then count unique tracks near t."""
    step = 1.0 / p["context_fps"]
    n = int(round(2 * p["context_sec"] / step))
    times = [t - p["context_sec"] + i * step for i in range(n + 1)]
    times = [x for x in times if 0 <= x <= meta["duration"]]

    frames, first = [], True
    for ts, frame in _read_frames(cap, meta["fps"], meta["frames"], times):
        frames.append({"t": round(ts, 3), "boxes": _track(_preprocess(frame, p), p, reset=first)})
        first = False

    hits, nearest = Counter(), {}
    for f in frames:
        dt = abs(f["t"] - t)
        for b in f["boxes"]:
            tid = b["track"]
            if tid is None:
                continue
            hits[tid] += 1
            if dt <= p["tolerance"] and (tid not in nearest or dt < nearest[tid][0]):
                nearest[tid] = (dt, b)

    # protocol: a fish counts if visible within ~0.5 s of the sample point; min_hits drops flickers
    target = [dict(b) for tid, (_, b) in nearest.items() if hits[tid] >= p["min_hits"]]
    return {"t": t, "frames": frames, "target_boxes": target}


def _run_samples(cap, meta, p, job):
    start = p["trim_start"]
    end = min(meta["duration"] - p["trim_end"], start + p["window"])
    n = int((end - start) // p["interval"])
    if n < 1:
        raise ValueError("Video is too short for the chosen trim / interval settings")
    times = [start + k * p["interval"] for k in range(n)]
    samples = []
    for k, t in enumerate(times):
        job["message"] = f"Sample {k + 1} of {n}"
        samples.append(_analyse_sample(cap, meta, t, p))
        job["progress"] = (k + 1) / n
    return {"mode": "samples", "analysis_start": start, "analysis_end": end,
            "interval": p["interval"], "samples": samples}


def _segments(times, gap):
    spans = []
    for t in times:
        if spans and t - spans[-1][1] <= gap:
            spans[-1][1] = t
        else:
            spans.append([t, t])
    return [{"start": max(0.0, a - 0.5), "end": b + 0.5} for a, b in spans]


def _run_full(cap, meta, p, job):
    fps, total, stride = meta["fps"], max(meta["frames"], 1), p["stride"]
    raw, i, first = [], 0, True
    while cap.grab():                              # grab() is cheap; only decode every Nth frame
        if i % stride == 0:
            ok, frame = cap.retrieve()
            if ok:
                raw.append({"t": round(i / fps, 3),
                            "boxes": _track(_preprocess(frame, p), p, reset=first)})
                first = False
        i += 1
        if i % 100 == 0:
            job["progress"] = min(i / total, 0.99)
            job["message"] = f"Scanning {i}/{total} frames"

    hits = Counter(b["track"] for f in raw for b in f["boxes"] if b["track"] is not None)
    keep = {tid for tid, n in hits.items() if n >= p["min_hits"]}
    frames = []
    for f in raw:
        boxes = [b for b in f["boxes"] if b["track"] in keep]
        if boxes:
            frames.append({"t": f["t"], "boxes": boxes})
    gap = max(2.0, 2 * stride / fps)
    return {"mode": "full", "step": stride / fps, "frames": frames,
            "segments": _segments([f["t"] for f in frames], gap), "unique_tracks": len(keep)}


# --------------------------------------------------------------------------
# jobs
# --------------------------------------------------------------------------
def _num(body, key, default, lo=None, hi=None):
    try:
        v = float(body.get(key, default))
    except (TypeError, ValueError):
        v = float(default)
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def _params(body):
    mode = "full" if body.get("mode") == "full" else "samples"
    return {
        "mode": mode,
        # protocol sampling
        "interval": _num(body, "interval", 60, 1),
        "trim_start": _num(body, "trim_start", 60, 0),
        "trim_end": _num(body, "trim_end", 60, 0),
        "window": _num(body, "window", 900, 10),
        "context_sec": _num(body, "context_sec", 5, 0, 30),
        "context_fps": int(_num(body, "context_fps", 5, 1, 15)),
        "tolerance": _num(body, "tolerance", 0.5, 0, 1),
        "min_hits": int(_num(body, "min_hits", 5 if mode == "full" else 2, 1, 50)),
        # full scan
        "stride": int(_num(body, "stride", 5, 1, 120)),
        # image settings (same values as the browser sliders)
        "brightness": _num(body, "brightness", 0, -100, 100),
        "contrast": _num(body, "contrast", 0, -100, 100),
        "exposure": _num(body, "exposure", 0, -100, 100),
        "clahe": bool(body.get("clahe", True)),
        "clip": _num(body, "clip", 5.0, 0.5, 40),
        # model
        "conf": _num(body, "conf", _cfg["conf"], 0.01, 0.99),
        "imgsz": int(_num(body, "imgsz", _cfg["imgsz"], 160, 1920)),
    }


def _run_job(job_id, video_id, p, force):
    job = _jobs[job_id]
    cap = None
    try:
        path = _video_path(video_id)
        meta = _probe(path)
        key = hashlib.sha1(json.dumps([_quick_hash(path), p, _cfg["tracker"]],
                                      sort_keys=True).encode()).hexdigest()
        cache_file = os.path.join(CACHE_DIR, key + ".json")
        if not force and os.path.exists(cache_file):
            with open(cache_file) as f:
                job.update(status="done", progress=1.0, message="Loaded from cache",
                           result=json.load(f))
            return

        job.update(status="running", message="Starting detection")
        with model_lock:
            cap = cv2.VideoCapture(path)
            result = _run_samples(cap, meta, p, job) if p["mode"] == "samples" \
                else _run_full(cap, meta, p, job)
        with open(cache_file, "w") as f:
            json.dump(result, f)
        job.update(status="done", progress=1.0, message="Done", result=result)
    except Exception as e:  # surfaced to the UI via /progress
        job.update(status="error", message=str(e))
    finally:
        if cap is not None:
            cap.release()


@bp.post("/upload")
def upload():
    f = request.files.get("video")
    if f is None:
        return jsonify(error="No file"), 400
    ext = os.path.splitext(f.filename or "")[1].lower()
    ext = ext if ext in ALLOWED_EXT else ".mp4"
    video_id = uuid.uuid4().hex
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    path = os.path.join(UPLOAD_DIR, video_id + ext)
    f.save(path)
    meta = _probe(path)
    if not meta:
        os.remove(path)
        return jsonify(error="Could not read that video"), 400
    meta.update(video_id=video_id, name=f.filename)
    return jsonify(meta)


@bp.post("/detect")
def detect():
    body = request.get_json(force=True) or {}
    video_id = body.get("video_id", "")
    if not _video_path(video_id):
        return jsonify(error="Unknown video_id"), 404
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {"status": "queued", "progress": 0.0, "message": "Queued"}
    _executor.submit(_run_job, job_id, video_id, _params(body), bool(body.get("force")))
    return jsonify(job_id=job_id)


@bp.get("/progress/<job_id>")
def progress(job_id):
    job = _jobs.get(job_id)
    if job is None:
        return jsonify(status="error", message="Unknown job"), 404
    return jsonify(job)


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------
def _fmt_time(sec):
    sec = int(round(float(sec or 0)))
    return f"{sec // 60}:{sec % 60:02d}"


def _pct_diff(a, b):
    mean = (a + b) / 2
    return 0.0 if mean == 0 else abs(a - b) / mean * 100


def _table(payload):
    meta = payload.get("meta") or {}
    samples = payload.get("samples") or []
    names = sorted({k for s in samples for k, v in (s.get("species") or {}).items() if v})
    header = ["Transect", "STAT", "Video ID", "Analysis start", "Analysis end", "Sub-sample #",
              "Timestamp", "Visibility category", "Total Fish Count", "Invertebrate Count",
              "Total species observed", *names, UNKNOWN_COL, "Juveniles (1/0)",
              "Characteristics used", "Notes", "Reviewed"]
    rows = []
    for s in samples:
        sp = s.get("species") or {}
        rows.append([
            meta.get("transect", ""), meta.get("stat", ""),
            meta.get("video_name") or meta.get("video_id", ""),
            _fmt_time(meta.get("analysis_start")), _fmt_time(meta.get("analysis_end")),
            s.get("n"), _fmt_time(s.get("t")), s.get("visibility", ""),
            s.get("fish_count", 0), s.get("invert_count", 0),
            len([k for k, v in sp.items() if v and v > 0]),
            *[sp.get(k, 0) for k in names],
            s.get("unknown", 0), 1 if s.get("juveniles") else 0,
            ", ".join(s.get("checks") or []), s.get("notes", ""),
            "yes" if s.get("reviewed") else "no",
        ])
    return header, rows


def _summary_rows(payload):
    samples = payload.get("samples") or []
    counts = [s.get("fish_count", 0) for s in samples]
    inverts = [s.get("invert_count", 0) for s in samples]
    species = {k for s in samples for k, v in (s.get("species") or {}).items() if v}
    return [
        ("MeanCount (fish per sampled frame)", round(statistics.fmean(counts), 3) if counts else 0),
        ("SD of fish count", round(statistics.stdev(counts), 3) if len(counts) > 1 else 0),
        ("Sampled frames (n)", len(counts)),
        ("Frames reviewed", sum(1 for s in samples if s.get("reviewed"))),
        ("Species richness (identified species)", len(species)),
        ("Mean invertebrates per frame", round(statistics.fmean(inverts), 3) if inverts else 0),
        ("Juveniles present (any frame)", 1 if any(s.get("juveniles") for s in samples) else 0),
    ]


def _qc_rows(payload):
    rows = []
    for q in payload.get("qc") or []:
        counts = [c for c in (q.get("counts") or []) if c is not None]
        if len(counts) < 2:
            continue
        pct = _pct_diff(counts[0], counts[1])
        status = "OK" if pct <= QC_MAX_PCT_DIFF else \
            ("Third count recorded" if len(counts) > 2 else "Recount needed")
        rows.append([q.get("n"), counts[0], counts[1],
                     counts[2] if len(counts) > 2 else "", round(pct, 1), status])
    return rows


def _write_sheet(ws, header, rows):
    ws.append(header)
    for r in rows:
        ws.append(r)
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="1A3644")
        c.alignment = Alignment(wrap_text=True, vertical="center")
    ws.freeze_panes = "A2"
    for i, col in enumerate(ws.columns, 1):
        width = max(len(str(c.value)) if c.value is not None else 0 for c in col)
        ws.column_dimensions[get_column_letter(i)].width = min(max(10, width + 2), 48)


def _build_xlsx(payload):
    wb = Workbook()
    ws = wb.active
    ws.title = "Subsamples"
    header, rows = _table(payload)
    _write_sheet(ws, header, rows)

    ws2 = wb.create_sheet("Summary")
    _write_sheet(ws2, ["Metric", "Value"], _summary_rows(payload))

    qc = _qc_rows(payload)
    if qc:
        ws3 = wb.create_sheet("QC")
        _write_sheet(ws3, ["Sub-sample #", "Count 1 (annotator)", "Count 2 (blind)", "Count 3",
                           "% difference", "Status"], qc)
        ok = sum(1 for r in qc if r[4] <= QC_MAX_PCT_DIFF)
        ws3.append([])
        ws3.append(["Frames within threshold", f"{ok}/{len(qc)}"])
        ws3.append(["Mean % difference", round(statistics.fmean(r[4] for r in qc), 1)])

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _build_csv(payload):
    buf = io.StringIO()
    w = csv.writer(buf)
    header, rows = _table(payload)
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue()


def _build_zip(payload):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("counts.xlsx", _build_xlsx(payload))
        z.writestr("counts.csv", _build_csv(payload))
        for shot in payload.get("screenshots") or []:
            m = re.match(r"data:image/(png|jpeg);base64,(.+)$", shot.get("data_url", ""), re.S)
            if not m:
                continue
            name = re.sub(r"[^\w.\-]", "_", shot.get("name") or "frame")
            ext = "jpg" if m.group(1) == "jpeg" else "png"
            z.writestr(f"screenshots/{name}.{ext}", base64.b64decode(m.group(2)))
    return buf.getvalue()


@bp.post("/export")
def export():
    payload = request.get_json(force=True) or {}
    fmt = payload.get("format", "xlsx")
    video = (payload.get("meta") or {}).get("video_name") or "fish_eye"
    base = re.sub(r"[^\w.\-]", "_", os.path.splitext(video)[0])

    if fmt == "csv":
        data, mime, name = _build_csv(payload).encode("utf-8-sig"), "text/csv", f"{base}_counts.csv"
    elif fmt == "zip":
        data, mime, name = _build_zip(payload), "application/zip", f"{base}_export.zip"
    else:
        data = _build_xlsx(payload)
        mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        name = f"{base}_counts.xlsx"
    return send_file(io.BytesIO(data), mimetype=mime, as_attachment=True, download_name=name)