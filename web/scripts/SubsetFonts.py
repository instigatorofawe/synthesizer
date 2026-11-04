"""Makes the app's fonts, web/static/fonts/*.woff2, from DejaVu's TrueType files.

    python3 scripts/SubsetFonts.py <dir holding DejaVuSans.ttf and the others>

The app sets its text in DejaVu Sans and DejaVu Sans Mono, the faces CI's Linux runner draws, served with the page so every
platform lays text out alike. These are cut to Latin, Greek, and the blocks the app's symbols come from (arrows, shapes,
music, ⌘), which keeps them small; text outside them falls back to the platform's own fonts. Needs fonttools and brotli
(pip install fonttools brotli). The files come from Ubuntu 24.04's fonts-dejavu-core and fonts-dejavu-mono, 2.37-8,
which CI's runner has; their licence is static/fonts/DejaVuLicense.txt, which must go wherever they do.
"""

import sys
from pathlib import Path

from fontTools import subset

FACES = ["DejaVuSans", "DejaVuSans-Bold", "DejaVuSansMono", "DejaVuSansMono-Bold"]
RANGES = [
    (0x0020, 0x017F),  # Basic Latin, Latin-1, Latin Extended-A
    (0x0391, 0x03C9),  # Greek, for Ω and μ
    (0x2000, 0x206F),  # Punctuation: quotes, dashes, the ellipsis, the bullet
    (0x20AC, 0x20AC),  # The euro
    (0x2190, 0x23FF),  # Arrows, maths, and the technical signs, ⌘ among them
    (0x25A0, 0x25FF),  # Shapes: ■ ▶ ▾ ◆ ●
    (0x2600, 0x26FF),  # Symbols: ☰ and the music signs ♪ ♫ ♭ ♯
    (0x27F0, 0x27FF),  # ⟲
    (0x2900, 0x297F),  # ⤢
]


def main():
    source = Path(sys.argv[1])
    out = Path(__file__).resolve().parent.parent / "static" / "fonts"
    out.mkdir(parents=True, exist_ok=True)
    unicodes = [code for start, end in RANGES for code in range(start, end + 1)]
    for face in FACES:
        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        options.notdef_outline = True
        font = subset.load_font(str(source / f"{face}.ttf"), options)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=unicodes)
        subsetter.subset(font)
        subset.save_font(font, str(out / f"{face}.woff2"), options)
        print(face, (out / f"{face}.woff2").stat().st_size)


if __name__ == "__main__":
    main()
