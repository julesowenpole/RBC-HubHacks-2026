# source: https://www.geeksforgeeks.org/python/clahe-histogram-eqalization-opencv/

import cv2
import numpy as np

def display_image(title, image):
    try:
        from google.colab.patches import cv2_imshow
        cv2_imshow(image)
    except ImportError:
        cv2.imshow(title, image)
        cv2.waitKey(0)
        cv2.destroyAllWindows()

# upload image and create image object
image_path = "test-image.jpeg"
image = cv2.imread(image_path)
image_bw = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
clahe = cv2.createCLAHE(clipLimit=5)

# apply contrast
BRIGHTNESS = 1
clahe_img = np.clip(clahe.apply(image_bw) + BRIGHTNESS, 0, 255).astype(np.uint8)

# display final image
display_image("result", clahe_img)