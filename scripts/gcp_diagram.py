"""Tiny SVG builder for Google Cloud style architecture diagrams.

Zones (grey or blue rounded boxes with a label), product cards (official Google Cloud
icons from cloud.google.com/icons, vendored in scripts/assets/gcp-icons), arrows with
numbered badges, and a legend. Icons are inlined as data URIs so each SVG stands alone.
Used by scripts/deploy_agents_diagrams.py.
"""

from __future__ import annotations

import base64
import html
from dataclasses import dataclass
from pathlib import Path

ICONS = Path(__file__).resolve().parent / "assets" / "gcp-icons"
FONT = "'Google Sans','Google Sans Text',Roboto,'Helvetica Neue',Arial,sans-serif"

INK, MUTED, LINE = "#202124", "#5f6368", "#dadce0"
BLUE, BLUE_SOFT, RED, GREEN, AMBER = "#1a73e8", "#e8f0fe", "#d93025", "#188038", "#e37400"
ZONES = {
    "cloud": ("#f8f9fa", "#dadce0"),
    "region": ("#ffffff", "#bdc1c6"),
    "runtime": ("#e8f0fe", "#aecbfa"),
    "external": ("#fef7e0", "#fdd663"),
    "user": ("#f1f3f4", "#dadce0"),
    "deny": ("#fce8e6", "#f6aea9"),
    "ok": ("#e6f4ea", "#a8dab5"),
}


def esc(text: str) -> str:
    return html.escape(text, quote=True)


@dataclass
class Box:
    x: float
    y: float
    w: float
    h: float

    def anchor(self, side: str, offset: float = 0.5) -> tuple[float, float]:
        if side == "l":
            return self.x, self.y + self.h * offset
        if side == "r":
            return self.x + self.w, self.y + self.h * offset
        if side == "t":
            return self.x + self.w * offset, self.y
        return self.x + self.w * offset, self.y + self.h


class Diagram:
    def __init__(self, width: int, height: int, title: str):
        self.w, self.h, self.title = width, height, title
        self.back: list[str] = []   # zones
        self.mid: list[str] = []    # edges
        self.front: list[str] = []  # cards, badges, text
        self.boxes: dict[str, Box] = {}
        self._icons: dict[str, str] = {}

    # ---------------------------------------------------------------- primitives
    def icon(self, name: str, x: float, y: float, size: float = 32) -> str:
        if name not in self._icons:
            data = (ICONS / f"{name}.svg").read_bytes()
            self._icons[name] = "data:image/svg+xml;base64," + base64.b64encode(data).decode()
        return f'<image href="{self._icons[name]}" x="{x}" y="{y}" width="{size}" height="{size}"/>'

    def text(self, x: float, y: float, s: str, size: int = 13, color: str = INK, weight: int = 400,
             anchor: str = "start", italic: bool = False) -> None:
        style = ' font-style="italic"' if italic else ""
        self.front.append(
            f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}" '
            f'text-anchor="{anchor}"{style}>{esc(s)}</text>'
        )

    def zone(self, x: float, y: float, w: float, h: float, label: str, kind: str = "cloud",
             icon: str | None = None, dashed: bool = False) -> Box:
        fill, stroke = ZONES[kind]
        dash = ' stroke-dasharray="6 4"' if dashed else ""
        self.back.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" '
                         f'stroke="{stroke}" stroke-width="1.2"{dash}/>')
        tx = x + 14
        if icon:
            self.back.append(self.icon(icon, x + 12, y + 9, 18))
            tx = x + 36
        self.back.append(f'<text x="{tx}" y="{y + 23}" font-size="12.5" fill="{MUTED}" font-weight="500" '
                         f'letter-spacing=".02em">{esc(label)}</text>')
        return Box(x, y, w, h)

    def card(self, key: str, x: float, y: float, title: str, sub: str | None = None,
             icon: str | None = None, w: float = 200, h: float = 58, accent: str | None = None,
             sub2: str | None = None, glyph: str | None = None) -> Box:
        stroke = accent or LINE
        width = 2 if accent else 1
        self.front.append(f'<rect x="{x + 1.5}" y="{y + 2}" width="{w}" height="{h}" rx="8" fill="#000" opacity=".06"/>')
        self.front.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="#fff" '
                          f'stroke="{stroke}" stroke-width="{width}"/>')
        tx = x + 14
        if icon:
            self.front.append(self.icon(icon, x + 12, y + (h - 30) / 2, 30))
            tx = x + 52
        elif glyph:
            self.front.append(self._glyph(glyph, x + 12, y + (h - 30) / 2))
            tx = x + 52
        lines = [title] + [s for s in (sub, sub2) if s]
        total = 16 + 15 * (len(lines) - 1)
        ty = y + (h - total) / 2 + 12
        self.text(tx, ty, title, 13.5, INK, 500)
        for i, s in enumerate(lines[1:], start=1):
            self.text(tx, ty + 15 * i + 1, s, 11.5, MUTED)
        box = Box(x, y, w, h)
        self.boxes[key] = box
        return box

    def _glyph(self, kind: str, x: float, y: float) -> str:
        """Simple neutral glyphs for things without an official product icon."""
        c = MUTED
        if kind == "person":
            return (f'<g fill="none" stroke="{c}" stroke-width="2"><circle cx="{x + 15}" cy="{y + 10}" r="6"/>'
                    f'<path d="M{x + 4} {y + 29} a11 11 0 0 1 22 0"/></g>')
        if kind == "calendar":
            return (f'<g fill="none" stroke="{c}" stroke-width="2"><rect x="{x + 3}" y="{y + 6}" width="24" height="21" rx="3"/>'
                    f'<path d="M{x + 3} {y + 13} h24 M{x + 9} {y + 3} v6 M{x + 21} {y + 3} v6"/></g>')
        if kind == "terminal":
            return (f'<g fill="none" stroke="{c}" stroke-width="2"><rect x="{x + 2}" y="{y + 5}" width="26" height="20" rx="3"/>'
                    f'<path d="M{x + 7} {y + 11} l4 4 -4 4 M{x + 14} {y + 20} h7"/></g>')
        if kind == "doc":
            return (f'<g fill="none" stroke="{c}" stroke-width="2"><path d="M{x + 6} {y + 3} h13 l6 6 v19 h-19 z"/>'
                    f'<path d="M{x + 10} {y + 15} h11 M{x + 10} {y + 20} h11"/></g>')
        if kind == "check":
            return (f'<g fill="none" stroke="{GREEN}" stroke-width="2.4"><circle cx="{x + 15}" cy="{y + 15}" r="12"/>'
                    f'<path d="M{x + 9} {y + 15} l4 4 8 -8"/></g>')
        if kind == "loop":
            return (f'<g fill="none" stroke="{c}" stroke-width="2"><path d="M{x + 6} {y + 15} a9 9 0 1 1 3 7"/>'
                    f'<path d="M{x + 3} {y + 18} l3 4 4 -3"/></g>')
        raise ValueError(kind)

    def badge(self, x: float, y: float, n: int | str, color: str = BLUE) -> None:
        self.front.append(f'<circle cx="{x}" cy="{y}" r="11" fill="{color}"/>'
                          f'<text x="{x}" y="{y + 4.3}" font-size="12" font-weight="700" fill="#fff" '
                          f'text-anchor="middle">{esc(str(n))}</text>')

    def edge(self, a: str | tuple[float, float], b: str | tuple[float, float], sa: str = "r", sb: str = "l",
             num: int | str | None = None, label: str | None = None, dashed: bool = False,
             blocked: bool = False, via: list[tuple[float, float]] | None = None, color: str | None = None,
             oa: float = 0.5, ob: float = 0.5, badge_at: float = 0.5, label_dy: float = -8,
             both: bool = False) -> None:
        p1 = self.boxes[a].anchor(sa, oa) if isinstance(a, str) else a
        p2 = self.boxes[b].anchor(sb, ob) if isinstance(b, str) else b
        pts = [p1, *(via or []), p2]
        col = color or (RED if blocked else MUTED)
        dash = ' stroke-dasharray="5 4"' if dashed else ""
        d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts)
        marker = "arrow-red" if blocked else ("arrow-blue" if col == BLUE else "arrow")
        start = f' marker-start="url(#{marker}-start)"' if both else ""
        self.mid.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="1.6"{dash} '
                        f'marker-end="url(#{marker})"{start}/>')
        # badge / label on the longest segment
        segs = list(zip(pts, pts[1:], strict=False))
        (x1, y1), (x2, y2) = max(segs, key=lambda s: abs(s[1][0] - s[0][0]) + abs(s[1][1] - s[0][1]))
        mx, my = x1 + (x2 - x1) * badge_at, y1 + (y2 - y1) * badge_at
        if blocked:
            self.front.append(f'<circle cx="{mx}" cy="{my}" r="11" fill="#fff" stroke="{RED}" stroke-width="2"/>'
                              f'<path d="M{mx - 5} {my - 5} l10 10 M{mx + 5} {my - 5} l-10 10" stroke="{RED}" stroke-width="2.4"/>')
        elif num is not None:
            self.badge(mx, my, num)
        if label:
            horizontal = abs(x2 - x1) >= abs(y2 - y1)
            if horizontal:
                self.text(mx, my + label_dy - (8 if (num is not None or blocked) else 0), label, 11.5, MUTED, 400, "middle")
            else:
                self.text(mx + 16, my + 4, label, 11.5, MUTED, 400, "start")

    def line(self, pts: list[tuple[float, float]], color: str = MUTED, width: float = 1.6, dashed: bool = False) -> None:
        """A plain connector without an arrowhead (for example a bus to several destinations)."""
        dash = ' stroke-dasharray="5 4"' if dashed else ""
        d = "M" + " L".join(f"{x:.1f} {y:.1f}" for x, y in pts)
        self.mid.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}"{dash}/>')

    def legend(self, x: float, y: float, items: list[str], width: float, title: str | None = None,
               start: int = 1) -> float:
        """Numbered steps below or beside the drawing. Returns the y after the last line."""
        if title:
            self.text(x, y, title, 12.5, MUTED, 500)
            y += 20
        for i, item in enumerate(items, start=start):
            self.badge(x + 11, y - 4, i)
            self.text(x + 30, y, item, 12.5, INK)
            y += 26
        return y

    # ---------------------------------------------------------------- output
    def svg(self) -> str:
        defs = "".join(
            f'<marker id="{name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
            f'orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{col}"/></marker>'
            f'<marker id="{name}-start" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
            f'orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{col}"/></marker>'
            for name, col in (("arrow", MUTED), ("arrow-red", RED), ("arrow-blue", BLUE))
        )
        body = "\n".join(self.back + self.mid + self.front)
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" '
            f'height="{self.h}" font-family="{FONT}" role="img" aria-label="{esc(self.title)}">\n'
            f"<title>{esc(self.title)}</title><defs>{defs}</defs>\n"
            f'<rect width="{self.w}" height="{self.h}" fill="#fff"/>\n{body}\n</svg>\n'
        )

    def write(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.svg(), encoding="utf-8")
