"""Render the static harness workflow with ReportLab (authoring only).

Run: python site/media/generate-workflow.py
Uses the same ReportLab tool as site/charts/generate.py; no browser dependency.
"""

import base64
import re
from pathlib import Path

from reportlab.graphics import renderSVG
from reportlab.graphics.shapes import Circle, Drawing, PolyLine, String
from reportlab.lib.colors import HexColor

ROOT = Path(__file__).resolve().parent
FONT = base64.b64encode((ROOT.parent / "fonts/ibm-plex-sans.woff2").read_bytes()).decode()
STAGES = [
    ("Evidence", "Observe", ["Qualify a", "recurring gap"]),
    ("Human choice", "Select", ["You authorize", "one change"]),
    ("Pi harness", "Modify", ["Edit the", "Pi harness"]),
    ("Validation", "Test", ["Run checks", "and validation"]),
    ("Record", "Retire", ["Close only", "with evidence"]),
    ("Follow-up", "Review", ["Check later", "outcomes"]),
]
PALETTES = {
    "light": {"text": "#14181f", "muted": "#57616f", "line": "#87919f", "accent": "#084bdb"},
    "dark": {"text": "#eef1f6", "muted": "#a9b3c2", "line": "#78869a", "accent": "#9bbdff"},
}


def draw(theme, mobile):
    width, height = (360, 540) if mobile else (1200, 280)
    drawing = Drawing(width, height)
    palette = PALETTES[theme]

    def color(key):
        return HexColor(palette[key])

    def text(x, top, value, size=16, ink="text", bold=False, anchor="middle"):
        drawing.add(String(x, height - top, value, fontSize=size,
                           fontName="Helvetica-Bold" if bold else "Helvetica",
                           fillColor=color(ink), textAnchor=anchor))

    def arrow(points):
        coordinates = [coordinate for x, y in points for coordinate in (x, height - y)]
        drawing.add(PolyLine(coordinates, strokeColor=color("line"), strokeWidth=1.25, fillColor=None))
        x, y = points[-1]
        previous_x, previous_y = points[-2]
        if x == previous_x:
            direction = 1 if y > previous_y else -1
            head = [(x - 4, y - 6 * direction), (x, y), (x + 4, y - 6 * direction)]
        else:
            direction = 1 if x > previous_x else -1
            head = [(x - 6 * direction, y - 4), (x, y), (x - 6 * direction, y + 4)]
        drawing.add(PolyLine([coordinate for hx, hy in head for coordinate in (hx, height - hy)],
                            strokeColor=color("line"), strokeWidth=1.25, fillColor=None))

    for index, (category, title, description) in enumerate(STAGES):
        accent = "accent" if index == 1 else "text"
        x, y = (22, 32 + index * 80) if mobile else (90 + index * 204, 67)
        drawing.add(Circle(x, height - y, 16, strokeWidth=1.25, strokeColor=color(accent), fillColor=None))
        text(x, y + 5, f"{index + 1:02}", 14, accent)
        if mobile:
            text(58, y + 2, title, 20, accent, True, "start")
            text(58, y + 25, " ".join(description), 14, "muted", anchor="start")
            if index < 5:
                arrow([(x, y + 20), (x, y + 58)])
        else:
            text(x, 25, category.upper(), 12, "accent" if index == 1 else "muted")
            text(x, 116, title, 23, accent, True)
            for row, value in enumerate(description):
                text(x, 148 + row * 23, value, 17, "muted")
            if index < 5:
                arrow([(x + 24, y), (x + 180, y)])

    if mobile:
        arrow([(254, 272), (305, 272), (305, 192), (254, 192)])
        text(316, 228, "Failed", 12, "muted", anchor="start")
        text(316, 245, "checks", 12, "muted", anchor="start")
        text(58, 506, "New work needs a new selection.", 14, "muted", anchor="start")
    else:
        arrow([(702, 191), (702, 220), (498, 220), (498, 191)])
        text(600, 250, "Failed checks return to the change", 14, "muted")
        text(1110, 222, "New work needs", 14, "muted")
        text(1110, 242, "a new selection", 14, "muted")

    svg = renderSVG.drawToString(drawing)
    svg = re.sub(r"<!DOCTYPE[^>]*>", "", svg)
    svg = svg.replace("<title>...</title>", "").replace("<desc>...</desc>", "")
    svg = svg.replace("font-family: Helvetica-Bold;", "font-family: Plex; font-weight: 600;")
    svg = svg.replace("font-family: Helvetica;", "font-family: Plex; font-weight: 400;")
    metadata = (
        '<title>Improving the Pi harness</title>'
        '<desc>Observe a recurring gap. A human selects one change. Modify the Pi harness, '
        'test, retire with evidence, and review later outcomes. Failed checks return to '
        'Modify. New work requires a new human selection.</desc>'
        '<style>@font-face{font-family:Plex;font-style:normal;font-weight:100 900;'
        f'src:url(data:font/woff2;base64,{FONT}) format("woff2");}}</style>'
    )
    svg = re.sub(r"(<svg\b[^>]*>)", lambda match: match[1] + metadata, svg, count=1)
    svg = re.sub(r"[ \t]+(?=\r?$)", "", svg, flags=re.MULTILINE)
    suffix = ("-mobile" if mobile else "") + ("-dark" if theme == "dark" else "")
    (ROOT / f"improvement-workflow{suffix}.svg").write_text(svg, encoding="utf-8")


if __name__ == "__main__":
    for theme in PALETTES:
        for mobile in (False, True):
            draw(theme, mobile)
