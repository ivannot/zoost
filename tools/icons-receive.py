#!/usr/bin/env python3
"""Serves the repository and accepts the PNGs tools/icons.html renders, writing them in place.

There is no SVG rasteriser here and there will not be one; the browser is the renderer. Run this,
open http://localhost:8798/tools/icons.html and press Generate. The favicon is assembled after.
"""
import base64, http.server, json, os, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT  = ROOT

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()
    def do_POST(self):
        n = int(self.headers['content-length'])
        items = json.loads(self.rfile.read(n))
        written = []
        for dest, _size, b64 in items:
            p = (ROOT / dest) if dest.startswith('ico/') else (OUT / dest)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(base64.b64decode(b64))
            written.append(f'{dest} {p.stat().st_size}B')
        body = json.dumps(written).encode()
        self.send_response(200); self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass

os.chdir(ROOT)
http.server.HTTPServer(('127.0.0.1', 8798), H).serve_forever()
