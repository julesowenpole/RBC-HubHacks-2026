const videoInput = document.getElementById("video-upload");
const videoPlayer = document.getElementById("video-player");

videoInput.addEventListener("change", function() {
    
    const file = this.files[0]; // note: assumption is that there is only ever one video uploaded - may need to change this later

    if (!file) {
        return;
    }

    // change source of video player to be the uploaded video
    const videoURL = URL.createObjectURL(file);
    videoPlayer.src = videoURL;
});