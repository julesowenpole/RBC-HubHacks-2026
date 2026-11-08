// constants for video upload and play functionality
const videoInput = document.getElementById("video-upload");
const videoPlayer = document.getElementById("video-player");
const videoPlaceholder = document.getElementById("video-placeholder");
const uploadButton = document.getElementById("upload-btn");

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

//constants for frame overlay
const vid = videoPlayer;
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
let overlayData = null;

// constant for video download button
const exportVidBtn = document.getElementById("download-video-btn");

function defaultFor(slider) {
    return DEFAULT_VALUE;
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

// fish segments from the last analysis, [{ start, end }] in seconds.
// playbar.js draws these when the video's metadata has loaded.
let pendingSegments = [];
const SEGMENTS_KEY = "fisheye-segments";

function rememberSegments(list) {
    pendingSegments = list || [];
    try {
        localStorage.setItem(SEGMENTS_KEY, JSON.stringify(pendingSegments));
    } catch (err) { /* storage blocked: segments just won't survive a reload */ }
}

function recallSegments() {
    try {
        return JSON.parse(localStorage.getItem(SEGMENTS_KEY)) || [];
    } catch (err) {
        return [];
    }
}

function showVideo(file) {
    // free the previous object URL so memory is not leaked
    if (currentURL) {
        URL.revokeObjectURL(currentURL);
    }
    currentURL = URL.createObjectURL(file);
    videoPlayer.src = currentURL;

    // show the player and hide the "No video loaded" message
    videoPlayer.hidden = false;
}

// event listeners for video upload
uploadButton.addEventListener("click", () => videoInput.click());

// functionality for video processing endpoint
videoInput.addEventListener("change", async (event) => {
    let bar = document.getElementById("player-bar");
    bar.style.display = 'none';
    const file = event.target.files[0];
    const formData = new FormData();
    formData.append("video", file);
    videoPlayer.poster = "../static/images/loading-bar.png";

    const response = await fetch("/process-video", {
        method: "POST",
        body: formData
    });

    const data = await response.json();
    overlayData = data;
    console.log("frames with boxes:", data.detections.filter(d => d.length).length,
            "fps:", data.fps, "size:", data.width, data.height);
    // will only proceed beyond this point when the video has finished processing

    document.getElementById("fish-count").textContent = data.fish_count;
    document.getElementById("info-text").textContent = "Fish are boxed in the video.";

    // must be set before the new src loads, so loadedmetadata can draw them
    rememberSegments(data.segments);

    bar.style.display = 'block';
    exportVidBtn.disabled = false;
    console.log(data.video_url); // confirmation of specified video url
    videoPlayer.poster = ""

    // change source of the video and get the page ready to play it
    videoPlayer.src = data.video_url + "?t=" + Date.now();
    videoPlayer.hidden = false;

    sliders.forEach(function(slider) {
        slider.value = defaultFor(slider);
    });
    applyFilters();

    // for indexedDB purposes
    try {
        await saveVideo(file);
    } catch (err) {
        console.error("Could not save video:", err);
    }

    event.target.value = ""; // allows re-selecting the same file
});

function loop() {
  draw();
  if (vid.paused || vid.ended) return;
  if ("requestVideoFrameCallback" in vid) vid.requestVideoFrameCallback(loop);
  else requestAnimationFrame(loop);
}

vid.addEventListener("play", loop);
vid.addEventListener("seeked", draw);
vid.addEventListener("pause", draw);
vid.addEventListener("loadedmetadata", draw);
window.addEventListener("resize", draw);
document.addEventListener("fullscreenchange", draw);

function draw() {
  if (!overlayData) return;

  // match the canvas to the displayed video size
  canvas.width = vid.clientWidth;
  canvas.height = vid.clientHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // work out which frame is on screen and get its boxes
  const frame = Math.floor(vid.currentTime * overlayData.fps);
  const boxes = overlayData.detections[frame] || [];

  // object-fit: contain letterboxes the video, so scale uniformly and offset
  const vw = overlayData.width, vh = overlayData.height;
  const scale = Math.min(canvas.width / vw, canvas.height / vh);
  const offX = (canvas.width  - vw * scale) / 2;
  const offY = (canvas.height - vh * scale) / 2;

  ctx.strokeStyle = "#ECAF4B";
  ctx.lineWidth = 2;
  ctx.font = "12px sans-serif";

  for (const b of boxes) {
    const x = offX + b.x1 * scale;
    const y = offY + b.y1 * scale;
    const w = (b.x2 - b.x1) * scale;
    const h = (b.y2 - b.y1) * scale;

    // the box
    ctx.strokeRect(x, y, w, h);

    // the label tag above it
    const label = `fish ${b.id}`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "#ECAF4B";
    ctx.fillRect(x, y - 16, tw + 8, 16);
    ctx.fillStyle = "#443618";
    ctx.fillText(label, x + 4, y - 4);
  }
}

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

// listener for the save video button: asks Flask for the processed video with the current slider values applied
exportVidBtn.addEventListener("click", async function() {
    const label = exportVidBtn.textContent;
    exportVidBtn.disabled = true;
    exportVidBtn.textContent = "Preparing video...";   // the server re-renders the video, which can take a moment

    try {
        const params = new URLSearchParams({
            brightness: brightness.value,
            contrast: contrast.value,
            exposure: exposure.value
        });

        const response = await fetch("/download-video?" + params);

        if (!response.ok) {
            throw new Error(`server returned ${response.status}`);
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = "processed_video.mp4";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error("Could not download video:", err);
        alert("Could not download the video (" + err.message + ").");
    } finally {
        exportVidBtn.disabled = false;
        exportVidBtn.textContent = label;
    }
});

applyFilters();
