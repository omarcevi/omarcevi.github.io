"""Render index.html in headless Chrome and return the DOM after scripts ran."""
import functools
import http.server
import os
import subprocess
import threading
import unittest

from pagecheck import ROOT

CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


@functools.lru_cache(maxsize=None)
def _server_port():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]


@functools.lru_cache(maxsize=None)
def dump_dom(query=""):
    if not os.path.exists(CHROME):
        raise unittest.SkipTest(f"Chrome not found at {CHROME}")
    url = f"http://127.0.0.1:{_server_port()}/index.html{query}"
    out = subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--virtual-time-budget=5000", "--dump-dom", url],
        capture_output=True, text=True, timeout=90)
    return out.stdout
