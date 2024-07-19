#!/usr/bin/env python3

"""Performs preprocessing on images of text to improve OCR accuracy.

Raises:
    Exception: If the image cannot be read.

Returns:
    None: The processed image is saved to a new file.
"""

# Authors: P. Hughes <code@phugh.es> (https://phugh.es)
# SPDX-License-Identifier: MIT

import os
import sys
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from multiprocessing import freeze_support

import cv2
import numpy as np


def enthicken(img: np.ndarray) -> np.ndarray:
    """
    Blur the image for segmentation.
    """
    kernel = np.ones((7, 7), np.uint8)
    edges = cv2.Canny(img, 0, 175, apertureSize=3)
    dilated = cv2.dilate(edges, kernel, iterations=1)
    dilated = cv2.morphologyEx(dilated, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    dilated = cv2.GaussianBlur(dilated, (19, 233), 0)
    dilated = cv2.threshold(dilated, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    return dilated


def segment_image(img):
    """
    Outline the main text area in the image.
    The input is a grayscale image in portrait orientation.
    """
    padding = 10

    # Find contours
    dilated = enthicken(img)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return img

    # Find the largest contour by area
    largest_contour = sorted(contours, key=cv2.contourArea)[-1]
    if largest_contour is None:
        return img

    # Get bounding rectangle of the largest contour
    x, y, w, h = cv2.boundingRect(largest_contour)

    # Draw the rectangle
    x, y, w, h = map(int, (x, y, w, h))
    result = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    cv2.rectangle(
        result,
        (x, padding * 3),
        (x + w, img.shape[0] - (padding * 3)),
        (0, 0, 255),
        3,
    )

    # for debugging:
    # cv2.drawContours(result, [largest_contour], 0, (0, 0, 255), 3)

    return result


def crop(image: np.ndarray) -> np.ndarray:
    """
    Crop the bottom 250px of the image to remove the watermark and reduce filesize.
    This step helps with deskewing also, because the watermark is a different orientation to the page.
    The input is a grayscale image in portrait orientation.
    """
    padding = 10
    return image[:-250, (padding * 2) : -(padding * 2)]


def cover_watermark_remnants(image: np.ndarray) -> np.ndarray:
    """
    Draw a small white rectangle on the lower left of the image to erase the remaining watermark remnants
    """
    return cv2.rectangle(image, (0, 4375), (300, 4433), (255), -1)


def normalize(image: np.ndarray) -> np.ndarray:
    """
    Normalize the image to the range 0-255
    The input is a grayscale image in portrait orientation.
    """
    return cv2.normalize(image, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX)  # type: ignore


def binarize(image: np.ndarray) -> np.ndarray:
    """
    Binarize the image using Otsu's method
    Bluring is applied to reduce noise and improve the thresholding.
    The input is a grayscale image in portrait orientation.
    """
    image = cv2.GaussianBlur(image, (5, 5), 0)
    image = cv2.adaptiveThreshold(
        image, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2
    )
    return image


def fix_font(image: np.ndarray) -> np.ndarray:
    """
    Fix the font to improve OCR accuracy.
    The input is a binarized image in portrait orientation.
    """
    image = cv2.bitwise_not(image)
    kernel = np.ones((3, 3), np.uint8)
    image = cv2.erode(image, kernel, iterations=1)
    image = cv2.dilate(image, kernel, iterations=1)
    image = cv2.morphologyEx(image, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    image = cv2.bitwise_not(image)
    return image


def denoise(image: np.ndarray) -> np.ndarray:
    """
    Denoise the image to improve OCR accuracy.
    """
    image = cv2.medianBlur(image, 5)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    image = cv2.morphologyEx(image, cv2.MORPH_CLOSE, kernel, iterations=1)
    return image


def resize(image: np.ndarray, new_height: int = 1568) -> np.ndarray:
    """
    Resize the image to a height of 1568px while maintaining the aspect ratio.
    Lanczos interpolation is used to preserve text quality.
    """
    height = image.shape[0]
    width = image.shape[1]
    new_width = int(width * (new_height / float(height)))
    return cv2.resize(image, (new_width, new_height), interpolation=cv2.INTER_LANCZOS4)


def process_image(image: np.ndarray) -> np.ndarray:
    """
    Process an image of text to improve OCR accuracy.
    """
    if len(image.shape) == 3:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    image = crop(image)
    image = normalize(image)
    image = binarize(image)
    image = denoise(image)
    image = cover_watermark_remnants(image)
    image = fix_font(image)
    image = segment_image(image)
    image = resize(image)

    return image


def process_single_image(input_path: str) -> str:
    """
    Process a single image and save the result to a new file.
    """
    try:
        print(f"Processing {input_path}")
        image = cv2.imread(input_path.strip(), cv2.IMREAD_GRAYSCALE)
        if image is None:
            raise Exception(f"Could not read image: {input_path}")
        processed_image = process_image(image)
        output_path = os.path.splitext(input_path)[0] + "_preprocessed.png"
        cv2.imwrite(output_path, processed_image)
        return f"Created {output_path}"
    except Exception as e:
        return f"Error processing {input_path}: {str(e)}\n{traceback.format_exc()}"


def process_multiple_images(input_paths: list, batch_size: int = 4) -> None:
    """
    Process multiple images concurrently using a process pool, with batching.
    """
    with ProcessPoolExecutor(max_workers=batch_size) as executor:
        futures = []
        for input_path in input_paths:
            future = executor.submit(process_single_image, input_path)
            futures.append(future)

        for future in as_completed(futures):
            print(future.result())
            pass


def is_png(filename):
    return filename.lower().endswith(".png")


def get_png_files(path):
    if os.path.isdir(path):
        return [os.path.join(path, f) for f in os.listdir(path) if is_png(f)]
    elif is_png(path):
        return [path]
    else:
        return []


if __name__ == "__main__":
    freeze_support()

    if len(sys.argv) < 2:
        print(
            "No image or directory provided. Usage: python preprocess.py <images_and_or_directories>"
        )
    else:
        input_paths = []
        for arg in sys.argv[1:]:
            input_paths.extend(get_png_files(arg))

        if not input_paths:
            print("No PNG files found in the provided arguments.")
        else:
            print(f"Processing {len(input_paths)} PNG files:")
            process_multiple_images(input_paths)
            input("Press Enter to continue...")
