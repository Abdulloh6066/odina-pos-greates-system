#!/usr/bin/env python3
"""Generate POS-only WebP files without changing Product records or original images.

Usage: python3 scripts/generate-pos-thumbnails.py /tmp/product-images.json
Input: array of {id, image_url} from a read-only Product export, or an
ID-to-public-filename map such as scripts/pos-image-sources.json.
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
# Preserve the already-approved smaller Central trial assets when the original
# product photo still matches. Extending coverage must not make Central heavier.
APPROVED_TRIAL_SOURCES = {
    "6ab546e601804895b9374e80": "8626ae888_spartak.png",
    "6ab546e3e87e400ee14b2c6c": "291ecb623_biskvit.png",
    "6ab546e0d3b3bba25340fb13": "b40f830d8_gozli-pirojni.png",
    "6ab546d671c7683c19867ccf": "9ea742922_tvarojniy.png",
    "6ab546d28badecb776d7b864": "f9d5967a0_medavik-kaymoq.png",
    "6ab546cfded029118ff61c26": "906e9b372_prechuda.png",
    "6ab546cc9d99abaff9b7a539": "71c2f0df1_medavik-damashniy.png",
    "6ab54689fddbaa9a6a528495": "e7fbb35db_twix.png",
}


def convert(product: dict) -> dict:
    product_id, source = str(product.get("id", "")), product.get("image_url")
    row = {"id": product_id, "name": product.get("name", ""), "source": source}
    if not source:
        return {**row, "status": "no_image"}
    if not re.fullmatch(r"[a-f0-9]{16,64}", product_id):
        raise ValueError(f"Unsupported product ID: {product_id}")
    local_source = None
    if source.startswith("/images/"):
        public_root = (ROOT / "public").resolve()
        local_source = (public_root / source.lstrip("/")).resolve()
        if not local_source.is_relative_to(public_root):
            raise ValueError("Local source must remain inside public assets")
        if not local_source.is_file():
            return {**row, "status": "local_source_unavailable"}
        if local_source.suffix.lower() == ".svg":
            return {**row, "status": "existing_svg", "bytes": local_source.stat().st_size}
    elif not source.startswith(SOURCE_PREFIX):
        raise ValueError(f"Unsupported source for {product_id}; original left unchanged")

    cache = Path("/tmp/odina-pos-image-originals")
    cache.mkdir(exist_ok=True)
    original_path = cache / (sha256(source.encode()).hexdigest() + ".original")
    if local_source:
        if local_source.stat().st_size > MAX_SOURCE_BYTES:
            raise ValueError("Source exceeds safe size limit")
        original_path.write_bytes(local_source.read_bytes())
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
    reused_approved_thumbnail = False
    approved_source = APPROVED_TRIAL_SOURCES.get(product_id)
    approved_path = ROOT / "public/images/pos-15-v1" / f"{product_id}.webp"
    if approved_source and source == SOURCE_PREFIX + approved_source and approved_path.is_file():
        approved_bytes = approved_path.read_bytes()
        with Image.open(io.BytesIO(approved_bytes)) as approved:
            approved_size = list(approved.size)
            approved.verify()
        if len(approved_bytes) < len(output_bytes) and min(approved_size) >= 400:
            output_bytes, output_size = approved_bytes, approved_size
            reused_approved_thumbnail = True
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
            "original_size": source_size, "thumbnail_size": output_size,
            "reused_approved_thumbnail": reused_approved_thumbnail}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--report", type=Path, default=Path("/tmp/odina-pos-image-report.json"))
    args = parser.parse_args()
    products = json.loads(args.input.read_text())
    if isinstance(products, dict):
        if any(not isinstance(filename, str) or ".." in filename
               or ("/" in filename and not filename.startswith("/images/"))
               for filename in products.values()):
            raise ValueError("Compact inputs must contain public filenames or local /images/ paths")
        products = [{"id": key, "image_url": (filename if filename.startswith("/images/")
                    else SOURCE_PREFIX + filename) if filename else ""}
                    for key, filename in products.items()]
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
               "reused_approved_thumbnails": sum(bool(row.get("reused_approved_thumbnail")) for row in optimized),
               "existing_svg": sum(row["status"] == "existing_svg" for row in results),
               "no_image": sum(row["status"] == "no_image" for row in results),
               "original_smaller": sum(row["status"] == "original_smaller" for row in results),
               "source_unavailable": sum(row["status"] == "source_unavailable" for row in results),
               "local_source_unavailable": sum(row["status"] == "local_source_unavailable" for row in results),
               "original_bytes": original, "thumbnail_bytes": compressed,
               "saved_percent": round((1 - compressed / original) * 100, 2),
               "max_edge": MAX_EDGE, "webp_quality": QUALITY}
    args.report.write_text(json.dumps({"summary": summary, "images": results}, indent=2, ensure_ascii=False))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
