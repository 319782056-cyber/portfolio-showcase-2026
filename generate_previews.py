from __future__ import annotations

import concurrent.futures
import os
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, UnidentifiedImageError, features


ROOT = Path(__file__).resolve().parent
PAGES_DIR = ROOT / "pdf-pages"
OUTPUT_DIR = PAGES_DIR / "previews"
PDFTOPPM = Path(
    r"C:\Users\zhuzhu\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe"
)
PREVIEW_WIDTH = 960
WEBP_QUALITY = 74


def build_preview(pdf_path: Path) -> tuple[str, int, tuple[int, int]]:
    output_path = OUTPUT_DIR / f"{pdf_path.stem}.webp"
    if output_path.exists() and output_path.stat().st_mtime_ns >= pdf_path.stat().st_mtime_ns:
        try:
            with Image.open(output_path) as image:
                image.verify()
            with Image.open(output_path) as image:
                return output_path.name, output_path.stat().st_size, image.size
        except (OSError, UnidentifiedImageError):
            output_path.unlink(missing_ok=True)

    with tempfile.TemporaryDirectory(prefix="portfolio-preview-", dir=OUTPUT_DIR) as temporary:
        prefix = Path(temporary) / pdf_path.stem
        subprocess.run(
            [
                str(PDFTOPPM),
                "-f",
                "1",
                "-l",
                "1",
                "-singlefile",
                "-scale-to-x",
                str(PREVIEW_WIDTH),
                "-scale-to-y",
                "-1",
                "-png",
                str(pdf_path),
                str(prefix),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        with Image.open(prefix.with_suffix(".png")) as image:
            image = image.convert("RGB")
            temporary_output = prefix.with_suffix(".webp")
            image.save(temporary_output, "WEBP", quality=WEBP_QUALITY, method=6)
            dimensions = image.size
        temporary_output.replace(output_path)

    return output_path.name, output_path.stat().st_size, dimensions


def main() -> None:
    if not PDFTOPPM.exists():
        raise FileNotFoundError(f"pdftoppm not found: {PDFTOPPM}")
    if not features.check("webp"):
        raise RuntimeError("This Pillow build does not support WebP")

    pdf_files = sorted(PAGES_DIR.glob("page-*.pdf"))
    if not pdf_files:
        raise FileNotFoundError(f"No split PDF pages found in {PAGES_DIR}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    worker_count = min(4, os.cpu_count() or 1)
    results: list[tuple[str, int, tuple[int, int]]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as executor:
        for result in executor.map(build_preview, pdf_files):
            results.append(result)
            print(f"{result[0]}: {result[2][0]}x{result[2][1]}, {result[1] / 1024:.1f} KiB")

    total_size = sum(size for _, size, _ in results)
    largest = max(results, key=lambda item: item[1])
    print(f"Generated {len(results)} previews, total {total_size / 1024 / 1024:.2f} MiB")
    print(f"Largest preview: {largest[0]} ({largest[1] / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
