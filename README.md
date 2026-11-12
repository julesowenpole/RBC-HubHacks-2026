# FishEye: A Fish Vision Software

## Description

Counts fish in an uploaded video and applies filters to make them easier to see by a human. 

## Setup instructions

### Developers

The program runs as a Flask app and requires the installation of Python 3.0 or higher. Once Python is installed, run 

`python app.py`

to start the app. You can then open the app in a browser using the indicated link. 

To build the app yourself and run it locally as an executable, navigate to this directory and use the following command for Powershell: 

```python -m PyInstaller --onedir --collect-all torchvision --collect-all ultralytics --add-data "yolo.pt;." --add-data "templates;templates" --add-data "static;static" FishEye.py```

The full source for the app can be found in dist/FishEye/_internal. 

### End users

We are currently troubleshooting installation issues on machines where Python 3 is not installed. Until the root cause of these issues is sorted out, please follow the instructions [here](https://www.python.org/downloads/) to download and set up Python 3. 

Once Python 3 is installed, you will be able to use the app by following these instructions: 
1. Navigate to [this file](https://github.com/julesowenpole/RBC-HubHacks-2026/blob/main/dist/FishEye.zip).
2. Click the download button in the upper right corner of the file. 
3. Unzip the folder once it has been downloaded. 
4. Go inside the folder until you see FishEye.exe. Double click this file and it should start running on your device. 

## Usage

This software is targeted towards aquatic researchers who can watch the video one time to review its output. Our software speeds up the enumeration process for a field technician. The intended usage is for a human to be watching the video to verify our program's findings. 

## Attributions

Test video source: https://www.coastalaction.org/coastal-action-atlantic-whitefish-project.html. An Atlantic whitefish in the rotary screw trap holding box (December 2018). The first live adult Atlantic whitefish observed in the wild since 2014.

This project was created for Coastal Action as part of the RBC HubHacks program in November 2026. To learn more, please visit the following resources: 
- [Coastal Action](https://www.coastalaction.org/)
- [RBC HubHacks](https://rbchubhacks.com/)

### Contributors

Members of Team Uboontu: 
- @emmasnow404
- @julesowenpole
- @kbussey829
- @sarahmay33

## Contributing

This project is for the RBC HubHacks program, held in November 2026. Pull requests will not be accepted outside of the members above, and will not be accepted at all after November 8th, 2026. This is subject to change if team Uboontu decides to return to the project after the hackathon period has concluded. 