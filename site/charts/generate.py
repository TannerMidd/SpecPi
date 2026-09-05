"""Regenerate static research figures, CSVs, and accessible HTML from reviewed data.

Uses ReportLab 4.4.9 graphics (an authoring tool only; no site runtime dependency).
Run from any directory: python site/charts/generate.py
"""

import csv
import hashlib
import html
import json
import math
import re
from pathlib import Path

from reportlab.graphics import renderSVG
from reportlab.graphics.charts.barcharts import HorizontalBarChart
from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.graphics.shapes import Drawing, Line, Rect, String
from reportlab.graphics.widgets.markers import makeMarker
from reportlab.lib.colors import HexColor
from reportlab.pdfbase.pdfmetrics import stringWidth

ROOT = Path(__file__).resolve().parent
DATA = json.loads((ROOT / "research-data.json").read_text(encoding="utf-8"))
PALETTE = {
    "background": "#171e22", "text": "#e0e6ea", "muted": "#a8b4bc",
    "grid": "#354149", "single": "#a4c3b7", "multi": "#99b6d4",
    "third": "#d6bc83", "neutral": "#a8b4bc",
}
COLORS = ["single", "multi", "third"]


def ink(name):
    return HexColor(PALETTE[name])


def text(drawing, x, top, value, size=14, color="text", bold=False, align="start"):
    drawing.add(String(x, drawing.height - top - size, str(value),
                       fontName="Helvetica-Bold" if bold else "Helvetica",
                       fontSize=size, fillColor=ink(color), textAnchor=align))


def line(drawing, x1, top1, x2, top2, color="grid", width=1):
    drawing.add(Line(x1, drawing.height - top1, x2, drawing.height - top2,
                     strokeColor=ink(color), strokeWidth=width))


def wrapped(drawing, x, top, value, width, size=12, color="muted"):
    words = value.split()
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and stringWidth(candidate, "Helvetica", size) > width:
            text(drawing, x, top, current, size, color)
            top += size + 5
            current = word
        else:
            current = candidate
    text(drawing, x, top, current, size, color)
    return top + size + 5


def chart_base(width, height):
    drawing = Drawing(width, height)
    drawing.add(Rect(0, 0, width, height, fillColor=ink("background"), strokeColor=None))
    return drawing


def horizontal_bar(drawing, x, top, width, value, maximum, color):
    chart = HorizontalBarChart()
    chart.x = x
    chart.y = drawing.height - top - 12
    chart.width = width
    chart.height = 12
    chart.data = [(value,)]
    chart.valueAxis.valueMin = 0
    chart.valueAxis.valueMax = maximum
    chart.valueAxis.visible = False
    chart.categoryAxis.visible = False
    chart.bars[0].fillColor = ink(color)
    chart.bars[0].strokeColor = None
    chart.barWidth = 12
    chart.groupSpacing = 0
    chart.barSpacing = 0
    drawing.add(chart)


def bar_panel(drawing, study, panel, x, top, width):
    text(drawing, x, top, panel["title"], 16, bold=True)
    text(drawing, x, top + 26, panel["subtitle"], 13, "muted")
    text(drawing, x, top + 48, panel["unit"], 12, "muted")
    series = panel.get("series", study.get("series"))
    palette = panel.get("colors", COLORS)
    bottom = top + 74 + 44 * len(series)
    for tick in [0, panel["max"] / 2, panel["max"]]:
        px = x + width * tick / panel["max"]
        line(drawing, px, top + 91, px, bottom - 5)
        text(drawing, px, bottom + 2, f"{tick:g}", 12, "muted",
             align="start" if tick == 0 else "end" if tick == panel["max"] else "middle")
    for index, (label, value) in enumerate(zip(series, panel["values"])):
        row = top + 73 + 44 * index
        text(drawing, x, row, label, 14)
        formatted = f"{value:.{panel['digits']}f}{panel.get('suffix', '')}"
        text(drawing, x + width, row, formatted, 14, bold=True, align="end")
        horizontal_bar(drawing, x, row + 20, width, value, panel["max"], palette[index])
        if "n" in panel:
            p = value / 100
            margin = 100 * 1.96 * math.sqrt(p * (1 - p) / panel["n"])
            low = x + width * (value - margin) / panel["max"]
            high = x + width * (value + margin) / panel["max"]
            line(drawing, low, row + 26, high, row + 26, "background", 4)
            line(drawing, low, row + 21, low, row + 31, "background", 4)
            line(drawing, high, row + 21, high, row + 31, "background", 4)
            line(drawing, low, row + 26, high, row + 26, "text", 2)
            line(drawing, low, row + 21, low, row + 31, "text", 2)
            line(drawing, high, row + 21, high, row + 31, "text", 2)


def bar_figure(study, compact):
    panels = study["panels"]
    width = 320 if compact else 720
    columns = 1 if compact or len(panels) == 1 else 2
    rows = math.ceil(len(panels) / columns)
    cell_height = 250 if any(len(p["values"]) == 3 for p in panels) else 208
    height = rows * cell_height + 68
    drawing = chart_base(width, height)
    cell_width = (width - 32 - (columns - 1) * 32) / columns
    for index, panel in enumerate(panels):
        x = 16 + (index % columns) * (cell_width + 32)
        top = 16 + (index // columns) * cell_height
        bar_panel(drawing, study, panel, x, top, cell_width)
    footer(drawing, study, rows * cell_height + 14)
    return drawing


def reasoning_figure(study, compact):
    width, height = (320, 436) if compact else (720, 440)
    drawing = chart_base(width, height)
    text(drawing, 16, 14, "Average accuracy (%)", 16, bold=True)
    for index, label in enumerate(study["series"]):
        text(drawing, 16 + (0 if compact else index * 224), 46 + (index * 23 if compact else 0),
             ["● ", "■ ", "▲ "][index] + label, 14, COLORS[index])
    left, top = 42, 126 if compact else 102
    plot_width, plot_height = width - 66, 208 if compact else 236
    for tick in range(0, 51, 10):
        y = top + plot_height * (1 - tick / 50)
        line(drawing, left, y, left + plot_width, y)
        text(drawing, left - 10, y - 7, tick, 12, "muted", align="end")
    for tick, label in [(100, "100"), (1000, "1,000"), (10000, "10,000")]:
        x = left + plot_width * (math.log10(tick) - 2) / 2
        line(drawing, x, top, x, top + plot_height)
        text(drawing, x, top + plot_height + 9, label, 12, "muted",
             align="start" if tick == 100 else "end" if tick == 10000 else "middle")
    chart = LinePlot()
    chart.x, chart.y = left, height - top - plot_height
    chart.width, chart.height = plot_width, plot_height
    chart.data = [list(zip([math.log10(x) for x in study["budgets"]], values)) for values in study["values"]]
    chart.xValueAxis.valueMin, chart.xValueAxis.valueMax = 2, 4
    chart.yValueAxis.valueMin, chart.yValueAxis.valueMax = 0, 50
    chart.xValueAxis.visible = chart.yValueAxis.visible = False
    for index in range(3):
        chart.lines[index].strokeColor = ink(COLORS[index])
        chart.lines[index].strokeWidth = 2
        chart.lines[index].symbol = makeMarker(["FilledCircle", "FilledSquare", "FilledTriangle"][index])
        chart.lines[index].symbol.size = 6
        chart.lines[index].symbol.fillColor = ink(COLORS[index])
        chart.lines[index].symbol.strokeColor = ink(COLORS[index])
        if index == 1:
            chart.lines[index].strokeDashArray = [6, 3]
        if index == 2:
            chart.lines[index].strokeDashArray = [2, 3]
    drawing.add(chart)
    text(drawing, left, top + plot_height + 33, "Requested thinking tokens / log scale", 12, "muted")
    footer(drawing, study, height - 43)
    return drawing


def taxonomy_figure(study, compact):
    width, height = (320, 414) if compact else (720, 360)
    drawing = chart_base(width, height)
    text(drawing, 16, 14, "Distinct taxonomy modes", 16, bold=True)
    for index, (label, count, identifiers) in enumerate(study["rows"]):
        top = 58 + index * (98 if compact else 80)
        text(drawing, 16, top, label, 15, bold=True)
        text(drawing, width - 16, top, count, 16, bold=True, align="end")
        for square in range(count):
            drawing.add(Rect(16 + square * 28, height - top - 46, 18, 18,
                             fillColor=ink("neutral"), strokeColor=None))
        if compact:
            text(drawing, 16, top + 57, f"Taxonomy IDs {identifiers}", 12, "muted")
        else:
            text(drawing, width - 16, top + 28, f"Taxonomy IDs {identifiers}", 12, "muted", align="end")
    footer(drawing, study, height - 51)
    return drawing


def footer(drawing, study, top):
    line(drawing, 16, top - 8, drawing.width - 16, top - 8)
    wrapped(drawing, 16, top, f"Source: {study['credit']}", drawing.width - 32, 11)


def rows_for(study):
    if study["kind"] == "lines":
        return [[budget, *[f"{values[index]:.1f}" for values in study["values"]]]
                for index, budget in enumerate(study["budgets"])]
    if study["kind"] == "taxonomy":
        return study["rows"]
    if study["id"] == "ensemble":
        return [[label, f"{value:.1f}", config] for label, value, config in
                zip(study["series"], study["panels"][0]["values"], study["configurations"])]
    if study["id"] == "anthropic":
        return [[panel["title"], label, f"{value:.{panel['digits']}f}", panel["detail"][0]]
                for panel in study["panels"] for label, value in zip(panel["series"], panel["values"])]
    return [[panel["title"], *[f"{value:.{panel['digits']}f}" for value in panel["values"]], *panel["detail"]]
            for panel in study["panels"]]


def figure_html(study, size):
    key = study["id"]
    esc = html.escape
    headers = "".join(f'<th scope="col">{esc(header)}</th>' for header in study["headers"])
    rows = "".join("<tr>" + "".join(
        f'<th scope="row">{esc(str(value))}</th>' if index == 0 else f"<td>{esc(str(value))}</td>"
        for index, value in enumerate(row)) + "</tr>" for row in rows_for(study))
    derivation = f'<p>{esc(study["derivation"])}</p>' if "derivation" in study else ""
    return f'''<figure class="research-chart" id="chart-{key}" aria-labelledby="chart-{key}-title">
        <figcaption id="chart-{key}-title">{esc(study['title'])}</figcaption>
        <picture>
            <source media="(max-width: 600px), (min-width: 801px) and (max-width: 1100px)" srcset="../charts/{key}-compact.svg" />
            <img src="../charts/{key}.svg" width="{int(size[0])}" height="{int(size[1])}" loading="lazy" decoding="async" alt="{esc(study['alt'])}" />
        </picture>
        <p class="chart-note">{esc(study['note'])}</p>
        <details class="chart-data">
            <summary>Data and source details</summary>
            <div class="table-scroll" role="region" aria-label="{esc(study['title'])} data" tabindex="0">
                <table><caption>{esc(study['title'])}</caption><thead><tr>{headers}</tr></thead><tbody>{rows}</tbody></table>
            </div>
            <p>{esc(study['locator'])}. <a href="{esc(study['source'])}">Primary source ↗</a></p>{derivation}
        </details>
        <div class="chart-downloads" aria-label="Download {esc(study['title'])}">
            <a href="../charts/{key}.svg" download="specpi-{key}.svg">SVG figure ↓</a>
            <a href="../charts/{key}.csv" download="specpi-{key}.csv">CSV data ↓</a>
        </div>
    </figure>'''


def main():
    article_path = ROOT.parent / "single-agent" / "index.html"
    article = article_path.read_text(encoding="utf-8")
    for study in DATA["studies"]:
        key = study["id"]
        def canonical(value):
            if isinstance(value, float) and value.is_integer():
                return int(value)
            if isinstance(value, list):
                return [canonical(item) for item in value]
            if isinstance(value, dict):
                return {name: canonical(item) for name, item in value.items()}
            return value

        digest = hashlib.sha256(json.dumps(canonical(study), sort_keys=True, ensure_ascii=False,
                                          separators=(",", ":")).encode()).hexdigest()
        wide_size = None
        for compact in [False, True]:
            if study["kind"] == "lines":
                drawing = reasoning_figure(study, compact)
            elif study["kind"] == "taxonomy":
                drawing = taxonomy_figure(study, compact)
            else:
                drawing = bar_figure(study, compact)
            if not compact:
                wide_size = (drawing.width, drawing.height)
            svg = renderSVG.drawToString(drawing)
            svg = re.sub(r"<!DOCTYPE[^>]*>", "", svg)
            svg = svg.replace("<title>...</title>", "").replace("<desc>...</desc>", "")
            svg = svg.replace("font-family: Helvetica-Bold;", "font-family: Arial, Helvetica, sans-serif; font-weight: 700;")
            svg = svg.replace("font-family: Helvetica;", "font-family: Arial, Helvetica, sans-serif;")
            metadata = (f'<title>{html.escape(study["title"])}</title>'
                        f'<desc>{html.escape(study["alt"] + " " + study["note"])}</desc>'
                        f'<metadata data-study="{key}" data-sha256="{digest}">'
                        f'{html.escape(study["source"] + " | " + study["locator"])}</metadata>')
            svg = re.sub(r"(<svg\b[^>]*>)", lambda match: match[1] + metadata, svg, count=1)
            svg = re.sub(r"[ \t]+(?=\r?$)", "", svg, flags=re.MULTILINE)
            filename = f"{key}{'-compact' if compact else ''}.svg"
            (ROOT / filename).write_text(svg, encoding="utf-8")
        with (ROOT / f"{key}.csv").open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow([*study["headers"], "Source", "Source location", "Comparison conditions"])
            for row in rows_for(study):
                writer.writerow([*row, study["source"], study["locator"], study["note"]])
        start, end = f"<!-- research-chart:{key} -->", f"<!-- /research-chart:{key} -->"
        if article.count(start) != 1 or article.count(end) != 1:
            raise ValueError(f"Expected exactly one chart slot for {key}")
        article = re.sub(re.escape(start) + r"[\s\S]*?" + re.escape(end),
                         lambda match: start + "\n" + figure_html(study, wide_size) + "\n" + end, article)
    article_path.write_text(article, encoding="utf-8")


if __name__ == "__main__":
    main()
