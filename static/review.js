/*
 * Top-level const/let/function declarations in classic scripts share one scope, so this file
 * reuses script.js's videoPlayer, videoInput, sliders (brightness, contrast, exposure),
 * timeline, formatTime, showVideo, saveVideo and setMotionSegments directly. Nothing in
 * script.js is edited.
 */
(function () {
    "use strict";

    /* =============================== config =============================== */
    const API = "/api";
    const CONTEXT_SEC = 5;      // seconds shown either side of a sample point
    const COUNT_TOL = 0.5;      // a fish seen within this many seconds of the point still counts
    const LOW_CONF = 0.5;       // boxes below this are drawn in blue for a closer look
    const QC_MAX_PCT = 6;       // protocol: <6% difference between two blind counts
    const AMBER = "#ECAF4B", BLUE = "#4B88EC", MIST = "#D1D7DC", NAVY = "#1A3644";

    const VISIBILITY = [["", "Not set"], ["<0.5 m", "<0.5 m"], ["0.5–1.0 m", "0.5–1.0 m"],
                        ["1.0–1.5 m", "1.0–1.5 m"], [">1.5 m", ">1.5 m"]];
    // placeholder list - replace with the species you expect at your sites
    const SPECIES = [["", "Unknown / unable to ID"], "Mummichog", "Atlantic silverside",
                    "Threespine stickleback", "Ninespine stickleback", "Winter flounder",
                    "Rock gunnel", "Atlantic tomcod", "American eel", "Striped bass",
                    "Rainbow smelt", "Sculpin sp.", "Cunner"];
    const CHECKS = [["shape", "Fish shape"], ["anatomy", "Anatomical features"],
                    ["colour", "Colouration / flash"], ["movement", "Swimming behaviour"]];

    /* =============================== state =============================== */
    function freshState() {
        return {
            videoId: null, meta: null, fileName: "",
            mode: "samples", samples: [], full: null, analysis: null,
            idx: -1, selected: null, edit: false,
            info: { transect: "", stat: "" },
            qcSet: [], qc: {}, blind: false
        };
    }
    const S = freshState();
    const ui = {};
    let ctxEnd = null;          // end time of the running context playback
    let drag = null;            // rubber-band box being drawn

    /* =============================== helpers =============================== */
    function mk(tag, props, ...kids) {
        const n = document.createElement(tag);
        Object.entries(props || {}).forEach(([k, v]) => {
            if (k === "class") n.className = v;
            else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
            else if (k in n) n[k] = v;
            else n.setAttribute(k, v);
        });
        kids.flat().forEach(c => n.append(c));
        return n;
    }
    function sel(options, value, onchange) {
        const s = mk("select", { onchange: e => onchange(e.target.value) });
        options.forEach(o => {
            const [v, l] = Array.isArray(o) ? o : [o, o];
            s.append(mk("option", { value: v }, l));
        });
        s.value = value;
        return s;
    }
    function numInput(value, min, max, step) {
        return mk("input", { type: "number", min, max, step: step || 1, value });
    }
    const uid = () => Math.random().toString(36).slice(2, 9);
    const pct = (a, b) => { const m = (a + b) / 2; return m === 0 ? 0 : Math.abs(a - b) / m * 100; };
    const cur = () => S.samples[S.idx] || null;
    const live = s => s.boxes.filter(b => b.status !== "rejected");
    const fishCount = s => live(s).length;

    function speciesCounts(s) {
        const m = {}; let unknown = 0;
        live(s).forEach(b => { if (b.species) m[b.species] = (m[b.species] || 0) + 1; else unknown++; });
        return { m, unknown };
    }
    function isBlind(s) {
        return S.blind && S.qcSet.includes(s.n) && !(S.qc[s.n] && S.qc[s.n].revealed);
    }
    function sampleNear(t, within) {
        let best = null, bestDt = Infinity;
        S.samples.forEach(s => { const d = Math.abs(t - s.t); if (d <= within && d < bestDt) { best = s; bestDt = d; } });
        return best;
    }
    function nearestFrame(frames, t, maxGap) {
        let lo = 0, hi = frames.length - 1;
        if (hi < 0) return null;
        while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].t < t) lo = m + 1; else hi = m; }
        let best = frames[lo];
        if (lo > 0 && Math.abs(frames[lo - 1].t - t) < Math.abs(best.t - t)) best = frames[lo - 1];
        return Math.abs(best.t - t) <= maxGap ? best : null;
    }
    function download(blob, name) {
        const a = mk("a", { href: URL.createObjectURL(blob), download: name });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    function setStatus(msg) { ui.status.textContent = msg; }
    function setProgress(f, msg) { ui.barFill.style.width = Math.round(f * 100) + "%"; if (msg) setStatus(msg); }

    /* =============================== analysis card =============================== */
    function field(label, input, wide) {
        return mk("label", { class: "rv-field" + (wide ? " wide" : "") }, mk("span", {}, label), input);
    }
    function buildAnalysisCard() {
        ui.mode = sel([["samples", "Protocol samples"], ["full", "Full-video scan (slower)"]], "samples", () => {});
        ui.interval = numInput(60, 5, 600);
        ui.trimStart = numInput(60, 0, 600);
        ui.trimEnd = numInput(60, 0, 600);
        ui.window = numInput(15, 1, 120);
        ui.stride = numInput(5, 1, 120);
        ui.clahe = mk("input", { type: "checkbox", checked: true });
        ui.clip = numInput(5, 0.5, 40, 0.5);
        ui.transect = mk("input", { type: "text", placeholder: "e.g. T1", oninput: e => { S.info.transect = e.target.value; persist(); } });
        ui.stat = mk("input", { type: "text", placeholder: "e.g. STAT 1", oninput: e => { S.info.stat = e.target.value; persist(); } });
        ui.run = mk("button", { type: "button", class: "upload-btn", onclick: runAnalysis }, "Analyse");
        ui.barFill = mk("div");
        ui.status = mk("p", { class: "timeline-status" }, "Upload a video, then press Analyse.");

        const card = mk("div", { class: "controls", id: "analysis-card" },
            mk("div", { class: "controls-head" }, mk("h2", { class: "controls-title" }, "Analyse"), ui.run),
            mk("div", { class: "rv-grid" },
                field("Mode", ui.mode, true),
                field("Sample every (s)", ui.interval),
                field("Window (min)", ui.window),
                field("Skip start (s)", ui.trimStart),
                field("Skip end (s)", ui.trimEnd),
                field("Scan stride (frames)", ui.stride),
                field("CLAHE clip limit", ui.clip),
                mk("label", { class: "rv-check wide" }, ui.clahe, "Apply CLAHE before detection"),
                field("Transect", ui.transect),
                field("STAT", ui.stat)),
            mk("div", { class: "rv-bar" }, ui.barFill),
            ui.status);
        document.querySelector(".editor").append(card);
    }

    /* =============================== upload + detection =============================== */
    function uploadFile(file, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", API + "/upload");
            xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
            xhr.onload = () => xhr.status === 200 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.responseText));
            xhr.onerror = () => reject(new Error("network error"));
            const fd = new FormData(); fd.append("video", file); xhr.send(fd);
        });
    }

    // Capture phase on document: runs before script.js's slow /process-video handler and stops it.
    document.addEventListener("change", async function (e) {
        if (e.target !== videoInput) return;
        e.stopImmediatePropagation();
        const file = videoInput.files[0];
        videoInput.value = "";
        if (!file) return;

        resetAll();
        showVideo(file);                                   // plays the original straight away
        saveVideo(file).catch(err => console.error("Could not save video:", err));
        ui.run.disabled = true;
        try {
            const meta = await uploadFile(file, f => setProgress(f, "Uploading to server…"));
            S.videoId = meta.video_id; S.meta = meta; S.fileName = file.name;
            setProgress(0, `Uploaded · ${formatTime(meta.duration)} · ${Math.round(meta.fps)} fps. Press Analyse.`);
            persist();
        } catch (err) {
            setProgress(0, "Upload failed: " + err.message);
        }
        ui.run.disabled = false;
    }, true);

    async function runAnalysis() {
        if (!S.videoId) { setStatus("Upload a video first."); return; }
        const body = {
            video_id: S.videoId, mode: ui.mode.value,
            interval: +ui.interval.value, window: +ui.window.value * 60,
            trim_start: +ui.trimStart.value, trim_end: +ui.trimEnd.value, stride: +ui.stride.value,
            brightness: +brightness.value, contrast: +contrast.value, exposure: +exposure.value,   // slider values from script.js
            clahe: ui.clahe.checked, clip: +ui.clip.value
        };
        ui.run.disabled = true; setProgress(0, "Queued…");
        try {
            const r = await fetch(API + "/detect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            if (!r.ok) throw new Error((await r.json()).error || r.statusText);
            const { job_id } = await r.json();
            let job;
            do {
                await new Promise(res => setTimeout(res, 700));
                job = await (await fetch(`${API}/progress/${job_id}`)).json();
                setProgress(job.progress || 0, job.message);
            } while (job.status !== "done" && job.status !== "error");
            if (job.status === "error") throw new Error(job.message);
            ingest(job.result);
            setProgress(1, S.mode === "samples" ? "Done. Review each sample ( [ and ] to move )." : "Done. Highlighted spans show tracked fish.");
        } catch (err) {
            setProgress(0, "Analysis failed: " + err.message);
        }
        ui.run.disabled = false;
    }

    function ingest(result) {
        const info = S.info, meta = S.meta, videoId = S.videoId, fileName = S.fileName;
        Object.assign(S, freshState(), { info, meta, videoId, fileName, mode: result.mode });
        if (result.mode === "samples") {
            S.analysis = { start: result.analysis_start, end: result.analysis_end, interval: result.interval };
            S.samples = result.samples.map((s, i) => ({
                n: i + 1, t: s.t, frames: s.frames,
                boxes: s.target_boxes.map(b => ({ ...b, id: uid(), origin: "auto", status: "auto", species: "" })),
                invert: 0, visibility: "", juveniles: false, notes: "", checks: [], reviewed: false, shot: null
            }));
        } else {
            S.full = { frames: result.frames, segments: result.segments, unique_tracks: result.unique_tracks, step: result.step };
        }
        applySegments(); renderTicks(); renderPanel(); updateSummary(); draw(); persist();
        if (S.samples.length) go(0);
    }

    function resetAll() {
        const info = S.info;
        Object.assign(S, freshState(), { info });
        applySegments(); renderTicks(); renderPanel(); updateSummary(); draw();
    }

    /* =============================== timeline: segments + sample ticks =============================== */
    function applySegments() {
        if (S.mode === "samples" && S.samples.length)
            setMotionSegments(S.samples.map(s => ({ start: s.t - CONTEXT_SEC, end: s.t + CONTEXT_SEC })));
        else if (S.mode === "full" && S.full)
            setMotionSegments(S.full.segments);
        else
            setMotionSegments([]);
    }
    function renderTicks() {
        if (!ui.ticks) { ui.ticks = mk("div", { class: "rv-ticks" }); timeline.append(ui.ticks); }
        ui.ticks.replaceChildren();
        const d = videoPlayer.duration;
        if (!d || S.mode !== "samples") return;
        S.samples.forEach((s, i) => ui.ticks.append(mk("span", {
            class: "rv-tick" + (s.reviewed ? " done" : "") + (i === S.idx ? " current" : "") + (S.qcSet.includes(s.n) ? " qc" : ""),
            style: `left:${(s.t / d) * 100}%`, title: `Sample ${s.n} · ${formatTime(s.t)}`
        })));
    }
    // script.js shows demo segments on load; this runs after it and replaces them
    videoPlayer.addEventListener("loadedmetadata", () => { applySegments(); renderTicks(); draw(); });

    function go(i) {
        if (!S.samples.length) return;
        S.idx = Math.min(Math.max(i, 0), S.samples.length - 1);
        S.selected = null; ctxEnd = null; videoPlayer.playbackRate = 1;
        videoPlayer.pause();
        videoPlayer.currentTime = cur().t;
        renderTicks(); renderPanel(); draw();
    }

    /* =============================== overlay canvas =============================== */
    const cv = mk("canvas", { class: "rv-overlay" });
    videoPlayer.parentElement.append(cv);
    const g = cv.getContext("2d");

    function fit() {
        const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
        cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
        g.setTransform(d, 0, 0, d, 0, 0);
        draw();
    }
    new ResizeObserver(fit).observe(cv);

    // the <video> uses object-fit: contain, so map 0-1 coordinates onto the letterboxed picture
    function vidRect() {
        const W = cv.clientWidth, H = cv.clientHeight;
        const vw = videoPlayer.videoWidth || 16, vh = videoPlayer.videoHeight || 9;
        const k = Math.min(W / vw, H / vh), w = vw * k, h = vh * k;
        return { x: (W - w) / 2, y: (H - h) / 2, w, h };
    }

    function paintBox(c, b, r, selected) {
        const k = Math.max(1, r.w / 900);
        const x = r.x + b.x1 * r.w, y = r.y + b.y1 * r.h, w = (b.x2 - b.x1) * r.w, h = (b.y2 - b.y1) * r.h;
        const ctxBox = b.status === "ctx", rejected = b.status === "rejected", added = b.origin === "added";
        const colour = rejected ? "#fff" : added ? MIST : (b.conf < LOW_CONF ? BLUE : AMBER);
        c.save();
        c.globalAlpha = rejected ? 0.55 : ctxBox ? 0.75 : 1;
        c.strokeStyle = colour; c.lineWidth = (ctxBox ? 1.5 : selected ? 4 : 2.5) * k;
        c.setLineDash(rejected ? [6 * k, 4 * k] : []);
        c.strokeRect(x, y, w, h);
        if (!ctxBox) {
            const label = rejected ? "rejected" : `${b.species || "fish"}${b.track != null ? " #" + b.track : ""}${b.conf < 1 ? " " + Math.round(b.conf * 100) + "%" : ""}`;
            c.font = `${12 * k}px "Archivo Narrow", Arial, sans-serif`;
            const tw = c.measureText(label).width;
            c.setLineDash([]); c.fillStyle = colour;
            c.fillRect(x, y - 18 * k, tw + 8 * k, 18 * k);
            c.fillStyle = NAVY; c.fillText(label, x + 4 * k, y - 5 * k);
        }
        c.restore();
    }

    function draw() {
        if (!cv.clientWidth) return;
        g.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
        const vr = vidRect(), t = videoPlayer.currentTime || 0;
        let boxes = [], editable = false;
        const s = S.mode === "samples" ? sampleNear(t, CONTEXT_SEC) : null;

        if (s) {
            const dt = Math.abs(t - s.t);
            if (!isBlind(s)) {
                if (videoPlayer.paused && dt <= COUNT_TOL) { boxes = s.boxes; editable = true; }
                else {
                    const f = nearestFrame(s.frames, t, 0.3);
                    boxes = f ? f.boxes.map(b => ({ ...b, status: "ctx" })) : [];
                }
            }
            if (!videoPlayer.paused && dt <= COUNT_TOL) {          // marks the second that counts
                g.save(); g.strokeStyle = AMBER; g.lineWidth = 4;
                g.strokeRect(vr.x + 2, vr.y + 2, vr.w - 4, vr.h - 4);
                g.fillStyle = AMBER; g.fillRect(vr.x + 2, vr.y + 2, 74, 22);
                g.fillStyle = NAVY; g.font = '14px "Archivo Narrow", Arial'; g.fillText("COUNT", vr.x + 12, vr.y + 18);
                g.restore();
            }
        } else if (S.mode === "full" && S.full) {
            const f = nearestFrame(S.full.frames, t, S.full.step * 1.5);
            boxes = f ? f.boxes.map(b => ({ ...b, status: "ctx" })) : [];
        }

        boxes.forEach(b => paintBox(g, b, vr, b === S.selected));
        if (drag) {
            g.save(); g.strokeStyle = MIST; g.lineWidth = 2; g.setLineDash([5, 4]);
            g.strokeRect(vr.x + Math.min(drag.x0, drag.x1) * vr.w, vr.y + Math.min(drag.y0, drag.y1) * vr.h,
                         Math.abs(drag.x1 - drag.x0) * vr.w, Math.abs(drag.y1 - drag.y0) * vr.h);
            g.restore();
        }
        const on = S.edit && editable;
        cv.style.pointerEvents = on ? "auto" : "none";
        cv.style.cursor = on ? "crosshair" : "default";
    }

    // keep the overlay in step with the video
    ["seeked", "timeupdate", "pause", "loadeddata"].forEach(n => videoPlayer.addEventListener(n, () => { syncIdx(); draw(); }));
    videoPlayer.addEventListener("play", function loop() {
        draw();
        if (!videoPlayer.paused) requestAnimationFrame(loop);
    });
    function syncIdx() {                                  // follow the playhead into another sample window
        if (S.mode !== "samples" || !S.samples.length) return;
        const s = sampleNear(videoPlayer.currentTime || 0, CONTEXT_SEC);
        if (s && S.samples.indexOf(s) !== S.idx) {
            S.idx = S.samples.indexOf(s); S.selected = null; renderTicks(); renderPanel();
        }
    }

    /* ----- box editing ----- */
    function norm(e) {
        const r = cv.getBoundingClientRect(), vr = vidRect();
        const x = (e.clientX - r.left - vr.x) / vr.w, y = (e.clientY - r.top - vr.y) / vr.h;
        return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
    }
    cv.addEventListener("pointerdown", e => {
        const s = cur(); if (!s || !S.edit) return;
        const p = norm(e); if (!p) return;
        const hit = [...s.boxes].reverse().find(b => p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2);
        if (hit) { S.selected = hit; renderPanel(); draw(); return; }
        S.selected = null; drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        cv.setPointerCapture(e.pointerId); renderPanel(); draw();
    });
    cv.addEventListener("pointermove", e => {
        if (!drag) return;
        const p = norm(e); if (!p) return;
        drag.x1 = p.x; drag.y1 = p.y; draw();
    });
    cv.addEventListener("pointerup", () => {
        const s = cur();
        if (drag && s && Math.abs(drag.x1 - drag.x0) > 0.01 && Math.abs(drag.y1 - drag.y0) > 0.01) {
            const b = { id: uid(), origin: "added", status: "added", track: null, conf: 1, cls: "fish", species: "",
                        x1: Math.min(drag.x0, drag.x1), y1: Math.min(drag.y0, drag.y1),
                        x2: Math.max(drag.x0, drag.x1), y2: Math.max(drag.y0, drag.y1) };
            s.boxes.push(b); S.selected = b; afterEdit(); renderPanel();
        }
        drag = null; draw();
    });

    function toggleEdit() {
        const s = cur(); if (!s) return;
        S.edit = !S.edit;
        if (S.edit) {
            videoPlayer.pause();
            if (Math.abs(videoPlayer.currentTime - s.t) > COUNT_TOL) videoPlayer.currentTime = s.t;
        }
        renderPanel(); draw();
    }
    function rejectSelected() {
        const s = cur(), b = S.selected; if (!s || !b) return;
        if (b.origin === "added") { s.boxes.splice(s.boxes.indexOf(b), 1); S.selected = null; }
        else b.status = b.status === "rejected" ? "auto" : "rejected";
        afterEdit(); renderPanel();
    }

    /* =============================== review panel =============================== */
    function buildPanel() {
        ui.panel = mk("div", { class: "rv-panel" });
        document.querySelector(".info-panel").append(ui.panel);
    }

    function renderPanel() {
        const p = ui.panel; p.replaceChildren();
        if (S.mode === "full" && S.full) {
            p.append(mk("p", { class: "info-note" }, "Full-video scan: highlighted spans show where fish were tracked. Use “Protocol samples” for MeanCount and review."));
            return;
        }
        if (!S.samples.length) {
            p.append(mk("p", { class: "info-note" }, "Run “Protocol samples” to review the sampled frames one by one."));
            return;
        }
        const s = cur();
        if (!s) { p.append(mk("p", { class: "info-note" }, "Press ] or use the timeline markers to start reviewing.")); renderQC(p); renderExport(p); return; }

        p.append(mk("div", { class: "rv-nav" },
            mk("button", { type: "button", class: "icon-btn", title: "Previous sample ([)", onclick: () => go(S.idx - 1) }, "‹"),
            mk("div", { class: "rv-nav-title" }, `Sample ${s.n} / ${S.samples.length}`, mk("small", {}, formatTime(s.t))),
            mk("button", { type: "button", class: "icon-btn", title: "Next sample (])", onclick: () => go(S.idx + 1) }, "›")));

        if (isBlind(s)) {
            p.append(blindBlock(s));
        } else {
            ui.big = mk("span", { class: "rv-big" }, String(fishCount(s)));
            ui.breakdown = mk("p", { class: "info-note" });
            p.append(mk("div", { class: "rv-count" }, ui.big, mk("span", { class: "stat-label" }, "fish in this frame")), ui.breakdown);
            refreshCounts(s);

            p.append(mk("div", { class: "rv-actions" },
                mk("button", { type: "button", class: "reset-btn" + (S.edit ? " on" : ""), onclick: toggleEdit }, S.edit ? "Done editing" : "Edit boxes (E)"),
                mk("button", { type: "button", class: "reset-btn", onclick: playContext }, "Play ±5 s (C)"),
                ui.rate = sel([["0.25", "0.25×"], ["0.5", "0.5×"], ["1", "1×"]], "0.25", () => {})));
            if (S.edit) p.append(mk("p", { class: "info-note" }, "Click a box to select · drag on empty water to add a fish · Del rejects the selected box."));

            if (S.selected && s.boxes.includes(S.selected)) {
                p.append(mk("div", { class: "rv-selected" },
                    field("Selected box · species", sel(SPECIES, S.selected.species, v => { S.selected.species = v; afterEdit(); refreshCounts(s); draw(); })),
                    mk("button", { type: "button", class: "reset-btn", onclick: rejectSelected },
                        S.selected.origin === "added" ? "Delete box" : S.selected.status === "rejected" ? "Restore box" : "Reject box")));
            }

            p.append(mk("div", { class: "rv-grid" },
                field("Invertebrates", (() => { const i = numInput(s.invert, 0, 999); i.oninput = () => { s.invert = Math.max(0, +i.value || 0); afterEdit(); }; return i; })()),
                field("Visibility", sel(VISIBILITY, s.visibility, v => { s.visibility = v; afterEdit(); })),
                mk("label", { class: "rv-check wide" },
                    mk("input", { type: "checkbox", checked: s.juveniles, onchange: e => { s.juveniles = e.target.checked; afterEdit(); } }),
                    "Juveniles present")));

            p.append(mk("fieldset", { class: "rv-checks" }, mk("legend", {}, "Why it counts (2 or more)"),
                CHECKS.map(([key, label]) => mk("label", { class: "rv-check" },
                    mk("input", { type: "checkbox", checked: s.checks.includes(key), onchange: e => {
                        s.checks = e.target.checked ? [...s.checks, key] : s.checks.filter(k => k !== key); afterEdit();
                    } }), label))));

            p.append(field("Notes", mk("textarea", { rows: 3, value: s.notes, oninput: e => { s.notes = e.target.value; persist(); } }), true));

            const shotRow = mk("div", { class: "rv-actions" },
                mk("button", { type: "button", class: "reset-btn", onclick: () => { if (capture(s)) { persist(); renderPanel(); } else setStatus("Pause on the sample point to capture it."); } }, "Capture frame"),
                mk("button", { type: "button", class: "upload-btn", onclick: markReviewed }, s.reviewed ? "Reviewed ✓ Next" : "Mark reviewed"));
            p.append(shotRow);
            if (s.shot) p.append(mk("img", { class: "rv-thumb", src: s.shot, alt: `Sample ${s.n} capture` }));
        }
        renderQC(p);
        renderExport(p);
    }

    function refreshCounts(s) {
        if (!ui.big) return;
        ui.big.textContent = fishCount(s);
        const { m, unknown } = speciesCounts(s);
        const parts = Object.entries(m).map(([k, v]) => `${k} ×${v}`);
        if (unknown) parts.push(`unidentified ×${unknown}`);
        const auto = s.boxes.filter(b => b.origin === "auto").length, added = s.boxes.filter(b => b.origin === "added").length;
        ui.breakdown.textContent = `${parts.join(" · ") || "No fish"} — ${auto} detected, ${added} added by you`;
    }

    function afterEdit() { updateSummary(); renderTicks(); persist(); draw(); }

    function markReviewed() {
        const s = cur(); if (!s) return;
        if (!s.shot && videoPlayer.paused && Math.abs(videoPlayer.currentTime - s.t) <= COUNT_TOL) capture(s);
        s.reviewed = true; S.edit = false; updateSummary(); persist();
        if (S.idx < S.samples.length - 1) go(S.idx + 1); else { renderTicks(); renderPanel(); }
    }

    /* =============================== context player =============================== */
    function playContext() {
        const s = cur(); if (!s) return;
        S.edit = false;
        videoPlayer.pause();
        videoPlayer.currentTime = Math.max(0, s.t - CONTEXT_SEC);
        videoPlayer.playbackRate = +((ui.rate && ui.rate.value) || 0.25);
        ctxEnd = s.t + CONTEXT_SEC;
        videoPlayer.play().catch(() => {});
        (function watch() {
            if (ctxEnd == null) return;
            if (videoPlayer.paused) { ctxEnd = null; videoPlayer.playbackRate = 1; return; }   // user paused
            if (videoPlayer.currentTime >= ctxEnd) {
                videoPlayer.pause(); videoPlayer.currentTime = s.t; videoPlayer.playbackRate = 1; ctxEnd = null;
                renderPanel(); draw();
            } else requestAnimationFrame(watch);
        })();
    }

    /* =============================== screenshot =============================== */
    function capture(s) {
        if (!videoPlayer.videoWidth || !videoPlayer.paused || Math.abs(videoPlayer.currentTime - s.t) > COUNT_TOL) return null;
        const c = document.createElement("canvas");
        c.width = videoPlayer.videoWidth; c.height = videoPlayer.videoHeight;
        const x = c.getContext("2d");
        x.filter = videoPlayer.style.filter || "none";     // slider adjustments (not supported in Safari)
        x.drawImage(videoPlayer, 0, 0, c.width, c.height);
        x.filter = "none";
        const r = { x: 0, y: 0, w: c.width, h: c.height };
        live(s).forEach(b => paintBox(x, b, r, false));
        s.shot = c.toDataURL("image/jpeg", 0.88);
        return s.shot;
    }

    /* =============================== live summary (existing stat card) =============================== */
    function updateSummary() {
        const val = document.getElementById("fish-count"), label = document.querySelector(".stat-label"),
              note = document.getElementById("info-text");
        if (S.mode === "full" && S.full) {
            val.textContent = S.full.unique_tracks; label.textContent = "unique fish tracks (full scan)";
            note.textContent = `${S.full.segments.length} segments with fish.`; return;
        }
        if (!S.samples.length) {
            val.textContent = "—"; label.textContent = "detected in current video";
            note.textContent = "Counts will appear here once a video is analysed."; return;
        }
        if (S.blind) { val.textContent = "—"; label.textContent = "hidden in blind QC mode"; note.textContent = ""; return; }
        const c = S.samples.map(fishCount), n = c.length, mean = c.reduce((a, b) => a + b, 0) / n;
        const sd = n > 1 ? Math.sqrt(c.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
        const richness = new Set(S.samples.flatMap(s => live(s).map(b => b.species).filter(Boolean))).size;
        val.textContent = mean.toFixed(2);
        label.textContent = "MeanCount · fish per sampled frame";
        note.textContent = `n = ${n} frames · SD ${sd.toFixed(2)} · ${richness} species named · ${S.samples.filter(s => s.reviewed).length}/${n} reviewed`;
    }

    /* =============================== blind QC =============================== */
    function pickQC(percent) {
        const n = Math.max(1, Math.ceil(S.samples.length * percent / 100));
        const pool = S.samples.map(s => s.n);
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        S.qcSet = pool.slice(0, n).sort((a, b) => a - b); S.qc = {};
        renderTicks(); renderPanel(); persist();
    }
    function blindBlock(s) {
        const q = S.qc[s.n] = S.qc[s.n] || { b: null, c: null, revealed: false };
        const input = numInput(q.b == null ? "" : q.b, 0, 999);
        input.oninput = () => { q.b = input.value === "" ? null : +input.value; persist(); };
        return mk("div", { class: "rv-selected" },
            mk("p", { class: "info-note" }, "Blind QC: count the fish you can see in this frame. The first count and boxes stay hidden until you reveal."),
            field("Your count", input),
            mk("button", { type: "button", class: "upload-btn", onclick: () => { if (q.b == null) return; q.revealed = true; persist(); renderPanel(); draw(); } }, "Reveal and compare"));
    }
    function renderQC(p) {
        const box = mk("details", { class: "rv-qc", open: S.qcSet.length > 0 },
            mk("summary", {}, "Blind QC"));
        const pctIn = numInput(20, 1, 100);
        box.append(mk("div", { class: "rv-actions" }, field("% of frames", pctIn),
            mk("button", { type: "button", class: "reset-btn", onclick: () => pickQC(+pctIn.value || 20) }, "Pick random frames")));
        if (S.qcSet.length) {
            box.append(mk("p", { class: "info-note" }, `QC frames: ${S.qcSet.join(", ")}`),
                mk("label", { class: "rv-check" }, mk("input", { type: "checkbox", checked: S.blind, onchange: e => { S.blind = e.target.checked; updateSummary(); renderPanel(); draw(); } }), "Blind mode (hide first count at QC frames)"));
            const s = cur(), q = s && S.qc[s.n];
            if (s && q && q.revealed) {
                const first = fishCount(s), d = pct(first, q.b), bad = d > QC_MAX_PCT;
                box.append(mk("p", { class: "info-note" }, `First count ${first} · blind count ${q.b} · difference ${d.toFixed(1)}% ${bad ? "(over " + QC_MAX_PCT + "% — needs a third count)" : "(within limit)"}`));
                if (bad) {
                    const c3 = numInput(q.c == null ? "" : q.c, 0, 999);
                    c3.oninput = () => { q.c = c3.value === "" ? null : +c3.value; persist(); };
                    box.append(field("Third count", c3));
                }
            }
        }
        p.append(box);
    }

    /* =============================== export =============================== */
    function rowFor(s) {
        const { m, unknown } = speciesCounts(s);
        return { n: s.n, t: s.t, visibility: s.visibility, fish_count: fishCount(s), invert_count: s.invert,
                 species: m, unknown, juveniles: s.juveniles ? 1 : 0, checks: s.checks, notes: s.notes, reviewed: s.reviewed };
    }
    async function exportAs(format) {
        if (!S.samples.length) return;
        const pending = S.samples.filter(s => !s.reviewed).length;
        if (pending && !confirm(`${pending} sample(s) not marked reviewed. Export anyway?`)) return;
        const body = {
            format,
            meta: { video_id: S.videoId, video_name: S.fileName, transect: S.info.transect, stat: S.info.stat,
                    analysis_start: S.analysis.start, analysis_end: S.analysis.end, interval: S.analysis.interval },
            samples: S.samples.map(rowFor),
            qc: S.qcSet.filter(n => S.qc[n] && S.qc[n].b != null).map(n => ({
                n, counts: [fishCount(S.samples[n - 1]), S.qc[n].b, S.qc[n].c] })),
            screenshots: format === "zip" ? S.samples.filter(s => s.shot).map(s => ({ name: `sample_${String(s.n).padStart(2, "0")}_${Math.round(s.t)}s`, data_url: s.shot })) : []
        };
        setStatus("Preparing export…");
        const r = await fetch(API + "/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) { setStatus("Export failed."); return; }
        const base = (S.fileName || "fish_eye").replace(/\.[^.]+$/, "");
        download(await r.blob(), `${base}_${format === "zip" ? "export.zip" : "counts." + format}`);
        setStatus("Export ready.");
    }
    function renderExport(p) {
        p.append(mk("div", { class: "rv-section" },
            mk("h3", {}, "Export"),
            mk("div", { class: "rv-actions" },
                mk("button", { type: "button", class: "upload-btn", onclick: () => exportAs("xlsx") }, "Excel"),
                mk("button", { type: "button", class: "reset-btn", onclick: () => exportAs("csv") }, "CSV"),
                mk("button", { type: "button", class: "reset-btn", onclick: () => exportAs("zip") }, "ZIP + frames"))));
    }

    /* =============================== persistence (separate IndexedDB) =============================== */
    function rvDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open("fisheye-review", 1);
            req.onupgradeneeded = () => req.result.createObjectStore("state");
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    let persistTimer;
    function persist() {
        clearTimeout(persistTimer);
        persistTimer = setTimeout(async () => {
            try {
                const { selected, ...rest } = S;
                const db = await rvDB();
                db.transaction("state", "readwrite").objectStore("state").put(JSON.parse(JSON.stringify(rest)), "current");
            } catch (err) { console.warn("Could not save annotations:", err); }
        }, 400);
    }
    async function restore() {
        try {
            const db = await rvDB();
            const st = await new Promise((res, rej) => {
                const q = db.transaction("state").objectStore("state").get("current");
                q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
            });
            if (!st || !st.videoId) return;
            Object.assign(S, freshState(), st, { selected: null, edit: false });
            ui.transect.value = S.info.transect || ""; ui.stat.value = S.info.stat || "";
            applySegments(); renderTicks(); renderPanel(); updateSummary(); draw();
            setStatus("Restored your previous review.");
        } catch (err) { console.warn("Could not restore annotations:", err); }
    }

    /* =============================== keyboard =============================== */
    document.addEventListener("keydown", e => {
        const tag = (e.target.tagName || "").toLowerCase();
        if (["input", "textarea", "select"].includes(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
        if (!S.samples.length) return;
        switch (e.key) {
            case "]": go(S.idx + 1); break;
            case "[": go(S.idx - 1); break;
            case "e": case "E": toggleEdit(); break;
            case "c": case "C": playContext(); break;
            case "Delete": case "Backspace": rejectSelected(); break;
            case "Enter": markReviewed(); break;
            default: return;
        }
        e.preventDefault();
    });

    /* =============================== init =============================== */
    buildAnalysisCard();
    buildPanel();
    renderPanel();
    fit();
    restore();
})();