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

const ANALYSIS_WIDTH = 240;   // frames are downscaled to this width for speed
const DIFF_THRESHOLD = 18;    // 0-255, how much a pixel must change to count as motion
const MIN_BLOB_AREA = 12;     // in analysis pixels; raise this to ignore specks/noise
const BG_ALPHA = 0.05;        // how fast the background model adapts (0-1)

const analysisCanvas = document.createElement("canvas");
const analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });

let background = null;        // running-average grayscale background
let lastBlobs = [];
let motionRunning = false;

function resetMotion() {
    background = null;
    lastBlobs = [];
    drawOverlay([]);
}

// 3x3 dilation so fragments of one fish merge into a single blob
function dilate(mask, w, h) {
    const out = new Uint8Array(mask.length);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (mask[i] || mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) {
                out[i] = 1;
            }
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

// grab the current frame, compare to the background, return motion blobs
function detectMotion() {
    const vw = videoPlayer.videoWidth, vh = videoPlayer.videoHeight;
    if (!vw || !vh) return [];

    const w = ANALYSIS_WIDTH;
    const h = Math.round(w * vh / vw);
    if (analysisCanvas.width !== w || analysisCanvas.height !== h) {
        analysisCanvas.width = w;
        analysisCanvas.height = h;
        background = null;
    }

    // drawImage uses the raw frame, so your CSS brightness/contrast sliders don't affect detection
    analysisCtx.drawImage(videoPlayer, 0, 0, w, h);
    const { data } = analysisCtx.getImageData(0, 0, w, h);

    const gray = new Float32Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }

    if (!background) {
        background = gray;
        return [];
    }

    let mask = new Uint8Array(w * h);
    for (let j = 0; j < gray.length; j++) {
        if (Math.abs(gray[j] - background[j]) > DIFF_THRESHOLD) mask[j] = 1;
        background[j] += BG_ALPHA * (gray[j] - background[j]);
    }

    mask = dilate(mask, w, h);
    return findBlobs(mask, w, h);
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
        lastBlobs = detectMotion();
        drawOverlay(lastBlobs);
    }

    if (videoPlayer.requestVideoFrameCallback) {
        videoPlayer.requestVideoFrameCallback(motionLoop);   // once per real video frame
    } else {
        requestAnimationFrame(motionLoop);
    }
}

videoPlayer.addEventListener("play", function () {
    if (motionRunning) return;
    motionRunning = true;
    motionLoop();
});
videoPlayer.addEventListener("pause", function () { motionRunning = false; });
videoPlayer.addEventListener("ended", function () { motionRunning = false; });

// a seek or a new video makes the old background meaningless
videoPlayer.addEventListener("seeked", resetMotion);
videoPlayer.addEventListener("loadeddata", resetMotion);

motionToggle.addEventListener("change", function () {
    if (!motionToggle.checked) drawOverlay([]);
});
window.addEventListener("resize", function () { drawOverlay(lastBlobs); });