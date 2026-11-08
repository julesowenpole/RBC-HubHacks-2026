const fishInput = document.getElementById("fish-input");
const addFishBtn = document.getElementById("add-fish-btn");
const fishList = document.getElementById("observed-fish");
const fishEmpty = document.getElementById("fish-empty");
const exportFishBtn = document.getElementById("export-fish-btn");
const currentTimeLabel = document.getElementById("current-time");

const fishData = {};

// if index.html and this file ever get out of step, say exactly which element is missing instead of failing silently
const missingElements = ["fish-input", "add-fish-btn", "observed-fish", "fish-empty", "export-fish-btn", "current-time"]
    .filter((id) => !document.getElementById(id));
if (missingElements.length) {
    console.error("add-fish.js: these ids are missing from index.html:", missingElements.join(", "));
}

addFishBtn.addEventListener("click", addFish);

// pressing Enter in the name box adds the fish too
fishInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        addFish();
    }
});

exportFishBtn?.addEventListener("click", exportFishData);

// keep the "logged at" time in the panel in step with the video (videoPlayer comes from script.js)
videoPlayer.addEventListener("timeupdate", updateCurrentTimeLabel);
videoPlayer.addEventListener("seeked", updateCurrentTimeLabel);
videoPlayer.addEventListener("loadedmetadata", updateCurrentTimeLabel);

// turns a time in seconds into m:ss for display
function formatTime(seconds) {
    const total = Math.floor(seconds || 0);
    const mins = Math.floor(total / 60);
    const secs = String(total % 60).padStart(2, "0");
    return `${mins}:${secs}`;
}

function updateCurrentTimeLabel() {
    if (currentTimeLabel) {
        currentTimeLabel.textContent = formatTime(videoPlayer.currentTime);
    }
}

// finds the list item for a fish (data attribute used instead of an id so odd names can't clash with other ids)
function findFishElement(fishName) {
    return Array.from(fishList.children).find((li) => li.dataset.fish === fishName);
}

// adds a fish to the list of fish that can be exported. If the fish has already been added, its count goes up by one and the current time is logged.
function addFish() {
    const fishName = fishInput.value.trim().toLowerCase();

    if (!fishName) return;

    if (fishData[fishName]) {
        fishData[fishName].count++;
        addTimeStamp(fishName);

        updateFishDisplay(fishName);
    } else {
        fishData[fishName] = {
            count: 1,
            timestamps: []
        };
        addTimeStamp(fishName);
        createFishElement(fishName);
    }

    fishInput.value = "";
    fishInput.focus();

    console.log(fishData);
}

// function to add a fish element to the list of fish in the html template and update its count to 1 (since if the fish is being added, its been seen at least once). For each fish, its count is displayed as well as buttons to add/subtract from the count, or delete the fish entirely.
function createFishElement(fishName) {
    const li = document.createElement("li");
    li.className = "fish-item";
    li.dataset.fish = fishName;

    li.innerHTML = `
        <div class="fish-info">
            <span class="fish-name"></span>
            <span class="fish-seen"></span>
        </div>

        <div class="stepper">
            <button type="button" class="decrement-btn" aria-label="Remove one sighting">&minus;</button>
            <span class="fish-count">1</span>
            <button type="button" class="increment-btn" aria-label="Add one sighting">+</button>
        </div>

        <button type="button" class="remove-btn" aria-label="Remove fish" title="Remove fish">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>
        </button>
    `;

    // set as text (not html) so the typed name can never be treated as markup
    li.querySelector(".fish-name").textContent = fishName;

    // button to increment the number of fish
    li.querySelector(".increment-btn").addEventListener("click", () => {
        fishData[fishName].count++;
        addTimeStamp(fishName);
        updateFishDisplay(fishName);
    });

    // button to decrement the number of fish
    li.querySelector(".decrement-btn").addEventListener("click", () => {
        if (fishData[fishName].count > 0) {
            fishData[fishName].count--;
            fishData[fishName].timestamps.pop();
            updateFishDisplay(fishName);
        } else {
            alert("Negative count not allowed. Please use the delete button to remove this fish.");
        }
    });

    // button to remove a fish
    li.querySelector(".remove-btn").addEventListener("click", () => {
        delete fishData[fishName];
        li.remove();
        updateSummary();
    });

    fishList.appendChild(li);
    updateFishDisplay(fishName);
}

// function to update the count displayed on each fish. called each time the count is changed.
function updateFishDisplay(fishName) {
    const li = findFishElement(fishName);

    if (li) {
        const data = fishData[fishName];
        const lastSeen = data.timestamps[data.timestamps.length - 1];

        li.querySelector(".fish-count").textContent = `${data.count}`;
        li.querySelector(".fish-seen").textContent =
            lastSeen === undefined ? "No sightings" : `Last logged at ${formatTime(lastSeen)}`;
    }

    updateSummary();
}

// function to update the empty message and the export button
function updateSummary() {
    const names = Object.keys(fishData);
    if (fishEmpty) {
        fishEmpty.hidden = names.length > 0;
    }
    if (exportFishBtn) {
        exportFishBtn.disabled = names.length === 0;
    }
}

// function to add the current timestamp whenever a fish is sighted
function addTimeStamp(fishName){
    // timestamp is stored in videoPlayer.currentTime
    fishData[fishName].timestamps.push(videoPlayer.currentTime);
}

// function to export fish data by calling the flask endpoint
async function exportFishData() {

    let response;
    try {
        response = await fetch("/export-fish", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(fishData)
        });
    } catch (err) {
        // the server could not be reached at all
        console.error("Export failed:", err);
        alert("Could not reach the server to export fish data. Is the Flask app running?");
        return;
    }

    if (!response.ok) {
        // the status tells you what went wrong: 404 = no /export-fish route, 500 = error in the Flask code
        console.error("Export failed with status", response.status);
        alert(`Error exporting fish data (server returned ${response.status}).`);
        return;
    }

    const blob = await response.blob();

    const url = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "fish_sightings.xlsx";

    document.body.appendChild(a);
    a.click();

    a.remove();
    window.URL.revokeObjectURL(url);
}

updateSummary();
