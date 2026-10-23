"""Small stdlib helpers for checking index.html's structure in tests."""
import hashlib
import importlib.util
import json
import sys
import types
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class Node:
    def __init__(self, tag, attrs=None, parent=None, data=""):
        self.tag, self.attrs, self.parent, self.data = tag, dict(attrs or {}), parent, data
        self.children = []

    @property
    def classes(self):
        return (self.attrs.get("class") or "").split()

    def elements(self):
        return [c for c in self.children if c.tag not in ("#text", "#comment")]

    def iter(self):
        for c in self.children:
            yield c
            yield from c.iter()

    def text(self):
        if self.tag == "#text":
            return self.data
        if self.tag in ("script", "style", "#comment"):
            return ""
        return "".join(c.text() for c in self.children)

    def __repr__(self):
        return f"<{self.tag} {self.attrs}>"


class _Builder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag, attrs, self.stack[-1]))

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(Node("#text", parent=self.stack[-1], data=data))

    def handle_comment(self, data):
        self.stack[-1].children.append(Node("#comment", parent=self.stack[-1], data=data))


def load_page(path=INDEX):
    return Path(path).read_text(encoding="utf-8")


def parse(html=None):
    b = _Builder()
    b.feed(load_page() if html is None else html)
    return b.root


def find_all(root, tag=None, cls=None, **attrs):
    out = []
    for n in root.iter():
        if n.tag in ("#text", "#comment") or (tag and n.tag != tag) or (cls and cls not in n.classes):
            continue
        if all(n.attrs.get(k.replace("_", "-")) == v for k, v in attrs.items()):
            out.append(n)
    return out


def ml_digest(path=INDEX):
    """The hash scripts/ml_figures.py stamps into assets/ml/source.sha, without numpy installed."""
    for name in ("numpy", "regex"):
        sys.modules.setdefault(name, types.ModuleType(name))
    sys.path.insert(0, str(ROOT / "scripts"))
    spec = importlib.util.spec_from_file_location("ml_figures", ROOT / "scripts" / "ml_figures.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    page = mod.read_page(Path(path))
    return hashlib.sha256(json.dumps(page, sort_keys=True).encode()).hexdigest()[:16]
