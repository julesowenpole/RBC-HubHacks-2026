const fishInput = document.getElementById("fish-input");
const addFishBtn = document.getElementById("add-fish-btn");
const fishList = document.getElementById("fish-list");
const exportFishBtn = document.getElementById("export-fish-btn");

const fishData = {};

addFishBtn.addEventListener("click", addFish);

exportFishBtn.addEventListener("click", exportFishData);

// adds a fish to the list of fish that can be exported. If the fish has already been added, nothing happens. 
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

    console.log(fishData);
}

// function to add a fish element to the list of fish in the html template and update its count to 1 (since if the fish is being added, its been seen at least once). For each fish, its count is displayed as well as buttons to add/subtract from the count, or delete the fish entirely. 
function createFishElement(fishName) {
    const li = document.createElement("li");
    li.id = `${fishName}`;

    li.innerHTML = `
        <span class="fish-name">${fishName}</span>

        <button class="decrement-btn">-</button>
        <span class="fish-count">1</span>
        <button class="increment-btn">+</button>        

        <button class="remove-btn">Remove</button>
    `; 

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
    });

    fishList.appendChild(li);
}

// function to update the count displayed on each fish. called each time the count is changed. 
function updateFishDisplay(fishName) {
    const li = document.getElementById(`${fishName}`);

    if (li) {
        li.querySelector(
            ".fish-count"
        ).textContent = `${fishData[fishName].count}`;
    }
}

// function to add the current timestamp whenever a fish is sighted
function addTimeStamp(fishName){
    // timestamp is stored in videoPlayer.currentTime
    fishData[fishName].timestamps.push(videoPlayer.currentTime);
}

// function to export fish data by calling the flask endpoint
async function exportFishData() {

    const response = await fetch("/export-fish", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(fishData)
    });

    if (!response.ok) {
        alert("Error exporting fish data.");
        return;
    }

    const blob = await response.blob();

    const url = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "fish_data.xlsx";

    document.body.appendChild(a);
    a.click();

    a.remove();
    window.URL.revokeObjectURL(url);
}