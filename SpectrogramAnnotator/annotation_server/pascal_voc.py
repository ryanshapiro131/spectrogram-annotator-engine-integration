"""
Pascal VOC XML read/write for the image annotator, ported from labelImg
(https://github.com/HumanSignal/labelImg — libs/pascal_voc_io.py and
libs/labelFile.py), so files round-trip with labelImg and the tools that
read its output.

What's kept from labelImg, on purpose:
  * Tag set and order: <annotation [verified="yes"]> folder, filename,
    [path], source/database, size/width,height,depth, segmented, then one
    <object> per box: name, pose, truncated, difficult, bndbox.
  * Box coordinates are whole pixels: int() of the min/max corners, with
    xmin/ymin raised to at least 1 (labelImg does this because 0-valued
    coordinates broke Faster R-CNN training; VOC is 1-based).
  * truncated = "1" when the box touches the image edge, using labelImg's
    test (ymax == height or ymin == 1, else xmax == width or xmin == 1).
  * The reader turns each <object> into a box with int(float()) coords;
    a missing <difficult> means False.

What differs:
  * Boxes come in as {label, xmin, ymin, xmax, ymax, difficult} dicts in
    image pixels rather than Qt shapes.
  * The reader raises VocError on malformed XML instead of silently
    returning nothing, so the API can say what's wrong.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from xml.dom import minidom

XML_EXT = ".xml"
ENCODING = "utf-8"


class VocError(ValueError):
    pass


def bnd_box(box: dict) -> tuple[int, int, int, int]:
    """labelFile.convert_points_to_bnd_box: whole pixels, min corner >= 1."""
    x_min = min(float(box["xmin"]), float(box["xmax"]))
    x_max = max(float(box["xmin"]), float(box["xmax"]))
    y_min = min(float(box["ymin"]), float(box["ymax"]))
    y_max = max(float(box["ymin"]), float(box["ymax"]))
    if x_min < 1:
        x_min = 1
    if y_min < 1:
        y_min = 1
    return int(x_min), int(y_min), int(x_max), int(y_max)


def _truncated(x_min: int, y_min: int, x_max: int, y_max: int, width: int, height: int) -> str:
    if int(y_max) == int(height) or int(y_min) == 1:
        return "1"
    if int(x_max) == int(width) or int(x_min) == 1:
        return "1"
    return "0"


def write_voc(
    *,
    filename: str,
    width: int,
    height: int,
    depth: int | None = 3,
    boxes: list[dict],
    folder: str = "images",
    path: str | None = None,
    database: str = "Unknown",
    verified: bool = False,
) -> bytes:
    """One image's annotation as Pascal VOC XML (bytes, UTF-8, pretty-printed)."""
    if not filename or not width or not height:
        raise VocError("filename, width and height are required.")

    top = ET.Element("annotation")
    if verified:
        top.set("verified", "yes")
    ET.SubElement(top, "folder").text = folder
    ET.SubElement(top, "filename").text = filename
    if path is not None:
        ET.SubElement(top, "path").text = path
    source = ET.SubElement(top, "source")
    ET.SubElement(source, "database").text = database
    size = ET.SubElement(top, "size")
    ET.SubElement(size, "width").text = str(int(width))
    ET.SubElement(size, "height").text = str(int(height))
    ET.SubElement(size, "depth").text = str(int(depth)) if depth else "1"
    ET.SubElement(top, "segmented").text = "0"

    for box in boxes:
        x_min, y_min, x_max, y_max = bnd_box(box)
        obj = ET.SubElement(top, "object")
        ET.SubElement(obj, "name").text = str(box["label"])
        ET.SubElement(obj, "pose").text = "Unspecified"
        ET.SubElement(obj, "truncated").text = _truncated(x_min, y_min, x_max, y_max, width, height)
        ET.SubElement(obj, "difficult").text = str(bool(box.get("difficult")) & 1)
        bb = ET.SubElement(obj, "bndbox")
        ET.SubElement(bb, "xmin").text = str(x_min)
        ET.SubElement(bb, "ymin").text = str(y_min)
        ET.SubElement(bb, "xmax").text = str(x_max)
        ET.SubElement(bb, "ymax").text = str(y_max)

    # labelImg's prettify(): minidom with a tab indent.
    rough = ET.tostring(top, encoding=ENCODING)
    return minidom.parseString(rough).toprettyxml(indent="\t", encoding=ENCODING)


def read_voc(data: bytes) -> dict:
    """
    Parse a Pascal VOC XML file:
      { filename, folder, width, height, depth, verified,
        boxes: [{ label, xmin, ymin, xmax, ymax, difficult }] }
    width/height/depth are None when <size> is missing.
    """
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise VocError(f"Not valid XML: {exc}") from None
    if root.tag != "annotation":
        raise VocError("Not a Pascal VOC file (the root element isn't <annotation>).")

    def num(parent, tag):
        el = parent.find(tag) if parent is not None else None
        if el is None or el.text is None or not el.text.strip():
            return None
        try:
            return int(float(el.text))
        except ValueError:
            raise VocError(f"<{tag}> isn't a number: {el.text!r}") from None

    size = root.find("size")
    boxes = []
    for obj in root.iter("object"):
        name = (obj.findtext("name") or "").strip()
        bb = obj.find("bndbox")
        if not name or bb is None:
            raise VocError("Every <object> needs a <name> and a <bndbox>.")
        coords = [num(bb, t) for t in ("xmin", "ymin", "xmax", "ymax")]
        if None in coords:
            raise VocError(f'The box for "{name}" is missing a coordinate.')
        x_min, y_min, x_max, y_max = coords
        difficult_el = obj.find("difficult")
        difficult = False
        if difficult_el is not None and (difficult_el.text or "").strip():
            difficult = bool(int(float(difficult_el.text)))
        boxes.append({"label": name, "xmin": x_min, "ymin": y_min, "xmax": x_max,
                      "ymax": y_max, "difficult": difficult})

    return {
        "filename": root.findtext("filename"),
        "folder": root.findtext("folder"),
        "width": num(size, "width"),
        "height": num(size, "height"),
        "depth": num(size, "depth"),
        "verified": root.get("verified") == "yes",
        "boxes": boxes,
    }


def voc_name(image_file_name: str) -> str:
    """photo.jpg -> photo.xml (labelImg saves next to the image, same stem)."""
    stem = image_file_name.rsplit(".", 1)[0] if "." in image_file_name else image_file_name
    return stem + XML_EXT
