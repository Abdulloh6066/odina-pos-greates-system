#!/usr/bin/env python3
"""Generate POS-only WebP files without changing Product records or original images.

Usage: python3 scripts/generate-pos-thumbnails.py /tmp/product-images.json
Input: array of {id, image_url}, from a read-only Product export.
Requires Pillow for this maintenance task only; not an app/runtime dependency.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import io
import json
from pathlib import Path
import re
import time
import urllib.request
import urllib.error
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE_PREFIX = "https://base44.app/api/apps/6a96eb22a9fd2b34081eb2dd/files/mp/public/6a96eb22a9fd2b34081eb2dd/"
MAX_EDGE = 512  # Retains detail on high-density POS/tablet screens.
QUALITY = 88
MAX_SOURCE_BYTES = 25 * 1024 * 1024
OUTPUT = ROOT / "public/images/pos-v2"
MANIFEST = ROOT / "src/lib/pos-thumbnail-manifest.js"


def convert(product: dict) -> dict:
    product_id, source = str(product.get("id", "")), product.get("image_url")
    row = {"id": product_id, "name": product.get("name", ""), "source": source}
    if not source:
        return {**row, "status": "no_image"}
    if source.startswith("/images/") and source.lower().endswith(".svg"):
        existing = ROOT / "public" / source.lstrip("/")
        if not existing.is_file():
            raise ValueError(f"Missing local SVG for {product_id}")
        return {**row, "status": "existing_svg", "bytes": existing.stat().st_size}
    if not re.fullmatch(r"[a-f0-9]{24}", product_id) or not source.startswith(SOURCE_PREFIX):
        raise ValueError(f"Unsupported source for {product_id}; original left unchanged")

    cache = Path("/tmp/odina-pos-image-originals")
    cache.mkdir(exist_ok=True)
    original_path = cache / (sha256(source.encode()).hexdigest() + ".original")
    raw = None
    for attempt in range(3):
        try:
            if original_path.is_file():
                raw = original_path.read_bytes()
            else:
                request = urllib.request.Request(source, headers={"User-Agent": "Odina-POS-image-maintenance/1.0"})
                with urllib.request.urlopen(request, timeout=30) as response:
                    raw = response.read(MAX_SOURCE_BYTES + 1)
                if len(raw) > MAX_SOURCE_BYTES:
                    raise ValueError("Source exceeds safe size limit")
                original_path.write_bytes(raw)
            break
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return {**row, "status": "source_unavailable", "http_status": error.code}
            if attempt == 2:
                raise RuntimeError(f"Image download failed for {product_id}: HTTP {error.code}") from error
            time.sleep(attempt + 1)
        except Exception as error:
            if attempt == 2:
                raise RuntimeError(f"Image conversion input failed for {product_id}") from error
            time.sleep(attempt + 1)

    with Image.open(io.BytesIO(raw)) as opened:
        if getattr(opened, "is_animated", False):
            raise ValueError(f"Animated source cannot be flattened: {product_id}")
        source_size = list(opened.size)
        image = ImageOps.exif_transpose(opened)
        image = image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")
        image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, "WEBP", quality=QUALITY, method=6, exact=True)
        output_bytes = buffer.getvalue()
        output_size = list(image.size)
    if len(output_bytes) >= len(raw):
        return {**row, "status": "original_smaller", "original_bytes": len(raw)}
    digest = sha256(output_bytes).hexdigest()[:12]
    filename = f"{product_id}-{digest}.webp"
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / filename).write_bytes(output_bytes)
    with Image.open(OUTPUT / filename) as check:
        check.verify()
    return {**row, "status": "optimized", "thumbnail": f"/images/pos-v2/{filename}",
            "original_bytes": len(raw), "thumbnail_bytes": len(output_bytes),
            "original_size": source_size, "thumbnail_size": output_size}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--report", type=Path, default=Path("/tmp/odina-pos-image-report.json"))
    args = parser.parse_args()
    products = json.loads(args.input.read_text())
    if not isinstance(products, list) or not products:
        raise ValueError("Input must be a nonempty product array")
    ids = [p.get("id") for p in products]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate product IDs")
    with ThreadPoolExecutor(max_workers=4) as executor:
        # All conversions must succeed before replacing the lookup manifest.
        results = list(executor.map(convert, products))
    optimized = [row for row in results if row["status"] == "optimized"]
    if not optimized:
        raise ValueError("No images converted; manifest not replaced")
    manifest = {row["id"]: {"source": row["source"], "thumbnail": row["thumbnail"]}
                for row in sorted(optimized, key=lambda row: row["id"])}
    MANIFEST.write_text("// Generated by scripts/generate-pos-thumbnails.py. Original product URLs are never modified.\n"
                        + "export const POS_THUMBNAILS = Object.freeze("
                        + json.dumps(manifest, indent=2, ensure_ascii=False) + ");\n")
    original = sum(row["original_bytes"] for row in optimized)
    compressed = sum(row["thumbnail_bytes"] for row in optimized)
    summary = {"products": len(products), "optimized": len(optimized),
               "existing_svg": sum(row["status"] == "existing_svg" for row in results),
               "no_image": sum(row["status"] == "no_image" for row in results),
               "original_smaller": sum(row["status"] == "original_smaller" for row in results),
               "source_unavailable": sum(row["status"] == "source_unavailable" for row in results),
               "original_bytes": original, "thumbnail_bytes": compressed,
               "saved_percent": round((1 - compressed / original) * 100, 2),
               "max_edge": MAX_EDGE, "webp_quality": QUALITY}
    args.report.write_text(json.dumps({"summary": summary, "images": results}, indent=2, ensure_ascii=False))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
