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

// event listeners for video upload
uploadButton.addEventListener("click", () => videoInput.click());

// functionality for video processing endpoint
videoInput.addEventListener("change", async (event) => {
    let bar = document.getElementById("player-bar");
    bar.style.display = 'none';
    const file = event.target.files[0];
    const formData = new FormData();
    formData.append("video", file);
    videoPlayer.poster = "../static/loading-bar.png";

    const response = await fetch("/process-video", {
        method: "POST",
        body: formData
    });

    const data = await response.json();
    // will only proceed beyond this point when the video has finished processing

    document.getElementById("fish-count").textContent = data.fish_count;
    document.getElementById("info-text").textContent = "Fish are boxed in the video.";

    bar.style.display = 'block';
    console.log(data.video_url); // confirmation of specified video url
    videoPlayer.poster = ""

    // change source of the video and get the page ready to play it
    videoPlayer.src = data.video_url + "?t=" + Date.now();
    videoPlayer.hidden = false;
    videoPlaceholder.hidden = true;

    sliders.forEach(function(slider) {
        slider.value = defaultFor(slider);
    });
    applyFilters();

    // this is for indexedDB purposes
    try {
        await saveVideo(file);
    } catch (err) {
        console.error("Could not save video:", err);
    }

    this.value = ""; // allows re-selecting the same file
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
