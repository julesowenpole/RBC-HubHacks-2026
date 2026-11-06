// constants for video upload and play functionality
const videoInput = document.getElementById("video-upload");
const videoPlayer = document.getElementById("video-player");
const videoPlaceholder = document.getElementById("video-placeholder");

// constants for filters
const brightness = document.getElementById("brightness");
const contrast = document.getElementById("contrast");
const exposure = document.getElementById("exposure");
const brightnessValue = document.getElementById("brightness-value");
const contrastValue = document.getElementById("contrast-value");
const exposureValue = document.getElementById("exposure-value");

// constant for reset button
const resetButton = document.getElementById("reset-adjustments");

// brightness runs -100 to 100 (0 = no change)
// contrast and exposure run 0 to 200 (100 = no change)
const sliders = [brightness, contrast, exposure];
const DEFAULT_VALUE = 0;

// constants for IndexedDB
const DB_NAME = "fisheye-db";
const STORE = "videos";
const KEY = "current-video";

function defaultFor(slider) {
    return slider ===  DEFAULT_VALUE;
}

// ---------IndexedDB functions for saving and loading video files---------

// open the IndexedDB database and create the object store if it doesn't exist
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// save the video file to IndexedDB
async function saveVideo(file) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(file, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// load the video file from IndexedDB
async function loadVideo() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const request = tx.objectStore(STORE).get(KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

let currentURL = null;

function showVideo(file) {
    // free the previous object URL so memory is not leaked
    if (currentURL) {
        URL.revokeObjectURL(currentURL);
    }
    currentURL = URL.createObjectURL(file);
    videoPlayer.src = currentURL;

    // show the player and hide the "No video loaded" message
    videoPlayer.hidden = false;
    videoPlaceholder.hidden = true;
}

videoInput.addEventListener("change", async function () {
    const file = this.files[0];
    if (!file) return;

    showVideo(file);

    try {
        await saveVideo(file);
    } catch (err) {
        console.error("Could not save video:", err);
    }
});

// restore the saved video on page load
(async function restore() {
    try {
        const file = await loadVideo();
        if (file) {
            showVideo(file);
        }
    } catch (err) {
        console.error("Could not load saved video:", err);
    }
})();

// apply the slider values as CSS filters on the video
function applyFilters() {
    const b = 1 + brightness.value / 100;
    const c = 1 + contrast.value / 100;

    const exposureStops = (exposure.value - DEFAULT_VALUE) / 100;   // -1 to +1 stops

    const totalBrightness = b * Math.pow(2, exposureStops);
    const totalContrast = c;

    videoPlayer.style.filter =
        `brightness(${totalBrightness.toFixed(3)}) contrast(${totalContrast.toFixed(3)})`;

    brightnessValue.textContent = brightness.value;
    contrastValue.textContent = contrast.value;
    exposureValue.textContent = exposure.value;
}

// listeners for sliders
sliders.forEach(function(slider) {
    slider.addEventListener("input", applyFilters);

    // double-click a single slider to reset just that one
    slider.addEventListener("dblclick", function() {
        slider.value = defaultFor(slider);
        applyFilters();
    });
});

// listener for reset button
resetButton.addEventListener("click", function() {
    sliders.forEach(function(slider) {
        slider.value = defaultFor(slider);
    });
    applyFilters();
});

applyFilters();

// ---------- Motion detection ----------
const overlay = document.getElementById("motion-overlay");
const overlayCtx = overlay.getContext("2d");
const motionToggle = document.getElementById("motion-toggle");

const ANALYSIS_WIDTH = 320;
const MAX_CHANGED_FRACTION = 0.4; // if more than 40% of the frame "moves", assume a flash/shake and ignore it

const MIN_BLOB_AREA = 4;      // keep small fragments so they can be merged
const DILATE_RADIUS = 2;        // joins fragments of one fish
const RECENT_THRESHOLD = 10;     // change over the last 2 samples; trims the trail behind a fish
const MAX_BLOB_AREA = 0.25;     // ignore boxes covering more than 25% of the video
const MIN_GROUP_AREA = 100;    // after merging, drop anything smaller (specks/noise)

// motion energy
const SAMPLE_INTERVAL = 0.1;    // seconds of video between analysed frames
const MOTION_STEPS = 6;         // frames of motion to accumulate (6 x 0.1s = 0.6s)
const ENERGY_THRESHOLD = 24;    // how much accumulated change counts as motion

// tracker
const MATCH_DIST = 0.12;        // max centre jump (fraction of video) to be the same fish
const MIN_HITS = 3;             // detections needed before a box is shown
const MAX_MISSES = 6;           // missed samples before a box disappears (6 = 0.6s)
const SMOOTHING = 0.2;          // 0-1, lower = smoother but laggier boxes

const analysisCanvas = document.createElement("canvas");
const analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });

let prevGray = null;
let diffs = [];
let accum = null;
let lastSampleTime = -1;
let tracks = [];
let nextTrackId = 1;

let lastBlobs = [];
let motionRunning = false;

function resetMotion() {
    prevGray = null;
    diffs = [];
    accum = null;
    lastSampleTime = -1;
    tracks = [];
    lastBlobs = [];
    drawOverlay([]);
}

// 3x3 dilation so fragments of one fish merge into a single blob
function dilate(mask, w, h, r = 1) {
    const tmp = new Uint8Array(mask.length);
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!mask[y * w + x]) continue;
            const x1 = Math.min(w - 1, x + r);
            for (let k = Math.max(0, x - r); k <= x1; k++) tmp[y * w + k] = 1;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!tmp[y * w + x]) continue;
            const y1 = Math.min(h - 1, y + r);
            for (let k = Math.max(0, y - r); k <= y1; k++) out[k * w + x] = 1;
        }
    }
    return out;
}

// connected components (flood fill); returns boxes + centroids as 0-1 fractions of the video
function findBlobs(mask, w, h) {
    const seen = new Uint8Array(mask.length);
    const blobs = [];

    for (let start = 0; start < mask.length; start++) {
        if (!mask[start] || seen[start]) continue;

        const stack = [start];
        seen[start] = 1;
        let minX = w, minY = h, maxX = 0, maxY = 0, sumX = 0, sumY = 0, area = 0;

        while (stack.length) {
            const i = stack.pop();
            const x = i % w, y = (i / w) | 0;
            area++; sumX += x; sumY += y;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            const neighbours = [
                x > 0 ? i - 1 : -1,
                x < w - 1 ? i + 1 : -1,
                y > 0 ? i - w : -1,
                y < h - 1 ? i + w : -1
            ];
            for (const n of neighbours) {
                if (n >= 0 && mask[n] && !seen[n]) {
                    seen[n] = 1;
                    stack.push(n);
                }
            }
        }

        if (area < MIN_BLOB_AREA) continue;

        blobs.push({
            x: minX / w, y: minY / h,
            w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h,
            cx: sumX / area / w, cy: sumY / area / h,   // centroid, for the dots tomorrow
            area
        });
    }
    return blobs;
}

// cheap 3x3 box blur to suppress compression noise
function blur(src, w, h) {
    const out = new Float32Array(src.length);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            out[i] = (
                src[i - w - 1] + src[i - w] + src[i - w + 1] +
                src[i - 1]     + src[i]     + src[i + 1] +
                src[i + w - 1] + src[i + w] + src[i + w + 1]
            ) / 9;
        }
    }
    return out;
}

function boxesNear(a, b, gap) {
    return a.x - gap < b.x + b.w && b.x - gap < a.x + a.w &&
           a.y - gap < b.y + b.h && b.y - gap < a.y + a.h;
}

// grab the current frame, compare to the background, return motion blobs
function detectMotion() {
    const vw = videoPlayer.videoWidth, vh = videoPlayer.videoHeight;
    if (!vw || !vh) return [];

    const w = ANALYSIS_WIDTH;
    const h = Math.round(w * vh / vw);
    if (analysisCanvas.width !== w || analysisCanvas.height !== h) {
        analysisCanvas.width = w;
        analysisCanvas.height = h;
        resetMotion();
    }

    analysisCtx.drawImage(videoPlayer, 0, 0, w, h);
    const { data } = analysisCtx.getImageData(0, 0, w, h);

    let gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    gray = blur(gray, w, h);

    // remove whole-frame brightness shifts
    let sum = 0;
    for (let j = 0; j < gray.length; j++) sum += gray[j];
    const mean = sum / gray.length;
    for (let j = 0; j < gray.length; j++) gray[j] -= mean;

    if (!prevGray) { prevGray = gray; return []; }

    // running sum of the last MOTION_STEPS frame-to-frame differences
    if (!accum) accum = new Float32Array(w * h);
    const d = new Float32Array(w * h);
    for (let j = 0; j < d.length; j++) {
        d[j] = Math.abs(gray[j] - prevGray[j]);
        accum[j] += d[j];
    }
    diffs.push(d);
    if (diffs.length > MOTION_STEPS) {
        const old = diffs.shift();
        for (let j = 0; j < old.length; j++) accum[j] -= old[j];
    }
    prevGray = gray;
    if (diffs.length < MOTION_STEPS) return [];   // warming up

       // pixels must have moved over the last 0.6s AND be moving right now
    const prevD = diffs[diffs.length - 2];
    let mask = new Uint8Array(w * h);
    let changed = 0;
    for (let j = 0; j < accum.length; j++) {
        if (accum[j] > ENERGY_THRESHOLD && (d[j] + prevD[j]) > RECENT_THRESHOLD) {
            mask[j] = 1;
            changed++;
        }
    }

    // whole frame changed (flash / camera bump): discard and start over
    if (changed > MAX_CHANGED_FRACTION * w * h) {
        diffs = [];
        accum.fill(0);
        return [];
    }

    mask = dilate(mask, w, h, DILATE_RADIUS);
    return findBlobs(mask, w, h)
        .filter(b => b.area >= MIN_GROUP_AREA && b.w * b.h < MAX_BLOB_AREA);
}

// draw boxes, accounting for object-fit: contain letterboxing
function drawOverlay(blobs) {
    const boxW = overlay.clientWidth, boxH = overlay.clientHeight;
    if (overlay.width !== boxW) overlay.width = boxW;
    if (overlay.height !== boxH) overlay.height = boxH;
    overlayCtx.clearRect(0, 0, boxW, boxH);

    const vw = videoPlayer.videoWidth, vh = videoPlayer.videoHeight;
    if (!motionToggle.checked || !vw || !vh) return;

    const scale = Math.min(boxW / vw, boxH / vh);
    const dw = vw * scale, dh = vh * scale;
    const ox = (boxW - dw) / 2, oy = (boxH - dh) / 2;

    overlayCtx.strokeStyle = "#ECAF4B";   // your --amber
    overlayCtx.lineWidth = 2;
    for (const b of blobs) {
        overlayCtx.strokeRect(ox + b.x * dw, oy + b.y * dh, b.w * dw, b.h * dh);
    }
}

function motionLoop() {
    if (!motionRunning) return;

    if (motionToggle.checked && !videoPlayer.paused && !videoPlayer.ended) {
        const t = videoPlayer.currentTime;
        if (Math.abs(t - lastSampleTime) >= SAMPLE_INTERVAL) {
            lastSampleTime = t;
            updateTracks(detectMotion());   // heavy work, only ~10x per second
        }
        smoothTracks();                      // cheap, every frame
        lastBlobs = visibleTracks();
        drawOverlay(lastBlobs);
    }

    if (videoPlayer.requestVideoFrameCallback) {
        videoPlayer.requestVideoFrameCallback(motionLoop);
    } else {
        requestAnimationFrame(motionLoop);
    }
}

videoPlayer.addEventListener("play", function () {
    if (motionRunning) return;
    motionRunning = true;
    motionLoop();
});

// a seek or a new video makes the old background meaningless
videoPlayer.addEventListener("seeked", resetMotion);
videoPlayer.addEventListener("loadeddata", resetMotion);

motionToggle.addEventListener("change", function () {
    if (!motionToggle.checked) drawOverlay([]);
});
window.addEventListener("resize", function () { drawOverlay(lastBlobs); });

// match this sample's detections to existing tracks, create/expire tracks as needed
function updateTracks(blobs) {
    const unmatched = new Set(tracks);

    blobs.sort((a, b) => b.area - a.area);
    for (const b of blobs) {
        const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
        let best = null, bestD = MATCH_DIST;
        for (const t of unmatched) {
            const d = Math.hypot(bcx - (t.tx + t.tw / 2), bcy - (t.ty + t.th / 2));
            if (d < bestD) { best = t; bestD = d; }
        }
        if (best) {
            unmatched.delete(best);
            best.tx = b.x; best.ty = b.y; best.tw = b.w; best.th = b.h;
            best.hits++;
            best.misses = 0;
        } else {
            tracks.push({
                id: nextTrackId++,
                x: b.x, y: b.y, w: b.w, h: b.h,
                tx: b.x, ty: b.y, tw: b.w, th: b.h,
                cx: bcx, cy: bcy,
                hits: 1, misses: 0
            });
        }
    }

    for (const t of unmatched) t.misses++;
    tracks = tracks.filter(t => t.misses <= MAX_MISSES);
}

// runs every video frame: glide each box toward its target
function smoothTracks() {
    for (const t of tracks) {
        t.x += (t.tx - t.x) * SMOOTHING;
        t.y += (t.ty - t.y) * SMOOTHING;
        t.w += (t.tw - t.w) * SMOOTHING;
        t.h += (t.th - t.h) * SMOOTHING;
        t.cx = t.x + t.w / 2;
        t.cy = t.y + t.h / 2;
    }
}

function visibleTracks() {
    return tracks.filter(t => t.hits >= MIN_HITS);
}