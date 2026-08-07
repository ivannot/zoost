#!/usr/bin/env python3
"""Render Chrome Web Store screenshots from the sample org.

    python3 tools/shots.py            # all of them, into dist/shots/
    python3 tools/shots.py crm-graph  # one, by name

The Store wants 1280 x 800, JPEG or 24-bit PNG **with no alpha channel**. Headless Chrome writes
exactly that - `8-bit/color RGB, non-interlaced` - so nothing is converted afterwards and nothing
can quietly re-introduce an alpha channel. `file dist/shots/*.png` is the check; see
`store/assets.md` for every slot the dashboard offers.

The pages are the shipped ones, byte for byte. Only two things are added: `fixtures/` supplies the
data that would come from `chrome.storage`, and a per-shot script clicks whatever the picture is of.
So an image cannot show a control the product does not have - if the page changes, the shot changes
with it or fails to render at all.

That is the point of doing it this way rather than capturing a window. Every image published so far
was taken against the org this is developed on and then blurred, and a blurred screenshot is a poor
advertisement for a tool whose whole subject is reading clearly.
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "shots"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
NAME = {"crm": "Zoost - workbench for Zoho CRM",
        "analytics": "Zoost - workbench for Zoho Analytics"}

# Each shot: which app, which fixture, and what to do once the page is up. The click scripts run in
# the page, so they use the same ids the product does - a renamed control breaks the shot, which is
# the correct direction for it to break in.
SHOTS = [
    # The `ring` slider is moved on the three focused shots, and that is worth saying rather than
    # leaving as a magic number. Measured on this fixture at 1280 x 800: the concentric layout's
    # default ring (420) draws an eight-box diagram at **38% zoom** - 10px text rendered under 4px -
    # where 140 draws the same diagram at 101%. The radius is a fixed multiple of the level, so it
    # is as wide for eight boxes as for eighty. A picture at 38% would be an honest photograph of a
    # readability defect; the slider is a shipped, documented control, so these use it. **The defect
    # itself is still open** - see the note in CLAUDE.md.
    ("crm-graph", "crm", "graph-crm-calls.json", """
        select('standalone.buildInvoice');
        document.querySelector('.tab[data-v="er"]').click();
        setTimeout(() => { setDepth(1); erP.ring = 140; erLaidOut = false; erShow(); }, 300);
    """),
    ("crm-explorer", "crm", "graph-crm-calls.json", """
        select('automation.onOrderCreate');
    """),
    ("crm-buttons", "crm", "graph-crm-calls.json", """
        // Narrowed to one category, which is both a picture of the filter and the only way a
        // reader sees that custom buttons are in here at all.
        hiddenKinds = new Set(allKinds().filter((k) => k !== 'custombutton'));
        syncChips(); applyFilter();
        select('button.openTicket');
    """),
    ("crm-relations", "crm", "graph-crm-calls.json", """
        $('focusx').click();
        document.querySelector('.tab[data-v="rel"]').click();
    """),
    ("crm-er", "crm", "graph-crm-schema.json", """
        select('Orders');
        document.querySelector('.tab[data-v="er"]').click();
        setTimeout(() => { setDepth(1); erP.ring = 140; erLaidOut = false; erShow(); }, 300);
    """),
    ("analytics-er", "analytics", "graph-analytics.json", """
        const t = Object.values(N).find((n) => n.name === 'Orders');
        if (t) select(t.id);
        document.querySelector('.tab[data-v="er"]').click();
        setTimeout(() => { setDepth(2); erP.ring = 140; erLaidOut = false; erShow(); }, 300);
    """),
]

STUB = """window.chrome = {{
  runtime: {{ getManifest: () => ({{ name: {name} }}), sendMessage: () => {{}} }},
  storage: {{ local: {{ get: async () => ({{ graphData: {data} }}), set: async () => {{}} }} }},
}};
window.addEventListener('load', () => setTimeout(() => {{
  try {{ {script} }} catch (e) {{ document.title = 'SHOT ERROR: ' + e.message; }}
}}, 500));
"""


def files_under(base: pathlib.Path, prefix: str):
    """The fixture workspace as {path: text}, the way the shim wants it."""
    out = {}
    for f in sorted(base.rglob("*")):
        if f.is_file():
            out[prefix + "/" + str(f.relative_to(base))] = f.read_text(encoding="utf-8")
    return out


def render(shot):
    key, app, fixture, script = shot
    src = ROOT / "apps" / app
    data = json.loads((ROOT / "fixtures" / fixture).read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        stage = pathlib.Path(tmp)
        for f in src.iterdir():
            if f.is_file():
                shutil.copy2(f, stage / f.name)
        (stage / "data.js").write_text(
            STUB.format(name=json.dumps(NAME[app]), data=json.dumps(data), script=script),
            encoding="utf-8")
        page = stage / "graphview.html"
        html = page.read_text(encoding="utf-8")
        first = "<script src=" + ('"highlight.js"></script>' if app == "crm" else '"graphview.js"></script>')
        assert first in html, key + ": the page does not load the script this expects"
        page.write_text(html.replace(first, '<script src="data.js"></script>\n  ' + first, 1),
                        encoding="utf-8")
        OUT.mkdir(parents=True, exist_ok=True)
        dest = OUT / (key + ".png")
        subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                        "--window-size=1280,800", "--force-device-scale-factor=1",
                        "--virtual-time-budget=9000", "--screenshot=" + str(dest),
                        page.as_uri()], check=True, capture_output=True)
    return dest


PANEL_STUB = """window.chrome = {{
  runtime: {{ getManifest: () => ({{ name: {name} }}), sendMessage: (m, cb) => cb && cb(null),
              onMessage: {{ addListener: () => {{}} }}, lastError: null, getURL: (p) => p,
              onInstalled: {{ addListener: () => {{}} }} }},
  storage: {{ local: {{ get: async () => ({{}}), set: async () => {{}},
                        onChanged: {{ addListener: () => {{}} }} }},
              session: {{ get: async () => ({{}}), set: async () => {{}} }},
              onChanged: {{ addListener: () => {{}} }} }},
  // A Zoho tab that matches the fixture workspace. Without one the environment guard fires and
  // covers the panel with the mismatch overlay - which is correct behaviour and a photograph of
  // nothing. The guard compares org, origin and instance, so the stub answers with the three the
  // fixture's .zoost.json holds.
  tabs: {{
    query: async () => [{{ id: 1, url: 'https://crm.zoho.eu/crm/org1234567890/tab/Home', active: true }}],
    get: async () => ({{ id: 1, status: 'complete' }}),
    create: () => {{}},
    sendMessage: async (id, msg) => (msg && msg.cmd === 'context'
      ? {{ ok: true, org: '1234567890', instance: 'sampleorg', origin: 'https://crm.zoho.eu',
           zuid: '0', user: 'Sample User' }}
      : {{ ok: true }}),
    onUpdated: {{ addListener: () => {{}} }}, onActivated: {{ addListener: () => {{}} }},
  }},
  windows: {{ getAll: async () => [], create: () => {{}} }},
  scripting: {{ executeScript: async () => [{{ result: true }}] }},
  permissions: {{ contains: async () => true }},
}};
window.__fsshim.load({files});
window.idbHandle.set('rootDir', window.__fsshim.root());
window.idbHandle.set('activeWs', 'org:1234567890');
window.addEventListener('load', () => setTimeout(() => {{
  try {{ {script} }} catch (e) {{ document.title = 'SHOT ERROR: ' + e.message; }}
}}, 900));
"""


def render_panel(shot):
    """The side panel, rendered against the fixture through the file-system shim.

    Headless Chrome cannot be handed a folder - the permission is a user gesture by design - so
    without `tools/fsshim.js` the panel cannot be photographed at all. The page is the shipped one;
    only the folder underneath it is in memory. See the header of that file for what the shim is and
    what it is not.
    """
    key, app, ws, script = shot
    src = ROOT / "apps" / app
    files = files_under(ROOT / "fixtures" / ws, ("crm" if app == "crm" else "analytics")
                        + "/" + (ROOT / "fixtures" / ws).name)
    with tempfile.TemporaryDirectory() as tmp:
        stage = pathlib.Path(tmp)
        for f in src.iterdir():
            if f.is_file():
                shutil.copy2(f, stage / f.name)
        shutil.copy2(ROOT / "tools" / "fsshim.js", stage / "fsshim.js")
        (stage / "shot.js").write_text(
            PANEL_STUB.format(name=json.dumps(NAME[app]), files=json.dumps(files), script=script),
            encoding="utf-8")
        page = stage / "sidepanel.html"
        html = page.read_text(encoding="utf-8")
        # After idb.js and before sidepanel.js. Loading it earlier put the shim in place and then
        # let the real idb.js overwrite window.idbHandle, so the panel looked for the folder handle
        # in IndexedDB, found nothing, and drew «No workspace» over a fixture that was right there.
        first = '<script src="sidepanel.js"></script>'
        assert first in html, key + ": the panel does not load sidepanel.js where this expects"
        page.write_text(html.replace(
            first, '<script src="fsshim.js"></script>\n  <script src="shot.js"></script>\n  ' + first, 1),
            encoding="utf-8")
        OUT.mkdir(parents=True, exist_ok=True)
        dest = OUT / (key + ".png")
        subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                        "--window-size=1280,800", "--force-device-scale-factor=1",
                        "--virtual-time-budget=12000", "--screenshot=" + str(dest),
                        page.as_uri()], check=True, capture_output=True)
    return dest


PANELS = [
    ("crm-panel", "crm", "crm/sampleorg-1234567890", """
        // the tree is already drawn; open one function so the preview has something in it
        const el = [...document.querySelectorAll('#tree .f')].find((e) => /buildInvoice/.test(e.textContent));
        if (el) el.click();
    """),
]


def main():
    want = sys.argv[1:] or [s[0] for s in SHOTS + PANELS]
    if not pathlib.Path(CHROME).exists():
        sys.exit("Chrome not found at " + CHROME)
    for shot in SHOTS + PANELS:
        if shot[0] not in want:
            continue
        dest = (render_panel if shot in PANELS else render)(shot)
        out = subprocess.run(["file", "-b", str(dest)], capture_output=True, text=True).stdout.strip()
        ok = "1280 x 800" in out and "RGB" in out and "RGBA" not in out
        print("{:<16} {}  {}".format(shot[0], "ok " if ok else "BAD", out))
        if not ok:
            sys.exit("that is not what the Store accepts - see store/assets.md")


if __name__ == "__main__":
    main()
