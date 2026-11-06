import cv2
from flask import Flask, send_file

def processVideo(INPUT_VIDEO, OUTPUT_VIDEO):
    videoCap = cv2.VideoCapture(INPUT_VIDEO)

    if not videoCap.isOpened():
        raise FileNotFoundError(f"Could not open {INPUT_VIDEO}")

    # Get video properties
    width = int(videoCap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(videoCap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = videoCap.get(cv2.CAP_PROP_FPS)

    # Create output video writer
    fourcc = cv2.VideoWriter_fourcc(*'avc1')

    writer = cv2.VideoWriter(
        OUTPUT_VIDEO,
        fourcc,
        fps,
        (width, height)
    )

    # Create CLAHE object
    clahe = cv2.createCLAHE(clipLimit=5.0, tileGridSize=(8, 8))

    while True:

        ret, frame = videoCap.read()

        if not ret: # verifying that there was no error
            break

        # convert bgr to hsv - using hsv channels for brightness purposes
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        h, s, v = cv2.split(hsv)

        # apply clahe to brightness channel
        v_clahe = clahe.apply(v)

        # merge channels back together and convert to correct color
        hsv_clahe = cv2.merge((h, s, v_clahe))
        result = cv2.cvtColor(hsv_clahe, cv2.COLOR_HSV2BGR)

        # display video and add frame to result - don't need to display video in the final version
        cv2.imshow("CLAHE Video", result)
        writer.write(result)

        # quit shortcut for testing purposes
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    # cleanup
    videoCap.release()
    writer.release()
    cv2.destroyAllWindows()

    print(f"Saved enhanced video to {OUTPUT_VIDEO}")

INPUT_PATH = "test-media/turkey_water.mp4"
OUTPUT_PATH = "output_clahe.mp4"
processVideo(INPUT_PATH, OUTPUT_PATH)