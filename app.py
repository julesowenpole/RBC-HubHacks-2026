import os
from collections import Counter

import cv2
from flask import Flask, render_template, request, jsonify
from ultralytics import YOLO

import detect_api

app = Flask(__name__)
OUTPUT_PATH = "static/output_clahe.mp4"

# ---------- fish detection settings ----------
# NOTE: stock COCO weights have no "fish" class - use fish-trained weights.
MODEL_PATH = "yolo.pt"
CONF = 0.20          # lower = more detections, more false positives
IOU = 0.5
IMGSZ = 960          # larger helps with small/distant fish (slower)
TRACKER = "bytetrack.yaml"
MIN_HITS = 5         # frames a track must exist before it is drawn/counted
BOX_COLOUR = (75, 175, 236)   # BGR of --amber (#ECAF4B)
BOX_THICKNESS = 2

model = YOLO(MODEL_PATH)

detect_api.init(model, tracker=TRACKER, conf=CONF, iou=IOU, imgsz=IMGSZ)
app.register_blueprint(detect_api.bp)

def drawBox(frame, x1, y1, x2, y2, label):
    cv2.rectangle(frame, (x1, y1), (x2, y2), BOX_COLOUR, BOX_THICKNESS)
    (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
    cv2.rectangle(frame, (x1, y1 - th - 8), (x1 + tw + 6, y1), BOX_COLOUR, -1)
    cv2.putText(frame, label, (x1 + 3, y1 - 5),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (26, 54, 68), 1, cv2.LINE_AA)


def processVideo(input_video, output_video):
    videoCap = cv2.VideoCapture(input_video)

    if not videoCap.isOpened():
        raise FileNotFoundError(f"Could not open {input_video}")

    # Get video properties
    width = int(videoCap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(videoCap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = videoCap.get(cv2.CAP_PROP_FPS)

    # Create output video writer
    fourcc = cv2.VideoWriter_fourcc(*'avc1')

    writer = cv2.VideoWriter(
        output_video,
        fourcc,
        fps,
        (width, height)
    )

    # Create CLAHE object
    clahe = cv2.createCLAHE(clipLimit=5.0, tileGridSize=(8, 8))

    # reset tracker state so IDs/counts don't carry over from the last upload
    model.predictor = None
    hits = Counter()  # track id -> number of frames seen

    while True:

        ret, frame = videoCap.read()

        if not ret:  # verifying that there was no error
            break

        # convert bgr to hsv - using hsv channels for brightness purposes
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        h, s, v = cv2.split(hsv)

        # apply clahe to brightness channel
        v_clahe = clahe.apply(v)

        # merge channels back together and convert to correct color
        hsv_clahe = cv2.merge((h, s, v_clahe))
        result = cv2.cvtColor(hsv_clahe, cv2.COLOR_HSV2BGR)

        # detect + track fish on the enhanced frame
        detections = model.track(result, persist=True, tracker=TRACKER,
                                 conf=CONF, iou=IOU, imgsz=IMGSZ,
                                 verbose=False)[0]

        boxes = detections.boxes
        if boxes is not None and boxes.id is not None:
            xyxy = boxes.xyxy.cpu().numpy().astype(int)
            ids = boxes.id.cpu().numpy().astype(int)
            for (x1, y1, x2, y2), tid in zip(xyxy, ids):
                hits[tid] += 1
                if hits[tid] >= MIN_HITS:  # hides one-frame flickers
                    drawBox(result, x1, y1, x2, y2, f"fish {tid}")

        # add the tagged frame to the output video
        writer.write(result)

    # cleanup
    videoCap.release()
    writer.release()

    fish_count = sum(1 for n in hits.values() if n >= MIN_HITS)
    print(f"Saved enhanced video to {output_video} ({fish_count} fish)")
    return fish_count


# homepage (visible to the user)
@app.route("/")
def home():
    return render_template("index.html")


# this is the endpoint that handles video send and receive (not visible to the user)
@app.route("/process-video", methods=["POST"])
def process():
    file = request.files["video"]
    os.makedirs("uploads", exist_ok=True)
    input_path = "uploads/input.mp4"
    file.save(input_path)

    fish_count = processVideo(input_path, OUTPUT_PATH)

    return jsonify({
        "video_url": OUTPUT_PATH,
        "fish_count": fish_count
    })


if __name__ == "__main__":
    app.run(debug=True)