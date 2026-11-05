const videoInput = document.getElementById("video-upload");
const videoPlayer = document.getElementById("video-player");

const brightness = document.getElementById("brightness");
const contrast = document.getElementById("contrast");
const brightnessValue = document.getElementById("brightness-value");
const contrastValue = document.getElementById("contrast-value");
const resetButton = document.getElementById("reset-adjustments");

videoInput.addEventListener("change", function() {
    
    const file = this.files[0]; // note: assumption is that there is only ever one video uploaded - may need to change this later

    if (!file) {
        return;
    }

    // change source of video player to be the uploaded video
    const videoURL = URL.createObjectURL(file);
    videoPlayer.src = videoURL;
});

// apply the slider values as CSS filters on the video
function applyFilters() {
    videoPlayer.style.filter = `brightness(${brightness.value}%) contrast(${contrast.value}%)`;
    brightnessValue.textContent = brightness.value;
    contrastValue.textContent = contrast.value;
}

brightness.addEventListener("input", applyFilters);
contrast.addEventListener("input", applyFilters);

resetButton.addEventListener("click", function() {
    brightness.value = 100;
    contrast.value = 100;
    applyFilters();
});