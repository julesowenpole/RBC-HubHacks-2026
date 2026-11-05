const videoInput = document.getElementById("video-upload");
const videoPlayer = document.getElementById("video-player");
const videoPlaceholder = document.getElementById("video-placeholder");

const brightness = document.getElementById("brightness");
const contrast = document.getElementById("contrast");
const exposure = document.getElementById("exposure");

const brightnessValue = document.getElementById("brightness-value");
const contrastValue = document.getElementById("contrast-value");
const exposureValue = document.getElementById("exposure-value");

const resetButton = document.getElementById("reset-adjustments");

// brightness runs -100 to 100 (0 = no change)
// contrast and exposure run 0 to 200 (100 = no change)
const sliders = [brightness, contrast, exposure];
const DEFAULT_VALUE = 0;


function defaultFor(slider) {
    return slider ===  DEFAULT_VALUE;
}

let currentURL = null;

videoInput.addEventListener("change", function() {

    const file = this.files[0]; // note: assumption is that there is only ever one video uploaded - may need to change this later

    if (!file) {
        return;
    }

    // free the previous video from memory
    if (currentURL) {
        URL.revokeObjectURL(currentURL);
    }

    // change source of video player to be the uploaded video
    currentURL = URL.createObjectURL(file);
    videoPlayer.src = currentURL;

    // show the player and hide the "No video loaded" message
    videoPlayer.hidden = false;
    videoPlaceholder.hidden = true;
});

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

sliders.forEach(function(slider) {
    slider.addEventListener("input", applyFilters);

    // double-click a single slider to reset just that one
    slider.addEventListener("dblclick", function() {
        slider.value = defaultFor(slider);
        applyFilters();
    });
});

resetButton.addEventListener("click", function() {
    sliders.forEach(function(slider) {
        slider.value = defaultFor(slider);
    });
    applyFilters();
});

applyFilters();
