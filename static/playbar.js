// ---------- Player bar + motion timeline ----------
const player = document.getElementById("player");
const playerBar = document.getElementById("player-bar");
const playToggle = document.getElementById("play-toggle");
const prevMotion = document.getElementById("prev-motion");
const nextMotion = document.getElementById("next-motion");
const fullscreenToggle = document.getElementById("fullscreen-toggle");
const timeDisplay = document.getElementById("time-display");
const timeline = document.getElementById("timeline");
const timelineTrack = document.getElementById("timeline-track");
const motionLayer = document.getElementById("motion-layer");
const timelineProgress = document.getElementById("timeline-progress");
const playhead = document.getElementById("playhead");
const hoverTip = document.getElementById("hover-tip");
const timelineStatus = document.getElementById("timeline-status");

// Placeholder highlights for testing the bar without the backend.
// When false, the segments come from /process-video (pendingSegments in script.js).
const USE_DEMO_SEGMENTS = false;

let segments = [];      // [{ start, end }] in seconds, sorted, no overlaps
let activeIndex = -1;   // segment the playhead is currently inside
let dragging = false;

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ---- highlighted segments ----

// Public hook: the detection code will call this with [{ start, end }] in seconds.
function setMotionSegments(list) {
    const duration = videoPlayer.duration || 0;

    // clamp to the video, drop empty ranges, sort, and merge overlaps
    const cleaned = (list || [])
        .map(seg => ({
            start: Math.max(0, Math.min(seg.start, duration)),
            end: Math.max(0, Math.min(seg.end, duration))
        }))
        .filter(seg => seg.end > seg.start)
        .sort((a, b) => a.start - b.start);

    segments = [];
    cleaned.forEach(function(seg) {
        const last = segments[segments.length - 1];
        if (last && seg.start <= last.end) {
            last.end = Math.max(last.end, seg.end);
        } else {
            segments.push(seg);
        }
    });

    renderSegments();
    updateTimeline();
}

//Creates one <div> per segment, positioned as a percentage of the duration
function renderSegments() {
    const duration = videoPlayer.duration || 0;
    motionLayer.innerHTML = "";
    activeIndex = -1;
    if (!duration) return;

    segments.forEach(function(seg) {
        const el = document.createElement("div");
        el.className = "motion-seg";
        el.style.left = (seg.start / duration) * 100 + "%";
        el.style.width = ((seg.end - seg.start) / duration) * 100 + "%";
        motionLayer.appendChild(el);
    });
}

//Works out which segment the playhead is in and marks it active
function findSegmentIndex(time) {
    return segments.findIndex(seg => time >= seg.start && time <= seg.end);
}

//Status line: "In segment 2 of 4. 4 motion segments, 0:41 in total."
function updateStatus() {
    if (segments.length === 0) {
        timelineStatus.textContent = "No motion segments highlighted yet.";
        return;
    }
    const total = segments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    const summary = `${plural(segments.length, "motion segment")}, ${formatTime(total)} in total.`;
    timelineStatus.textContent = activeIndex >= 0
        ? `In segment ${activeIndex + 1} of ${segments.length}. ${summary}`
        : summary;
}

//Previous/next buttons jump to the start of the neighbouring segment
function jumpToMotion(direction) {
    const now = videoPlayer.currentTime;
    if (direction > 0) {
        const next = segments.find(seg => seg.start > now + 0.3);
        if (next) videoPlayer.currentTime = next.start;
    } else {
        const earlier = segments.filter(seg => seg.start < now - 1);
        if (earlier.length) videoPlayer.currentTime = earlier[earlier.length - 1].start;
    }
}

// ---- timeline drawing ----

function updateTimeline() {
    const duration = videoPlayer.duration || 0;
    const t = videoPlayer.currentTime || 0;
    const pct = duration ? (t / duration) * 100 : 0;

    timelineProgress.style.width = pct + "%";
    playhead.style.left = pct + "%";
    timeDisplay.textContent = `${formatTime(t)} / ${formatTime(duration)}`;

    timeline.setAttribute("aria-valuemax", Math.round(duration));
    timeline.setAttribute("aria-valuenow", Math.round(t));
    timeline.setAttribute("aria-valuetext", `${formatTime(t)} of ${formatTime(duration)}`);

    // highlight the segment under the playhead
    const index = findSegmentIndex(t);
    if (index !== activeIndex) {
        const els = motionLayer.children;
        if (els[activeIndex]) els[activeIndex].classList.remove("active");
        if (els[index]) els[index].classList.add("active");
        activeIndex = index;
        updateStatus();
    }
}

// ---- playback + scrubbing ----

function togglePlay() {
    if (videoPlayer.paused) {
        videoPlayer.play().catch(function() {});
    } else {
        videoPlayer.pause();
    }
}

function timeFromPointer(e) {
    const rect = timelineTrack.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    return (x / rect.width) * (videoPlayer.duration || 0);
}

function showTip(e) {
    const rect = timeline.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    hoverTip.style.left = x + "px";
    hoverTip.classList.add("show");
}

function seekBy(seconds) {
    const duration = videoPlayer.duration || 0;
    videoPlayer.currentTime = Math.min(Math.max(videoPlayer.currentTime + seconds, 0), duration);
}

timeline.addEventListener("pointerdown", function(e) {
    dragging = true;
    timeline.setPointerCapture(e.pointerId);
    videoPlayer.currentTime = timeFromPointer(e);
    updateTimeline();
});

timeline.addEventListener("pointermove", function(e) {
    if (dragging) {
        videoPlayer.currentTime = timeFromPointer(e);
        updateTimeline();
    }
});

timeline.addEventListener("pointerup", () => { dragging = false; });
timeline.addEventListener("pointercancel", () => { dragging = false; });

timeline.addEventListener("keydown", function(e) {
    const big = e.shiftKey ? 5 : 1;
    if (e.key === "ArrowRight") { seekBy(big); }
    else if (e.key === "ArrowLeft") { seekBy(-big); }
    else if (e.key === "Home") { videoPlayer.currentTime = 0; }
    else if (e.key === "End") { videoPlayer.currentTime = videoPlayer.duration || 0; }
    else if (e.key === " ") { togglePlay(); }
    else { return; }
    e.preventDefault();
});

playToggle.addEventListener("click", togglePlay);
videoPlayer.addEventListener("click", togglePlay);
prevMotion.addEventListener("click", () => jumpToMotion(-1));
nextMotion.addEventListener("click", () => jumpToMotion(1));

// ---- fullscreen (the wrapper goes fullscreen so the timeline stays visible) ----

function toggleFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else if (player.requestFullscreen) {
        player.requestFullscreen().catch(function(err) {
            console.error("Fullscreen failed:", err);
        });
    }
}

fullscreenToggle.addEventListener("click", toggleFullscreen);
videoPlayer.addEventListener("dblclick", toggleFullscreen);

document.addEventListener("fullscreenchange", function() {
    const on = document.fullscreenElement === player;
    fullscreenToggle.dataset.fullscreen = on ? "true" : "false";
    fullscreenToggle.setAttribute("aria-label", on ? "Exit fullscreen" : "Enter fullscreen");
});

document.addEventListener("keydown", function(e) {
    const tag = (e.target.tagName || "").toLowerCase();
    if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey
        && tag !== "input" && playerBar.dataset.ready === "true") {
        toggleFullscreen();
    }
});

// ---- video events ----

// keep the playhead smooth while playing
function tick() {
    updateTimeline();
    if (!videoPlayer.paused && !videoPlayer.ended) requestAnimationFrame(tick);
}

videoPlayer.addEventListener("play", function() {
    playToggle.dataset.playing = "true";
    playToggle.setAttribute("aria-label", "Pause");
    requestAnimationFrame(tick);
});

["pause", "ended"].forEach(function(name) {
    videoPlayer.addEventListener(name, function() {
        playToggle.dataset.playing = "false";
        playToggle.setAttribute("aria-label", "Play");
        updateTimeline();
    });
});

["timeupdate", "seeked"].forEach(function(name) {
    videoPlayer.addEventListener(name, updateTimeline);
});

// a new video is loading: disable the bar and clear old highlights
videoPlayer.addEventListener("loadstart", function() {
    playerBar.dataset.ready = "false";
    segments = [];
    renderSegments();
    timelineStatus.textContent = "Loading video…";
});

// metadata is ready: enable the bar and show highlights
videoPlayer.addEventListener("loadedmetadata", function() {
    const d = videoPlayer.duration;
    playerBar.dataset.ready = "true";

    // Just for testing: show some fake segments if the detection code isn't ready yet
    if (USE_DEMO_SEGMENTS) {
        setMotionSegments([
            { start: d * 0.10, end: d * 0.18 },
            { start: d * 0.32, end: d * 0.40 },
            { start: d * 0.55, end: d * 0.70 },
            { start: d * 0.82, end: d * 0.88 }
        ]);
    } else {
        // real detections: times where at least one confirmed fish is on screen
        setMotionSegments(pendingSegments);
    }
    updateTimeline();
    updateStatus();
});