"""Assembles docs/preview.gif from the frames scripts/capture-preview.ts recorded."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TypedDict

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FRAMES = ROOT / "docs" / "frames"
OUT = ROOT / "docs" / "preview.gif"

PAD = 12
CAPTION_H = 44
LABEL_H = 24
BG = (246, 247, 249)
INK = (29, 35, 43)
MUTED = (102, 113, 125)
COLORS = [(109, 76, 65), (216, 27, 96)]


class Frame(TypedDict):
    left: str
    right: str
    caption: str
    durationMs: int


class Manifest(TypedDict):
    viewport: dict[str, int]
    labels: list[str]
    frames: list[Frame]


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = ["DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"]
    for name in names:
        for folder in ["/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu"]:
            path = Path(folder) / name
            if path.exists():
                return ImageFont.truetype(str(path), size)
    return ImageFont.load_default()


def compose(manifest: Manifest, frame: Frame) -> Image.Image:
    width = manifest["viewport"]["width"]
    height = manifest["viewport"]["height"]
    canvas = Image.new(
        "RGB", (PAD * 3 + width * 2, CAPTION_H + LABEL_H + height + PAD), BG
    )
    draw = ImageDraw.Draw(canvas)
    draw.text((PAD, 13), frame["caption"], fill=INK, font=font(17, bold=True))
    for i, (name, label) in enumerate(
        zip([frame["left"], frame["right"]], manifest["labels"], strict=True)
    ):
        x = PAD + i * (width + PAD)
        draw.ellipse(
            (x, CAPTION_H + 6, x + 10, CAPTION_H + 16), fill=COLORS[i % len(COLORS)]
        )
        draw.text((x + 16, CAPTION_H + 3), label, fill=MUTED, font=font(13))
        with Image.open(FRAMES / name) as shot:
            canvas.paste(shot.convert("RGB"), (x, CAPTION_H + LABEL_H))
        draw.rectangle(
            (x - 1, CAPTION_H + LABEL_H - 1, x + width, CAPTION_H + LABEL_H + height),
            outline=(223, 227, 232),
        )
    return canvas


def main() -> None:
    manifest: Manifest = json.loads((FRAMES / "manifest.json").read_text())
    images = [compose(manifest, frame) for frame in manifest["frames"]]
    # One shared palette keeps colours stable between frames and lets the encoder reuse
    # unchanged regions, which is most of every frame here.
    palette_source = images[len(images) // 2]
    palette = palette_source.quantize(colors=96, method=Image.Quantize.MEDIANCUT)
    quantized = [
        image.quantize(palette=palette, dither=Image.Dither.NONE) for image in images
    ]
    quantized[0].save(
        OUT,
        save_all=True,
        append_images=quantized[1:],
        duration=[frame["durationMs"] for frame in manifest["frames"]],
        loop=0,
        optimize=True,
        disposal=1,
    )
    print(
        f"{OUT.relative_to(ROOT)}: {len(images)} frames, {OUT.stat().st_size / 1_000_000:.2f} MB"
    )


if __name__ == "__main__":
    main()
