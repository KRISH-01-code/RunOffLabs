"""PDF reports: one design compared with the existing site.

Everything in the report is either an input the user set, a documented
default (with its source), or a number read from a SWMM run made while
building the report. The PDF is generated locally with ReportLab.
"""

from __future__ import annotations

import io
import math
from datetime import datetime, timezone
from xml.sax.saxutils import escape

from reportlab.graphics.shapes import Circle, Drawing, Group, Line, PolyLine, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    CondPageBreak,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from runofflab.engine import lid_params
from runofflab.hydrology import quality
from runofflab.hydrology.longterm import SYNTHETIC_REFERENCE
from runofflab.hydrology.rainfall import RAINFALL_REFERENCES, StormPattern
from runofflab.hydrology.soils import SOIL_REFERENCE, SOILS
from runofflab.hydrology.surfaces import SURFACE_DEFAULTS
from runofflab.models.project import (
    CAPTURING, Design, GreenRoof, InfiltrationTrench, PermeablePavement, Project, RainBarrel, RainGarden,
)
from runofflab.models.results import LongTermResult, SimulationResult
from runofflab.optimize import ExploreStatus
from runofflab.validation import KINDS, check_design, intervention_cost
from runofflab.whatif import WhatIfCase

# ── Palette (matches the web app's light theme) ─────────────────────────────

C = colors.HexColor
INK, INK2, MUTED = C("#13241b"), C("#43554a"), C("#5f6f65")
ACCENT, ACCENT_WASH = C("#2d6a4f"), C("#e6efe8")
GRID, AXIS, RULE = C("#e1e7dc"), C("#c2ccbf"), C("#d5ddd2")
WATER, BASELINE, PROPOSED = C("#2a78d6"), C("#eb6834"), C("#1baf7a")
GOOD, BAD = C("#1d6b2f"), C("#b23a2c")
KIND = {"roof": C("#9aa3a0"), "parking": C("#6c716e"), "road": C("#5d625f"),
        "sidewalk": C("#d9d1bf"), "lawn": C("#a9cc8a"), "landscape": C("#7fae62")}
RG_FILL, RG_STROKE, PP_FILL, PP_STROKE = C("#2f9e6b"), C("#17603f"), C("#d6a46c"), C("#946232")
# Fill and outline for each intervention kind on the plan (match the web app's tokens).
LID_STYLE = {"rain_garden": (RG_FILL, RG_STROKE), "permeable_pavement": (PP_FILL, PP_STROKE),
             "green_roof": (C("#8fbf4d"), C("#4f7a24")), "infiltration_trench": (C("#a9b8c6"), C("#5d7590")),
             "rain_barrel": (C("#4a6fa5"), C("#2c4870"))}
MAP_BG, NODE = C("#f2f0e6"), C("#1c5cab")

PAGE_W, PAGE_H = letter
MARGIN = 0.7 * inch
CONTENT_W = PAGE_W - 2 * MARGIN

BASE = ParagraphStyle("base", fontName="Helvetica", fontSize=9.5, leading=13, textColor=INK, alignment=TA_LEFT)
SMALL = ParagraphStyle("small", parent=BASE, fontSize=8, leading=10.5, textColor=MUTED)
H1 = ParagraphStyle("h1", parent=BASE, fontName="Helvetica-Bold", fontSize=20, leading=24, spaceAfter=2)
SUB = ParagraphStyle("sub", parent=BASE, fontSize=11, leading=14, textColor=INK2)
H2 = ParagraphStyle("h2", parent=BASE, fontName="Helvetica-Bold", fontSize=12.5, leading=16, textColor=ACCENT,
                    spaceBefore=12, spaceAfter=6, keepWithNext=1)
H3 = ParagraphStyle("h3", parent=BASE, fontName="Helvetica-Bold", fontSize=10, leading=13, spaceBefore=8, spaceAfter=4,
                    keepWithNext=1)
LEAD = ParagraphStyle("lead", parent=BASE, fontSize=11, leading=15.5)
CELL = ParagraphStyle("cell", parent=BASE, fontSize=8.5, leading=10.5)


def _t(s: str) -> str:
    """Text safe for the built-in PDF fonts (WinAnsi), escaped for Paragraph markup."""
    for a, b in (("−", "-"), ("≥", ">="), ("≤", "<="), ("→", "->"), ("…", "..."), ("’", "'"), ("‘", "'"),
                 ("“", '"'), ("”", '"')):
        s = s.replace(a, b)
    return escape(s)


def _raw(s: str) -> str:
    """Like _t but without XML escaping, for drawing strings."""
    for a, b in (("−", "-"), ("≥", ">="), ("≤", "<="), ("→", "->"), ("…", "..."), ("’", "'")):
        s = s.replace(a, b)
    return s


def _n(v: float, d: int = 0) -> str:
    return f"{v:,.{d}f}"


def _money(v: float, cur: str) -> str:
    return f"${v:,.0f}" if cur == "USD" else f"{cur} {v:,.0f}"


def _pct(new: float, base: float) -> str:
    if abs(base) < 1e-12:
        return "n/a"
    p = (new - base) / base * 100
    return "±0 %" if abs(p) < 0.5 else f"{p:+.0f} %"


def _nice_ticks(hi: float, count: int = 4) -> list[float]:
    if hi <= 0:
        return [0.0, 1.0]
    raw = hi / count
    mag = 10 ** math.floor(math.log10(raw))
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    return [round(i * step, 10) for i in range(int(math.ceil(hi / step - 1e-9)) + 1)]


def _table(rows: list[list], widths: list[float], align_right_from: int = 1, header: bool = True,
           highlight_last: bool = False) -> Table:
    data = [[Paragraph(_t(str(c)), CELL) if isinstance(c, str) and len(c) > 28 else c for c in r] for r in rows]
    t = Table(data, colWidths=widths, hAlign="LEFT")
    style = [
        ("FONT", (0, 0), (-1, -1), "Helvetica", 8.5),
        ("TEXTCOLOR", (0, 0), (-1, -1), INK),
        ("ALIGN", (align_right_from, 0), (-1, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("VALIGN", (0, 0), (-1, 0), "BOTTOM"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]
    if header:
        style += [("FONT", (0, 0), (-1, 0), "Helvetica", 7.5, 9), ("TEXTCOLOR", (0, 0), (-1, 0), MUTED),
                  ("LINEBELOW", (0, 0), (-1, 0), 0.8, AXIS)]
    if highlight_last:
        style += [("FONT", (0, -1), (-1, -1), "Helvetica-Bold", 8.5)]
    t.setStyle(TableStyle(style))
    return t


# ── Drawings ────────────────────────────────────────────────────────────────

def _hatch(x: float, y: float, w: float, h: float, step: float, color, width: float) -> Group:
    """45° hatch lines clipped to a rectangle (ReportLab has no pattern fills)."""
    g = Group()
    c = -h
    while c < w:
        pts = []
        # Line u - v = c in local coords (u along x, v along y), clipped to [0,w]x[0,h].
        for u, v in ((c, 0), (w, w - c), (c + h, h), (0, -c)):
            if -1e-9 <= u <= w + 1e-9 and -1e-9 <= v <= h + 1e-9:
                pts.append((u, v))
        if len(pts) >= 2:
            (u1, v1), (u2, v2) = pts[0], pts[-1]
            g.add(Line(x + u1, y + v1, x + u2, y + v2, strokeColor=color, strokeWidth=width))
        c += step
    return g


def site_plan(project: Project, design: Design | None, width: float = CONTENT_W, max_h: float = 3.6 * inch) -> Drawing:
    site = project.site
    pad = 14
    scale = min((width - 2 * pad) / site.width_m, (max_h - 2 * pad - 22) / site.height_m)
    w, h = site.width_m * scale, site.height_m * scale
    foot = 38  # scale bar row + legend row under the map
    d = Drawing(width, h + 2 * pad + foot)
    ox, oy = (width - w) / 2, pad + foot

    def X(m: float) -> float:
        return ox + m * scale

    def Y(m: float) -> float:  # site y grows downwards
        return oy + h - m * scale

    d.add(Rect(ox - 6, oy - 6, w + 12, h + 12, fillColor=MAP_BG, strokeColor=None, rx=4, ry=4))
    for s in site.surfaces:
        r = s.rect
        d.add(Rect(X(r.x), Y(r.y2), r.width * scale, r.height * scale, fillColor=KIND[s.kind.value],
                   strokeColor=colors.white, strokeWidth=0.6))
    if design:
        for item in design.interventions:
            r = item.rect
            x, y, rw, rh = X(r.x), Y(r.y2), r.width * scale, r.height * scale
            fill, stroke = LID_STYLE[item.kind]
            if isinstance(item, PermeablePavement):
                d.add(Rect(x, y, rw, rh, fillColor=PP_FILL, strokeColor=None))
                d.add(_hatch(x, y, rw, rh, 4, PP_STROKE, 0.5))
                d.add(Rect(x, y, rw, rh, fillColor=None, strokeColor=PP_STROKE, strokeWidth=0.8))
            else:
                d.add(Rect(x, y, rw, rh, fillColor=fill, strokeColor=stroke, strokeWidth=0.8))
    nodes = {i.id: (i.x, i.y) for i in site.inlets} | {site.outfall.id: (site.outfall.x, site.outfall.y)}
    for p in site.pipes:
        (x1, y1), (x2, y2) = nodes[p.from_node], nodes[p.to_node]
        d.add(Line(X(x1), Y(y1), X(x2), Y(y2), strokeColor=WATER, strokeWidth=1.4))
    for i in site.inlets:
        d.add(Rect(X(i.x) - 2.5, Y(i.y) - 2.5, 5, 5, fillColor=NODE, strokeColor=colors.white, strokeWidth=0.6))
    d.add(Circle(X(site.outfall.x), Y(site.outfall.y), 3, fillColor=NODE, strokeColor=colors.white, strokeWidth=0.6))

    # Labels: surface names where they fit and aren't covered by an intervention.
    for s in site.surfaces:
        r = s.rect
        name = _raw(s.name)
        tw = len(name) * 4.4
        cx, cy = X(r.x + r.width / 2), Y(r.y + r.height / 2)
        if r.width * scale < tw + 6 or r.height * scale < 22:
            continue
        covered = design and any(
            not (X(i.rect.x2) < cx - tw / 2 or X(i.rect.x) > cx + tw / 2 or Y(i.rect.y) < cy - 8 or Y(i.rect.y2) > cy + 10)
            for i in design.interventions)
        if covered:
            continue
        light = s.kind.value in ("parking", "road")
        d.add(String(cx, cy + 1, name, fontName="Helvetica-Bold", fontSize=7.5, textAnchor="middle",
                     fillColor=colors.white if light else INK))
        d.add(String(cx, cy - 8, f"{_n(s.area_m2)} m²", fontName="Helvetica", fontSize=6.5, textAnchor="middle",
                     fillColor=colors.white if light else INK2))
    if design:
        for item in design.interventions:
            r = item.rect
            if r.width * scale > 22 and r.height * scale > 9:
                d.add(String(X(r.x + r.width / 2), Y(r.y + r.height / 2) - 2.5, item.id, fontName="Helvetica-Bold",
                             fontSize=6.5, textAnchor="middle", fillColor=colors.white))

    # Scale bar and north arrow.
    m = next((v for v in (5, 10, 20, 25, 50, 100, 200) if v * scale >= 50), 200)
    sx, sy = ox, 24
    d.add(Rect(sx, sy, m * scale / 2, 3.5, fillColor=INK, strokeColor=INK, strokeWidth=0.5))
    d.add(Rect(sx + m * scale / 2, sy, m * scale / 2, 3.5, fillColor=colors.white, strokeColor=INK, strokeWidth=0.5))
    d.add(String(sx + m * scale + 5, sy, f"{m} m", fontName="Helvetica", fontSize=7, fillColor=INK2))
    nx, ny = ox + w - 4, 22
    d.add(Polygon([nx - 4, ny, nx, ny + 11, nx + 4, ny, nx, ny + 3], fillColor=INK, strokeColor=None))
    d.add(String(nx - 9, ny + 2, "N", fontName="Helvetica-Bold", fontSize=7, textAnchor="end", fillColor=INK))

    # Legend.
    lx = ox
    kinds = [k for k in KIND if any(s.kind.value == k for s in site.surfaces)]
    items = [(KIND[k], SURFACE_DEFAULTS[next(s.kind for s in site.surfaces if s.kind.value == k)].label) for k in kinds]
    for cls, (label, _) in KINDS.items():
        if design and any(isinstance(i, cls) for i in design.interventions):
            items.append((LID_STYLE[cls.model_fields["kind"].default][0], label))
    for color, label in items:
        d.add(Rect(lx, 3, 7, 7, fillColor=color, strokeColor=None))
        d.add(String(lx + 10, 4, label, fontName="Helvetica", fontSize=7, fillColor=INK2))
        lx += 16 + len(label) * 3.6
    d.add(Line(lx, 6.5, lx + 12, 6.5, strokeColor=WATER, strokeWidth=1.4))
    d.add(String(lx + 15, 4, "Pipe", fontName="Helvetica", fontSize=7, fillColor=INK2))
    return d


def _active_window(results: list[SimulationResult]) -> tuple[int, int]:
    ts = results[0].series
    n = len(ts.minutes)
    fmax = max(max(r.series.outfall_m3s) for r in results) or 1
    rmax = max(ts.rainfall_mm_hr) or 1

    def active(i: int) -> bool:
        return ts.rainfall_mm_hr[i] > 0.05 * rmax or any(r.series.outfall_m3s[i] > 0.05 * fmax for r in results)

    first = next((i for i in range(n) if active(i)), 0)
    last = next((i for i in range(n - 1, -1, -1) if active(i)), n - 1)
    pad = round(60 / (ts.step_minutes or 5))
    return max(first - pad, 0), min(last + pad, n - 1)


def storm_chart(baseline: SimulationResult, proposed: SimulationResult, width: float = CONTENT_W) -> Drawing:
    rain_h, gap, flow_h, left, right, bottom = 52, 22, 150, 46, 10, 22
    height = rain_h + gap + flow_h + bottom + 10
    d = Drawing(width, height)
    i0, i1 = _active_window([baseline, proposed])
    ts = baseline.series
    mins = ts.minutes[i0:i1 + 1]
    t0, t1 = mins[0], mins[-1]
    iw = width - left - right

    def x(m: float) -> float:
        return left + (m - t0) / max(t1 - t0, 1) * iw

    # Flow panel (bottom).
    fy0 = bottom
    flows = [r.series.outfall_m3s[i0:i1 + 1] for r in (baseline, proposed)]
    fticks = _nice_ticks(max(max(f) for f in flows), 4)
    fmax = fticks[-1]
    for t in fticks:
        y = fy0 + t / fmax * flow_h
        d.add(Line(left, y, width - right, y, strokeColor=AXIS if t == 0 else GRID, strokeWidth=0.5))
        d.add(String(left - 5, y - 2.5, f"{t:.2f}", fontName="Helvetica", fontSize=7, textAnchor="end", fillColor=MUTED))
    d.add(String(left + 4, fy0 + flow_h + 4, "Outfall discharge, m³/s", fontName="Helvetica", fontSize=7, fillColor=INK2))
    for vals, color in zip(flows, (BASELINE, PROPOSED)):
        pts = []
        for m, v in zip(mins, vals):
            pts += [x(m), fy0 + v / fmax * flow_h]
        d.add(PolyLine(pts, strokeColor=color, strokeWidth=1.6, strokeLineJoin=1, strokeLineCap=1))
    hour = 60 * (1 if (t1 - t0) <= 8 * 60 else 3)
    h = math.ceil(t0 / hour) * hour
    while h <= t1:
        d.add(String(x(h), fy0 - 12, f"{h // 60} h", fontName="Helvetica", fontSize=7, textAnchor="middle", fillColor=MUTED))
        h += hour

    # Rain panel (top).
    ry0 = fy0 + flow_h + gap
    rain = ts.rainfall_mm_hr[i0:i1 + 1]
    rticks = _nice_ticks(max(rain), 2)
    rmax = rticks[-1]
    for t in rticks:
        y = ry0 + t / rmax * rain_h
        d.add(Line(left, y, width - right, y, strokeColor=AXIS if t == 0 else GRID, strokeWidth=0.5))
        d.add(String(left - 5, y - 2.5, _n(t), fontName="Helvetica", fontSize=7, textAnchor="end", fillColor=MUTED))
    bw = max(iw / len(mins) - 0.6, 0.4)
    for m, v in zip(mins, rain):
        if v > 0:
            d.add(Rect(x(m) - bw, ry0, bw, v / rmax * rain_h, fillColor=WATER, strokeColor=None, fillOpacity=0.6))
    d.add(String(left + 4, ry0 + rain_h + 4, "Rainfall, mm/h", fontName="Helvetica", fontSize=7, fillColor=INK2))

    # Legend.
    lx = width - right - 210
    for color, label in ((BASELINE, "Baseline"), (PROPOSED, "Design")):
        d.add(Line(lx, ry0 + rain_h + 6.5, lx + 12, ry0 + rain_h + 6.5, strokeColor=color, strokeWidth=1.6))
        d.add(String(lx + 15, ry0 + rain_h + 4, label, fontName="Helvetica", fontSize=7, fillColor=INK2))
        lx += 70
    return d


def month_chart(baseline: LongTermResult, proposed: LongTermResult, width: float = CONTENT_W) -> Drawing:
    """Grouped bars of monthly runoff, existing site vs the design."""
    height, left, right, bottom, top = 150, 46, 10, 20, 14
    d = Drawing(width, height)
    months = baseline.months
    ticks = _nice_ticks(max([m.runoff_m3 for m in months] + [m.runoff_m3 for m in proposed.months] + [1]), 4)
    hi = ticks[-1]
    ih = height - bottom - top
    band = (width - left - right) / max(len(months), 1)
    bw = min((band - 6) / 2, 14)
    for t in ticks:
        y = bottom + t / hi * ih
        d.add(Line(left, y, width - right, y, strokeColor=AXIS if t == 0 else GRID, strokeWidth=0.5))
        d.add(String(left - 5, y - 2.5, _n(t), fontName="Helvetica", fontSize=7, textAnchor="end", fillColor=MUTED))
    for i, (mb, mp) in enumerate(zip(months, proposed.months)):
        x0 = left + i * band + (band - 2 * bw - 2) / 2
        for k, (v, color) in enumerate(((mb.runoff_m3, BASELINE), (mp.runoff_m3, PROPOSED))):
            if v > 0:
                d.add(Rect(x0 + k * (bw + 2), bottom, bw, v / hi * ih, fillColor=color, strokeColor=None))
        label = datetime.strptime(mb.month, "%Y-%m").strftime("%b")
        d.add(String(left + i * band + band / 2, bottom - 11, label, fontName="Helvetica", fontSize=7,
                     textAnchor="middle", fillColor=MUTED))
    lx = width - right - 150
    for color, label in ((BASELINE, "Existing site"), (PROPOSED, "Design")):
        d.add(Rect(lx, height - 9, 7, 7, fillColor=color, strokeColor=None))
        d.add(String(lx + 10, height - 8, label, fontName="Helvetica", fontSize=7, fillColor=INK2))
        lx += 75
    return d


def tradeoff_chart(status: ExploreStatus, design_cost: float | None, design_metric: float | None,
                   width: float = CONTENT_W) -> Drawing:
    height, left, right, bottom, top = 190, 50, 12, 24, 16
    d = Drawing(width, height)
    key = (lambda p: p.runoff_m3) if status.objective == "runoff_volume" else (lambda p: p.peak_m3s)
    base = status.baseline["runoff_m3" if status.objective == "runoff_volume" else "peak_m3s"]
    ys = [key(p) for p in status.points] + [base] + ([design_metric] if design_metric is not None else [])
    lo, hi = min(ys), max(ys)
    span = max(hi - lo, hi * 0.05)
    lo, hi = max(lo - span * 0.08, 0), hi + span * 0.08
    xmax = _nice_ticks(max([p.cost for p in status.points] + [design_cost or 0, 1]), 5)[-1]
    iw, ih = width - left - right, height - top - bottom

    def X(v: float) -> float:
        return left + v / xmax * iw

    def Y(v: float) -> float:
        return bottom + (v - lo) / (hi - lo) * ih

    for t in _nice_ticks(xmax, 5):
        d.add(String(X(t), bottom - 12, f"{t / 1000:,.0f}K" if t >= 1000 else _n(t), fontName="Helvetica",
                     fontSize=7, textAnchor="middle", fillColor=MUTED))
    raw = (hi - lo) / 4
    mag = 10 ** math.floor(math.log10(raw))
    step = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    v = math.ceil(lo / step) * step
    while v <= hi:
        d.add(Line(left, Y(v), width - right, Y(v), strokeColor=GRID, strokeWidth=0.5))
        d.add(String(left - 5, Y(v) - 2.5, f"{v:,.0f}" if step >= 1 else f"{v:.3f}", fontName="Helvetica",
                     fontSize=7, textAnchor="end", fillColor=MUTED))
        v += step
    d.add(Line(left, bottom, width - right, bottom, strokeColor=AXIS, strokeWidth=0.5))
    front = set(status.front_ids)
    for p in status.points:
        if p.id not in front:
            d.add(Circle(X(p.cost), Y(key(p)), 1.6, fillColor=MUTED, strokeColor=None, fillOpacity=0.35))
    fpts = sorted((p for p in status.points if p.id in front), key=lambda p: p.cost)
    if fpts:
        path = [X(fpts[0].cost), Y(key(fpts[0]))]
        for p in fpts[1:]:
            path += [X(p.cost), path[-1], X(p.cost), Y(key(p))]
        d.add(PolyLine(path, strokeColor=PROPOSED, strokeWidth=1.3))
        for p in fpts:
            d.add(Circle(X(p.cost), Y(key(p)), 2.4, fillColor=PROPOSED, strokeColor=colors.white, strokeWidth=0.6))
    d.add(Circle(X(0), Y(base), 3, fillColor=BASELINE, strokeColor=colors.white, strokeWidth=0.6))
    if design_cost is not None and design_metric is not None:
        d.add(Circle(X(design_cost), Y(design_metric), 4.5, fillColor=None, strokeColor=INK, strokeWidth=1))
    unit = "Runoff volume, m³" if status.objective == "runoff_volume" else "Peak outfall discharge, m³/s"
    d.add(String(left, height - 9, unit, fontName="Helvetica", fontSize=7, fillColor=INK2))
    d.add(String(width - right, 2, "Cost", fontName="Helvetica", fontSize=7, textAnchor="end", fillColor=INK2))
    lx = width - right - 260
    for color, label, ring in ((PROPOSED, "Best trade-offs", False), (BASELINE, "Today", False), (INK, "This design", True)):
        if ring:
            d.add(Circle(lx + 3, height - 6.5, 3.2, fillColor=None, strokeColor=color, strokeWidth=1))
        else:
            d.add(Circle(lx + 3, height - 6.5, 2.6, fillColor=color, strokeColor=None))
        d.add(String(lx + 10, height - 9, label, fontName="Helvetica", fontSize=7, fillColor=INK2))
        lx += 22 + len(label) * 3.8
    return d


# ── Document ────────────────────────────────────────────────────────────────

def build_report(project: Project, design: Design, baseline: SimulationResult, proposed: SimulationResult,
                 whatif: list[WhatIfCase] | None = None, explore: ExploreStatus | None = None,
                 generated: datetime | None = None,
                 year: tuple[LongTermResult, LongTermResult] | None = None) -> bytes:
    generated = generated or datetime.now(timezone.utc)
    cur = project.costs.currency
    check = check_design(project.site, design, project.costs, project.constraints)
    sc = project.scenario
    soil = SOILS[project.site.soil]
    b, p = baseline, proposed
    story: list = []

    # ── Page 1: summary ──
    story += [
        Paragraph(_t(project.name), H1),
        Paragraph(_t(f"Green infrastructure assessment: {design.name}"), SUB),
        Spacer(1, 4),
        Paragraph(_t(f"{project.site.name} · {project.site.total_area_m2 / 10_000:.1f} ha · {soil.label.lower()} soil · "
                     f"{_n(sc.depth_mm)} mm {_storm_label(sc)} design storm · generated "
                     f"{generated.strftime('%d %B %Y')}"), SMALL),
        Spacer(1, 12),
    ]
    kept = b.balance.runoff_m3 - p.balance.runoff_m3
    lead = (f"With <b>{_t(design.name)}</b>, <b>{_n(abs(kept))} m³ {'less' if kept >= 0 else 'more'} stormwater</b> "
            f"leaves the site during the design storm ({_pct(p.balance.runoff_m3, b.balance.runoff_m3)} runoff, "
            f"{_pct(p.peak_outfall_m3s, b.peak_outfall_m3s)} peak outfall discharge), for an estimated "
            f"<b>{_money(check.cost, cur)}</b>.")
    story += [Paragraph(lead, LEAD), Spacer(1, 10)]
    kpis = [
        ["", "Existing site", "With design", "Change"],
        ["Runoff volume", f"{_n(b.balance.runoff_m3)} m³", f"{_n(p.balance.runoff_m3)} m³",
         _pct(p.balance.runoff_m3, b.balance.runoff_m3)],
        ["Peak outfall discharge", f"{b.peak_outfall_m3s:.3f} m³/s", f"{p.peak_outfall_m3s:.3f} m³/s",
         _pct(p.peak_outfall_m3s, b.peak_outfall_m3s)],
        ["Soaked into the ground", f"{_n(b.balance.infiltration_m3)} m³", f"{_n(p.balance.infiltration_m3)} m³",
         _pct(p.balance.infiltration_m3, b.balance.infiltration_m3)],
        ["Flooding at drains", f"{_n(b.flooding_volume_m3)} m³", f"{_n(p.flooding_volume_m3)} m³",
         "none" if b.flooding_volume_m3 < 0.5 and p.flooding_volume_m3 < 0.5 else _pct(p.flooding_volume_m3, b.flooding_volume_m3)],
        ["Green infrastructure area", "-", f"{_n(check.total_area_m2)} m²", ""],
        ["Estimated cost", "-", _money(check.cost, cur), f"budget {_money(project.constraints.budget, cur)}"],
    ]
    story += [_table(kpis, [2.2 * inch, 1.55 * inch, 1.55 * inch, 1.6 * inch]), Spacer(1, 14)]
    story += [Paragraph("Site plan with the design", H3), site_plan(project, design)]
    story += [Paragraph(_t("Illustrative layout in metres; north is up. Pipes and drains are shown in blue."), SMALL)]

    # ── Page 2: results ──
    story += [PageBreak(), Paragraph("Storm response", H2),
              Paragraph(_t("Rainfall and the discharge leaving the site through the outfall, around the storm peak."), SMALL),
              Spacer(1, 4), storm_chart(b, p)]
    story += [Paragraph("Where the rain went", H3)]
    bal = [["Depth over the site", "Existing site", "With design"]]
    for label, attr in (("Rainfall", "rainfall_mm"), ("Infiltrated", "infiltration_mm"), ("Ran off", "runoff_mm"),
                        ("Evaporated", "evaporation_mm"), ("Still stored at the end", "storage_change_mm")):
        bal.append([label, f"{getattr(b.balance, attr):.1f} mm", f"{getattr(p.balance, attr):.1f} mm"])
    story += [_table(bal, [2.6 * inch, 1.6 * inch, 1.6 * inch])]

    hosts = check.host_surface
    names = {s.id: s.name for s in project.site.surfaces}
    rows = [["ID", "Type", "Location", "Size", "Area", "Receives runoff from", "Cost"]]
    for i in design.interventions:
        if isinstance(i, CAPTURING):
            src = f"{_n(i.captured_area_m2)} m² of {names.get(i.contributing_surface_id, '?')}"
        elif isinstance(i, PermeablePavement) and i.runon_area_m2:
            src = f"{_n(i.runon_area_m2)} m² run-on"
        else:
            src = "rain on itself"
        size = f"{_n(i.rect.width)} × {_n(i.rect.height)} m" + (f" × {_n(i.height_mm / 1000)} m" if isinstance(i, RainBarrel) else "")
        rows.append([i.id, KINDS[type(i)][0], names.get(hosts.get(i.id, ""), "-"), size,
                     f"{_n(i.rect.area)} m²", src, _money(intervention_cost(i, project.costs), cur)])
    # Water quality: pollutant loads at the outfall and progress on the TSS target.
    q_rows = [["Pollutant", "Baseline", "With the design", "Removed"]]
    tss_removed = None
    for pb in b.pollutants:
        pp = next((x for x in p.pollutants if x.pollutant_id == pb.pollutant_id), None)
        if pp is None:
            continue
        removed = 100 * (1 - pp.outfall_load_kg / pb.outfall_load_kg) if pb.outfall_load_kg > 0 else 0.0
        if pb.pollutant_id == "TSS":
            tss_removed = removed
        q_rows.append([pb.label, f"{pb.outfall_load_kg:.2f} kg", f"{pp.outfall_load_kg:.2f} kg", f"{removed:.0f} %"])
    if len(q_rows) > 1:
        verdict = ("meets" if tss_removed is not None and tss_removed >= quality.TSS_TARGET_PCT else "falls short of")
        story += [KeepTogether([
            Paragraph("Water quality", H3),
            Paragraph(_t(f"The design removes {tss_removed:.0f} % of the sediment (TSS) leaving the site, which {verdict} "
                         f"the {quality.TSS_TARGET_PCT:.0f} % removal many stormwater permits require. Loads use typical "
                         f"urban event mean concentrations; see Assumptions."), BASE),
            _table(q_rows, [2.6 * inch, 1.3 * inch, 1.4 * inch, 1.0 * inch], align_right_from=1)])]

    story += [KeepTogether([Paragraph("The design", H3),
                            _table(rows, [0.45 * inch, 1.2 * inch, 1.15 * inch, 0.85 * inch, 0.7 * inch, 1.65 * inch, 0.9 * inch],
                                   align_right_from=3)])]
    if p.lids:
        rows = [["ID", "Inflow", "Infiltrated", "Overflow", "Stored at end", "Share infiltrated"]]
        for lid in p.lids:
            rows.append([lid.intervention_id, f"{_n(lid.inflow_m3)} m³", f"{_n(lid.infiltration_m3)} m³",
                         f"{_n(lid.surface_outflow_m3)} m³", f"{_n(lid.final_storage_mm)} mm",
                         f"{lid.infiltration_m3 / lid.inflow_m3 * 100:.0f} %" if lid.inflow_m3 > 0 else "-"])
        story += [KeepTogether([Paragraph("How each intervention performed", H3),
                                _table(rows, [0.7 * inch, 1.15 * inch, 1.15 * inch, 1.15 * inch, 1.15 * inch, 1.3 * inch])])]
    rows = [["Drain", "Peak inflow\nexisting", "Peak inflow\ndesign", "Flooding\nexisting", "Flooding\ndesign",
             "Surcharged\nexisting", "Surcharged\ndesign"]]
    inlet_names = {i.id: i.name for i in project.site.inlets}
    pn = {n.node_id: n for n in p.nodes}
    for nb in b.nodes:
        np_ = pn.get(nb.node_id)
        rows.append([f"{nb.node_id} {inlet_names.get(nb.node_id, '')}", f"{nb.peak_inflow_m3s:.3f} m³/s",
                     f"{np_.peak_inflow_m3s:.3f} m³/s" if np_ else "-", f"{_n(nb.flooding_m3)} m³",
                     f"{_n(np_.flooding_m3)} m³" if np_ else "-", f"{nb.surcharge_hours:.1f} h",
                     f"{np_.surcharge_hours:.1f} h" if np_ else "-"])
    story += [KeepTogether([Paragraph("Drainage network", H3),
                            _table(rows, [1.55 * inch, 0.95 * inch, 0.95 * inch, 0.85 * inch, 0.85 * inch, 0.85 * inch, 0.9 * inch])])]

    # ── A whole year, robustness, alternatives, assumptions ──
    # Start a new page only if the drainage table left too little room for the next section.
    story += [CondPageBreak(3.2 * inch), Spacer(1, 8)]
    if year:
        yb, yp = year
        days = round(yb.hours / 24)
        span = "a year" if 360 <= days <= 370 else f"these {days} days"
        tss = lambda r: next((x.outfall_load_kg for x in r.pollutants if x.pollutant_id == "TSS"), 0.0)  # noqa: E731
        source = ("a synthetic year (Poisson rectangular-pulse model), not a measured record"
                  if yb.record_source == "synthetic" else f"the imported record “{yb.record_name}”")
        story += [Paragraph("Over a whole year", H2),
                  Paragraph(_t(f"A continuous SWMM run through {_n(yb.rainfall_mm)} mm of hourly rain over {days} days "
                               f"({source}), with soils and green infrastructure drying out between storms."), SMALL),
                  Spacer(1, 4),
                  Paragraph(_t(f"The site keeps {yb.kept_on_site_pct:.0f} % of the rain out of the pipes today and "
                               f"{yp.kept_on_site_pct:.0f} % with the design: {_n(yb.runoff_m3 - yp.runoff_m3)} m³ less "
                               f"runoff over {span}."), BASE),
                  Spacer(1, 4),
                  _table([["", "Existing site", "With the design", "Change"],
                          ["Rain kept on site", f"{yb.kept_on_site_pct:.0f} %", f"{yp.kept_on_site_pct:.0f} %",
                           f"{yp.kept_on_site_pct - yb.kept_on_site_pct:+.0f} points"],
                          ["Runoff", f"{_n(yb.runoff_m3)} m³", f"{_n(yp.runoff_m3)} m³", _pct(yp.runoff_m3, yb.runoff_m3)],
                          ["Sediment (TSS) to the creek", f"{_n(tss(yb))} kg", f"{_n(tss(yp))} kg", _pct(tss(yp), tss(yb))],
                          ["Days water left the site", _n(yb.outflow_days), _n(yp.outflow_days),
                           f"{yp.outflow_days - yb.outflow_days:+d} days"]],
                         [2.2 * inch, 1.55 * inch, 1.55 * inch, 1.6 * inch]),
                  Spacer(1, 6), Paragraph("Runoff by month, m³", H3), month_chart(yb, yp), Spacer(1, 10)]
    if whatif:
        story += [Paragraph("What if conditions differ?", H2),
                  Paragraph(_t("The baseline and the design re-run under smaller and bigger storms, and with soil and "
                               "green infrastructure that soak up water more slowly than designed (compaction, "
                               "clogging). Seepage multiplies native-soil and LID infiltration rates."), SMALL), Spacer(1, 4)]
        rows = [["Case", "Rain", "Seepage", "Runoff\nexisting", "Runoff\ndesign", "Change", "Peak, m³/s\ndesign",
                 "Change", "Flooding\ndesign"]]
        for c in whatif:
            rows.append([c.label, f"{_n(c.depth_mm)} mm", f"× {c.infiltration_factor:.2f}", f"{_n(c.baseline.runoff_m3)} m³",
                         f"{_n(c.proposed.runoff_m3)} m³", _pct(c.proposed.runoff_m3, c.baseline.runoff_m3),
                         f"{c.proposed.peak_m3s:.3f}", _pct(c.proposed.peak_m3s, c.baseline.peak_m3s),
                         f"{_n(c.proposed.flooding_m3)} m³"])
        story += [_table(rows, [1.7 * inch, 0.55 * inch, 0.6 * inch, 0.8 * inch, 0.8 * inch, 0.6 * inch, 0.75 * inch, 0.55 * inch, 0.75 * inch])]
        reds = [(c, (c.baseline.runoff_m3 - c.proposed.runoff_m3) / c.baseline.runoff_m3 * 100) for c in whatif
                if c.baseline.runoff_m3 > 0]
        if reds:
            lo_c, lo = min(reds, key=lambda r: r[1])
            hi_c, hi = max(reds, key=lambda r: r[1])
            story += [Spacer(1, 4), Paragraph(_t(f"Runoff reduction ranges from {lo:.0f} % ({lo_c.label.lower()}) to "
                                                 f"{hi:.0f} % ({hi_c.label.lower()})."), BASE)]

    if explore and explore.points and explore.baseline:
        metric = "runoff volume" if explore.objective == "runoff_volume" else "peak outfall discharge"
        dm = p.balance.runoff_m3 if explore.objective == "runoff_volume" else p.peak_outfall_m3s
        story += [Paragraph("Alternatives from the Design Explorer", H2),
                  Paragraph(_t(f"{explore.evaluated} layouts were simulated, searching for the lowest {metric} at each "
                               f"cost. {len(explore.front_ids)} were best trade-offs (no other layout tried was both cheaper "
                               "and better). The ring marks the design in this report."), SMALL),
                  Spacer(1, 4), tradeoff_chart(explore, check.cost, dm)]
        front = sorted((pt for pt in explore.points if pt.id in set(explore.front_ids)), key=lambda q: q.cost)
        pick = front if len(front) <= 8 else [front[round(k * (len(front) - 1) / 7)] for k in range(8)]
        rows = [["Cost", "Runoff", "Change", "Peak flow", "Change", "Rain gardens", "Pavers", "Green roofs"]]
        for pt in pick:
            def summary(cls):
                its = [i for i in pt.design.interventions if isinstance(i, cls)]
                return f"{len(its)} · {_n(sum(i.rect.area for i in its))} m²" if its else "-"
            rows.append([_money(pt.cost, cur), f"{_n(pt.runoff_m3)} m³", _pct(pt.runoff_m3, explore.baseline["runoff_m3"]),
                         f"{pt.peak_m3s:.3f} m³/s", _pct(pt.peak_m3s, explore.baseline["peak_m3s"]),
                         summary(RainGarden), summary(PermeablePavement), summary(GreenRoof)])
        story += [KeepTogether([Paragraph("A selection of best trade-offs", H3),
                                _table(rows, [0.85 * inch, 0.8 * inch, 0.6 * inch, 0.9 * inch, 0.6 * inch, 1.0 * inch, 0.95 * inch, 0.95 * inch])])]

    story += [Paragraph("Assumptions", H2)]
    rows = [["Input", "Value", "Source"],
            ["Design storm", f"{_n(sc.depth_mm)} mm, {_storm_label(sc)}", RAINFALL_REFERENCES[StormPattern(sc.pattern)]],
            ["Native soil", f"{soil.label}: Ksat {soil.ksat_mm_per_hr} mm/h, suction {soil.suction_head_mm} mm, "
                            f"initial deficit {soil.initial_moisture_deficit}", "Rawls, Brakensiek & Miller (1983)"],
            ["Infiltration factor", f"× {sc.infiltration_factor:g}", "Scenario setting"],
            ["Drain time after rain", f"{sc.drain_hours:g} h", "Scenario setting"],
            ["Unit costs", f"rain garden {_money(project.costs.rain_garden_per_m2, cur)}/m², permeable pavement "
                           f"{_money(project.costs.permeable_pavement_per_m2, cur)}/m², green roof "
                           f"{_money(project.costs.green_roof_per_m2, cur)}/m², infiltration trench "
                           f"{_money(project.costs.infiltration_trench_per_m2, cur)}/m², rain barrel "
                           f"{_money(project.costs.rain_barrel_per_m3, cur)}/m³ of tank", "User input (defaults are illustrative)"],
            ["Constraints", f"budget {_money(project.constraints.budget, cur)}; loading ≤ "
                            f"{project.constraints.max_rain_garden_loading_ratio:g}×; run-on ≤ "
                            f"{project.constraints.max_pavement_runon_ratio:g}×; capture within "
                            f"{project.constraints.max_contributing_gap_m:g} m", "User input"],
            ["Rain-garden media", f"Ksat {lid_params.RG_SOIL_KSAT_MM_HR} mm/h, porosity {lid_params.RG_SOIL_POROSITY}",
             "SWMM 5 manual LID guidance"],
            ["Pavement", f"void ratio {lid_params.PP_PAVEMENT_VOID_RATIO}, permeability "
                         f"{_n(lid_params.PP_PAVEMENT_PERMEABILITY_MM_HR)} mm/h", "SWMM 5 manual LID guidance"]]
    rows.append(["Pollutant concentrations", "TSS / TP in runoff, mg/L: " + "; ".join(
        f"{SURFACE_DEFAULTS[k].label.lower()} {v['TSS']:g} / {v['TP']:g}" for k, v in quality.EMC_MG_L.items()
        if any(s.kind == k for s in project.site.surfaces)), quality.QUALITY_REFERENCE])
    if year:
        rows.append(["Year-long rainfall",
                     f"{year[0].record_name}: {_n(year[0].rainfall_mm)} mm over {round(year[0].hours / 24)} days; "
                     "3 mm/day evaporation",
                     SYNTHETIC_REFERENCE if year[0].record_source == "synthetic" else "Imported by the user"])
    used = {type(i) for i in design.interventions}
    if GreenRoof in used:
        rows.append(["Green-roof media", f"Ksat {lid_params.GR_SOIL_KSAT_MM_HR:g} mm/h, porosity {lid_params.GR_SOIL_POROSITY}, "
                     f"field capacity {lid_params.GR_SOIL_FIELD_CAPACITY}; drain mat void fraction "
                     f"{lid_params.GR_DRAINMAT_VOID_FRACTION}", "SWMM 5 manual LID guidance"])
    if InfiltrationTrench in used:
        rows.append(["Trench stone", f"void ratio {lid_params.IT_STORAGE_VOID_RATIO}; seeps at the native soil's Ksat",
                     "SWMM 5 manual LID guidance"])
    if RainBarrel in used:
        rows.append(["Rain barrels", f"drain empties a full tank in {lid_params.RB_DRAIN_HOURS:g} h once open",
                     "RunoffLab assumption"])
    story += [_table([[Paragraph(_t(str(c)), CELL) for c in r] for r in rows], [1.3 * inch, 2.75 * inch, 2.85 * inch],
                     align_right_from=99)]
    rows = [["Surface", "Impervious", "Manning's n", "Depression storage"]]
    for k, v in SURFACE_DEFAULTS.items():
        if any(s.kind == k for s in project.site.surfaces):
            rows.append([v.label, f"{v.impervious_pct:g} %", f"{v.n_overland:g}", f"{v.depression_storage_mm:g} mm"])
    story += [Spacer(1, 6), _table(rows, [2.0 * inch, 1.2 * inch, 1.2 * inch, 1.4 * inch])]

    story += [Paragraph("Reproducibility and limitations", H2)]
    story += [Paragraph(_t(
        f"Simulated with EPA SWMM {b.engine.swmm_version} via PySWMM {b.engine.pyswmm_version} (RunoffLab "
        f"{b.engine.runofflab_version}), dynamic-wave routing. Runoff continuity error {b.balance.continuity_error_pct:.2f} % "
        f"(existing) and {p.balance.continuity_error_pct:.2f} % (design). SWMM input SHA-256: existing "
        f"{b.inp_sha256[:16]}..., design {p.inp_sha256[:16]}...; the same inputs reproduce these numbers exactly."), SMALL),
        Spacer(1, 4),
        Paragraph(_t(
            "Results compare options; they are not a design sign-off. The model is uncalibrated, uses rectangular "
            "geometry and one soil type, and does not model groundwater, water quality or long-term rainfall. "
            "Unit costs are placeholders unless replaced with local figures. Soil parameters: " + SOIL_REFERENCE), SMALL)]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=0.75 * inch,
                            bottomMargin=0.7 * inch, title=f"{project.name} - {design.name}", author="RunoffLab",
                            subject="Stormwater green infrastructure assessment", creator="RunoffLab with EPA SWMM")

    def chrome(canvas, doc_):
        canvas.saveState()
        canvas.setFillColor(ACCENT)
        canvas.rect(0, PAGE_H - 6, PAGE_W, 6, stroke=0, fill=1)
        canvas.setFont("Helvetica-Bold", 8)
        canvas.setFillColor(ACCENT)
        canvas.drawString(MARGIN, PAGE_H - 0.42 * inch, "RunoffLab")
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(MUTED)
        canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 0.42 * inch, _raw(project.name)[:90])
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.5)
        canvas.line(MARGIN, 0.5 * inch, PAGE_W - MARGIN, 0.5 * inch)
        canvas.drawString(MARGIN, 0.34 * inch, f"Generated {generated.strftime('%Y-%m-%d %H:%M UTC')} with EPA SWMM "
                                                f"{b.engine.swmm_version}")
        canvas.drawRightString(PAGE_W - MARGIN, 0.34 * inch, f"Page {doc_.page}")
        canvas.restoreState()

    doc.build(story, onFirstPage=chrome, onLaterPages=chrome)
    return buf.getvalue()


def _storm_label(sc) -> str:
    if sc.pattern == StormPattern.SCS_TYPE_II:
        return "24 h SCS Type II"
    return f"{sc.duration_hr:g} h {'triangular' if sc.pattern == StormPattern.TRIANGULAR else 'uniform'}"
