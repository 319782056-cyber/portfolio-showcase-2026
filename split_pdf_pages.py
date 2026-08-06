from __future__ import annotations

import hashlib
import json
from pathlib import Path

from pypdf import PdfReader, PdfWriter


SOURCE = Path(r"D:\codex\作品\huaban大.pdf")
OUTPUT_DIR = Path(__file__).resolve().parent / "pdf-pages"
MANIFEST = OUTPUT_DIR / "manifest.json"


def page_stream_hashes(page) -> list[str]:
    hashes: list[str] = []
    seen: set[tuple[int, int]] = set()

    def visit(resources) -> None:
        if not resources or "/XObject" not in resources:
            return
        xobjects = resources["/XObject"].get_object()
        for reference in xobjects.values():
            obj = reference.get_object()
            identity = getattr(reference, "idnum", None), getattr(reference, "generation", None)
            if identity in seen:
                continue
            seen.add(identity)
            subtype = obj.get("/Subtype")
            if subtype == "/Image":
                hashes.append(hashlib.sha256(obj.get_data()).hexdigest())
            elif subtype == "/Form":
                visit(obj.get("/Resources"))

    visit(page.get("/Resources"))
    return sorted(hashes)


def main() -> None:
    with SOURCE.open("rb") as source_stream:
        asset_version = hashlib.file_digest(source_stream, "sha256").hexdigest()[:12]
    reader = PdfReader(str(SOURCE))
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest_pages: list[dict[str, object]] = []

    for index, source_page in enumerate(reader.pages, start=1):
        output_path = OUTPUT_DIR / f"page-{index:03d}.pdf"
        writer = PdfWriter()
        writer.add_page(source_page)
        with output_path.open("wb") as stream:
            writer.write(stream)

        check_reader = PdfReader(str(output_path))
        if len(check_reader.pages) != 1:
            raise RuntimeError(f"{output_path.name}: expected one page")
        output_page = check_reader.pages[0]
        source_size = (float(source_page.mediabox.width), float(source_page.mediabox.height))
        output_size = (float(output_page.mediabox.width), float(output_page.mediabox.height))
        if source_size != output_size:
            raise RuntimeError(f"{output_path.name}: page size changed")
        if page_stream_hashes(source_page) != page_stream_hashes(output_page):
            raise RuntimeError(f"{output_path.name}: image stream data changed")

        manifest_pages.append(
            {
                "file": output_path.name,
                "width": round(source_size[0], 3),
                "height": round(source_size[1], 3),
                "bytes": output_path.stat().st_size,
            }
        )

    MANIFEST.write_text(
        json.dumps(
            {"version": asset_version, "pages": manifest_pages},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    largest = max(manifest_pages, key=lambda item: int(item["bytes"]))
    print(
        json.dumps(
            {
                "pages": len(manifest_pages),
                "total_bytes": sum(int(item["bytes"]) for item in manifest_pages),
                "largest": largest,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
