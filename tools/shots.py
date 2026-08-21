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
import atexit
import socket
import urllib.request
import os
import pathlib
import shutil
import subprocess
import sys
import concurrent.futures
import time
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def hosts_of(app: str) -> str:
    """The app's real host_permissions, for the stubbed getManifest().

    The stub answered with the name and nothing else, so a panel that *derives* anything from its
    manifest - the data-centre picklist does - rendered empty here and only here. A shim is an
    approximation and says so; an approximation that silently drops a field the product reads is a
    picture of a state the product does not have.
    """
    import json as _json
    m = _json.loads((ROOT / 'apps' / app / 'manifest.json').read_text(encoding='utf-8'))
    return _json.dumps(m.get('host_permissions', []))
OUT = ROOT / "dist" / "shots"
def _chrome() -> str:
    """Where Chrome is. It was one macOS path, which is the whole of what stopped these tools
    running anywhere else - the renders, the graph payloads and every headless probe go through it.
    `CHROME` wins, from the environment or from `tools/machine.env`, so a machine with it somewhere
    odd records that once in the one file this repository keeps such values in, rather than exporting
    it into every session. The macOS location below is a probe guarded by `is_file()`, not an
    assumption."""
    import shutil
    import machine
    if machine.get("CHROME"):
        return machine.get("CHROME")
    mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if pathlib.Path(mac).is_file():
        return mac
    for exe in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        found = shutil.which(exe)
        if found:
            return found
    sys.exit("no Chrome found - install one, or set CHROME to its path")


# Resolved on first use, never at import, and the difference is not style. `tools_test.py` imports
# this file - through imgcheck, and directly - so exiting here took the whole Python battery down on
# any machine without a browser: an outside reviewer cloning the repository saw thirty errors and one
# failure, and had to work out whether the product was broken or a browser was missing. That is a
# verdict that depends on the machine, which is the thing this repository refuses everywhere else -
# and the suite already knows how to say «skipped». It says it here too now.
_CHROME = None


def chrome() -> str:
    """Where Chrome is, or a clean exit saying so - asked at the moment one is needed."""
    global _CHROME
    if _CHROME is None:
        _CHROME = _chrome()
    return _CHROME


def have_chrome() -> bool:
    """Is there one at all? For a caller that would rather skip than stop."""
    global _CHROME
    if _CHROME is not None:
        return True
    try:
        _CHROME = _chrome()
        return True
    except SystemExit:
        return False
NAME = {"crm": "Zoost - workbench for Zoho CRM",
        "analytics": "Zoost - workbench for Zoho Analytics"}

# What each Store listing publishes, in order. The dashboard takes **at most five**, shows them in
# the order they are uploaded, and names them nothing - so the file names carry the order and nothing
# else: `crm_1.png` .. `crm_5.png`. A descriptive name is a name somebody has to keep in step with a
# slot number, and the slot number is the only thing the Store actually knows about.
#
# The order is a rule rather than a preference. **The first is the interface** - the panel with a
# workspace open, which is what somebody sees the moment the product is working, and it is the image
# the Store uses as the thumbnail. Then the other screens of the interface, then the diagrams, which
# are the least self-explanatory and the most impressive once the rest has been understood. Five
# slots against eighteen renders means choosing: what is left out is the settings page, the exports,
# the search and the assistant, because none of them is what the product *is*.
STORE = {
    'crm': ['crm-panel', 'crm-modules', 'crm-health', 'crm-er', 'crm-graph'],
    'analytics': ['analytics-panel', 'analytics-columns', 'analytics-lineage', 'analytics-er',
                  'analytics-health'],
}

# Each shot: which app, which fixture, and what to do once the page is up. The click scripts run in
# the page, so they use the same ids the product does - a renamed control breaks the shot, which is
# the correct direction for it to break in.
SHOTS = [
    # These three used to move the `ring` slider, because the concentric radius was a fixed multiple
    # of the level and drew an eight-box diagram at 38% zoom - 10px text under 4px. Photographing
    # that meant either publishing the defect or reaching for a control the reader would have to find
    # for themselves, and the comment here said as much for as long as it lasted. The radii are
    # derived from the boxes now and the slider is gone, so what these render is the default: the
    # picture and the product agree without anything being set up.
    ("crm-graph", "crm", "graph-crm-calls.json", """
        select('standalone.buildInvoice');
        document.querySelector('.tab[data-v="er"]').click();
        setTimeout(() => { setDepth(1); erLaidOut = false; erShow(); }, 300);
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
        setTimeout(() => { setDepth(1); erLaidOut = false; erShow(); }, 300);
    """),
    ("analytics-er", "analytics", "graph-analytics.json", """
        const t = Object.values(N).find((n) => n.name === 'Orders');
        if (t) select(t.id);
        document.querySelector('.tab[data-v="er"]').click();
        setTimeout(() => { setDepth(2); erLaidOut = false; erShow(); }, 300);
    """),
]

STUB = """// **When is the picture final?** Under `--virtual-time-budget` that question answered itself: the
// clock ran forward, so every timer had already fired by the time the capture happened and one
// number covered every page. Driving a real browser there is no such clock, and guessing from
// outside does not work - a fixed wait left six of twenty-seven images different, and waiting for
// two identical captures left twenty-one, because these pages are perfectly still right after load,
// before the shot script has done anything at all.
//
// So the page answers instead. Every `setTimeout` and `requestAnimationFrame` scheduled from here on
// is counted, and `__zoostPending` is what is left outstanding; the renderer waits for it to reach
// zero. `setInterval` is deliberately not counted - the panel polls its context every few seconds,
// so a counter that included it would never reach zero and the wait would be a wait for the cap.
//
// First in the file, before anything else runs, or the work scheduled by whatever ran earlier is
// invisible to it.
(function pending() {{
  let out = 0;
  const ST = window.setTimeout, RAF = window.requestAnimationFrame;
  window.setTimeout = function (fn, ms) {{
    if (typeof fn !== 'function') return ST.apply(window, arguments);
    out++;
    const rest = Array.prototype.slice.call(arguments, 2);
    return ST.call(window, function () {{
      try {{ fn.apply(this, rest); }} finally {{ out--; }}
    }}, ms);
  }};
  window.requestAnimationFrame = function (fn) {{
    out++;
    return RAF.call(window, function (t) {{
      try {{ fn(t); }} finally {{ out--; }}
    }});
  }};
  Object.defineProperty(window, '__zoostPending', {{ get: () => out }});
}})();
// A screenshot of a running animation is a different screenshot every time: `.spin` rotates for
// ever, the assistant's waiting dots pulse, and a focused search box blinks a caret. Measured on
// crm-health at 2x - five identical renders and a sixth that was not - which is why the published
// WebP kept changing by a few dozen bytes while the picture looked the same. It is also a better
// picture: a frame caught mid-transition shows a state the reader never sits in front of.
(function still() {{
  const css = '*,*::before,*::after{{animation:none!important;transition:none!important;'
    + 'caret-color:transparent!important}}';
  const put = () => {{ const st = document.createElement('style'); st.textContent = css;
    (document.head || document.documentElement).appendChild(st); }};
  put();
  document.addEventListener('DOMContentLoaded', put);
}})();
window.chrome = {{
  runtime: {{ getManifest: () => ({{ name: {name}, host_permissions: {hosts} }}), sendMessage: () => {{}} }},
  // The window reads the drawing from `session` - it is a hand-off, not a setting, and it stopped
  // carrying the Deluge source when it moved there. `local` answers empty, so a page that went back
  // to reading it would draw nothing and the shot would fail, which is the direction to fail in.
  storage: {{ session: {{ get: async () => ({{ graphData: {data} }}), set: async () => {{}} }},
              local: {{ get: async () => ({{}}), set: async () => {{}} }} }},
}};
window.addEventListener('load', () => setTimeout(() => {{
  try {{ {script} }} catch (e) {{ document.title = 'SHOT ERROR: ' + e.message; }}
}}, 500));
"""


# Device pixels per CSS pixel. The Store wants 1280x800 exactly, so this stays 1 here; tools that
# want a retina source for the website set it to 2 before calling, which renders the same layout at
# 2560x1600. It is a variable rather than an argument because both renderers need it and neither
# takes options.
SCALE = 1

# Serial by default, and that is the conclusion rather than the starting point. When every image
# meant its own browser, six at a time took the set from 39 minutes to 8 by overlapping the warm-ups;
# with one browser there is one warm-up and the overlapping buys about a minute - and it costs the
# thing that matters more. Measured: rendered six at a time, two of twenty-seven images came out
# different between two consecutive runs, because concurrent captures contend for the machine and a
# page can look still while it is only starved. Rendered one at a time, two consecutive runs of the
# whole set are identical, image for image. `ZOOST_RENDER_JOBS` still raises it for anyone who wants
# the minute and can live without that.
JOBS = int(os.environ.get("ZOOST_RENDER_JOBS", "1"))


# Every Chrome here gets a profile of its own, and it is worth the paragraph because the cost was
# enormous and completely invisible. Without `--user-data-dir` Chrome uses the single profile under
# ~/.config/google-chrome-headless and takes a singleton lock on it, so a render that starts while the
# previous Chrome has not finished letting go waits for that lock to time out. Measured on the same
# trivial page while another render was alive: **14.66s without a dedicated profile against 0.37s
# with one**. Across the set it showed as a metronome - 101s, 1s, 101s, 1s - and that is what gave it
# away, because work does not take exactly the same number of seconds twice; a timeout does. The
# profile goes inside the staging directory that is already created and removed per shot, so nothing
# survives the run.



# ---- one browser for the whole run -------------------------------------------------------------
#
# `chrome --headless --screenshot` starts a browser per image, and the first capture in any browser
# costs about forty-five seconds here while the compositor produces its first frame; every capture
# after it costs three tenths of a second. That is the whole of the thirty-four minutes this set used
# to take - twenty-seven warm-ups, one per image - and it is why the parallelism that came before this
# helped: it overlapped the waits rather than removing them.
#
# So: one Chrome, kept alive, driven over the DevTools protocol by tools/capture.mjs. The window is
# sized at launch, because that is the only way that produces the same picture - see the note at the
# top of capture.mjs for what emulating the metrics and setting the bounds afterwards each did
# instead. How much taller than its viewport the window has to be is asked of the browser rather than
# written down, since it is a property of the Chrome that happens to be installed.
_browser = None


def _browser_for(width: int, height: int, scale: float):
    """A running Chrome whose page viewport is exactly width x height at this scale."""
    global _browser
    key = (width, height, scale)
    if _browser and _browser[0] == key:
        return _browser[1]
    _browser_stop()
    profile = tempfile.mkdtemp(prefix="zoost-shots-")
    # The window asked for and the viewport wanted are two different numbers, and the first version
    # compared the second attempt's viewport against the *adjusted window* - throwing away the run
    # that had got it exactly right. They are kept apart.
    win_w, win_h = width, height
    seen = "?"
    for _ in range(3):
        with socket.socket() as s:                 # a free port, asked of the operating system
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        proc = subprocess.Popen(
            [chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
             f"--window-size={win_w},{win_h}", f"--force-device-scale-factor={scale}",
             f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ws = _ws_url(port)
        measured = subprocess.run(["node", str(ROOT / "tools" / "capture.mjs"), ws, "--probe"],
                                  capture_output=True, text=True)
        if measured.returncode:
            proc.terminate(); proc.wait(timeout=10)
            raise RuntimeError("viewport probe failed: " + (measured.stderr.strip() or measured.stdout.strip() or "unknown error"))
        seen = measured.stdout.strip()
        w, h = (int(x) for x in seen.split("x"))
        if (w, h) == (width, height):
            _browser = (key, (ws, proc, profile))
            return _browser[1]
        # The window is taller than the page by whatever chrome this build draws. Measured once,
        # applied once, and checked - rather than a constant that a Chrome update would falsify.
        proc.terminate(); proc.wait(timeout=10)
        win_w += width - w
        win_h += height - h
    raise SystemExit(f"could not get a {width}x{height} viewport out of Chrome (last: {seen})")


def _ws_url(port: int) -> str:
    for _ in range(200):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=1) as r:
                return json.load(r)["webSocketDebuggerUrl"]
        except Exception:                          # noqa: BLE001 - it is starting; ask again
            time.sleep(0.05)
    raise SystemExit("Chrome did not open a debugging port")


def _browser_stop():
    global _browser
    if not _browser:
        return
    _, (_, proc, profile) = _browser
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(profile, ignore_errors=True)
    _browser = None


atexit.register(_browser_stop)


def capture(page: pathlib.Path, dest: pathlib.Path, wait_ms: int, width=1280, height=800):
    """One screenshot of a staged page, through the browser that is already running.

    And the page's own verdict on the run, which used to be thrown away. Every stub writes
    `SHOT ERROR: ...` into the title when its click script throws, and nothing had ever read it: a
    panel that failed on load still produced a perfectly good picture of a panel that had not run.
    An uncaught exception counts the same way.

    This is also the browser-level coverage an audit asked for, arriving from a direction that costs
    nothing: the shipped pages are loaded in a real Chrome on every render, so «it loads and its
    scripts run» is now asserted for both panels, both graph windows and both options pages, without
    a test framework and without the project's first dependency.
    """
    ws, _, _ = _browser_for(width, height, SCALE)
    out = subprocess.run(["node", str(ROOT / "tools" / "capture.mjs"), ws, page.as_uri(),
                          str(dest), str(wait_ms)], check=True, capture_output=True, text=True)
    try:
        said = json.loads(out.stdout or "{}")
    except ValueError:
        said = {}
    if said.get("title", "").startswith("SHOT ERROR"):
        raise SystemExit(f"{page.name}: {said['title']}")
    if said.get("errors"):
        raise SystemExit(f"{page.name}: the page logged {len(said['errors'])} error(s): "
                         + " | ".join(said["errors"])[:400])
    return dest


def files_under(base: pathlib.Path, prefix: str):
    """The fixture workspace as {path: text}, the way the shim wants it."""
    out = {}
    for f in sorted(base.rglob("*")):
        if f.is_file():
            out[prefix + "/" + str(f.relative_to(base))] = f.read_text(encoding="utf-8")
    return out


# --- which workspace the pictures show -------------------------------------------------------
#
# The one `+ Sample` writes, and that was not true until it was measured. `fixtures/` is generated
# with `edgeCases: true` - a module Zoho refuses to describe, unresolved names, and a query written
# as unreadable - because the tests need those states to exist. The pictures were rendered from it
# too, so the Analytics listing opened on a greyed «Retry 1 failed» chip, and `site/try.html`
# described a 39-view sample beside a photograph of a 44-view one. Nothing was failing: the shop
# window was photographing the test fixture.
#
# So every picture is the delivered workspace, generated at render time by the same command that
# writes `fixtures/` - one generator, one flag, nothing committed twice.
#
# There is no exception list, and there was going to be one: an audit photographed with nothing to
# report documents nothing, so the figures whose subject is a refusal looked like they had to keep
# the edge-case tree. Measured instead of assumed, and they do not - «Failing in Zoho» still counts
# four and «Wiring» four, because those states are in the sample the product delivers, while what
# `edgeCases` adds is finer than anything a published figure points at. An exception nobody needs is
# a second workspace in the published material and a rule with a hole in it.
_DELIVERED = None


def delivered() -> pathlib.Path:
    """The workspaces as the product hands them over, written once per run."""
    global _DELIVERED
    if _DELIVERED is None:
        d = pathlib.Path(tempfile.mkdtemp(prefix="zoost-delivered-"))
        subprocess.run(["node", str(ROOT / "tools" / "fixtures.mjs"), "--as-delivered", str(d)],
                       check=True, capture_output=True)
        atexit.register(shutil.rmtree, d, True)
        _DELIVERED = d
    return _DELIVERED


def fixtures_for(_key: str) -> pathlib.Path:
    return delivered()


def render(shot):
    key, app, fixture, script = shot
    src = ROOT / "apps" / app
    data = json.loads((fixtures_for(key) / fixture).read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        stage = pathlib.Path(tmp)
        for f in src.iterdir():
            if f.is_file():
                shutil.copy2(f, stage / f.name)
        (stage / "data.js").write_text(
            STUB.format(name=json.dumps(NAME[app]), data=json.dumps(data), script=script,
                        hosts=hosts_of(app)),
            encoding="utf-8")
        page = stage / "graphview.html"
        html = page.read_text(encoding="utf-8")
        first = "<script src=" + ('"highlight.js"></script>' if app == "crm" else '"graphview.js"></script>')
        assert first in html, key + ": the page does not load the script this expects"
        page.write_text(html.replace(first, '<script src="data.js"></script>\n  ' + first, 1),
                        encoding="utf-8")
        OUT.mkdir(parents=True, exist_ok=True)
        dest = OUT / (key + ".png")
        capture(page, dest, 60000)
    return dest


PANEL_STUB = """// **When is the picture final?** Under `--virtual-time-budget` that question answered itself: the
// clock ran forward, so every timer had already fired by the time the capture happened and one
// number covered every page. Driving a real browser there is no such clock, and guessing from
// outside does not work - a fixed wait left six of twenty-seven images different, and waiting for
// two identical captures left twenty-one, because these pages are perfectly still right after load,
// before the shot script has done anything at all.
//
// So the page answers instead. Every `setTimeout` and `requestAnimationFrame` scheduled from here on
// is counted, and `__zoostPending` is what is left outstanding; the renderer waits for it to reach
// zero. `setInterval` is deliberately not counted - the panel polls its context every few seconds,
// so a counter that included it would never reach zero and the wait would be a wait for the cap.
//
// First in the file, before anything else runs, or the work scheduled by whatever ran earlier is
// invisible to it.
(function pending() {{
  let out = 0;
  const ST = window.setTimeout, RAF = window.requestAnimationFrame;
  window.setTimeout = function (fn, ms) {{
    if (typeof fn !== 'function') return ST.apply(window, arguments);
    out++;
    const rest = Array.prototype.slice.call(arguments, 2);
    return ST.call(window, function () {{
      try {{ fn.apply(this, rest); }} finally {{ out--; }}
    }}, ms);
  }};
  window.requestAnimationFrame = function (fn) {{
    out++;
    return RAF.call(window, function (t) {{
      try {{ fn(t); }} finally {{ out--; }}
    }});
  }};
  Object.defineProperty(window, '__zoostPending', {{ get: () => out }});
}})();
// A screenshot of a running animation is a different screenshot every time: `.spin` rotates for
// ever, the assistant's waiting dots pulse, and a focused search box blinks a caret. Measured on
// crm-health at 2x - five identical renders and a sixth that was not - which is why the published
// WebP kept changing by a few dozen bytes while the picture looked the same. It is also a better
// picture: a frame caught mid-transition shows a state the reader never sits in front of.
(function still() {{
  const css = '*,*::before,*::after{{animation:none!important;transition:none!important;'
    + 'caret-color:transparent!important}}';
  const put = () => {{ const st = document.createElement('style'); st.textContent = css;
    (document.head || document.documentElement).appendChild(st); }};
  put();
  document.addEventListener('DOMContentLoaded', put);
}})();
window.chrome = {{
  runtime: {{ getManifest: () => ({{ name: {name}, host_permissions: {hosts} }}), sendMessage: (m, cb) => cb && cb(null),
              onMessage: {{ addListener: () => {{}}, removeListener: () => {{}} }}, lastError: null, getURL: (p) => p,
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
    query: async () => [{{ id: 1, url: {taburl}, active: true }}],
    get: async () => ({{ id: 1, status: 'complete' }}),
    create: () => {{}},
    // The bridge. `context` is answered here because every panel asks for it before anything else;
    // everything else is `{{ ok: true }}` unless the driving script has installed an answer, which is
    // what lets tools/probe.py run a whole pull through the shipped code instead of photographing a
    // mirror somebody else wrote. A shot that installs nothing behaves exactly as it did.
    sendMessage: async (id, msg) => {{
      // `context` too, when the driving script asks for it: a probe that wants to see the panel
      // refuse a mismatched tab has to be able to *move the tab*, and that is the only way to.
      if (msg && msg.cmd === 'context') {{
        const own = window.__bridge && window.__bridge.context;
        return own ? own(msg) : {ctx};
      }}
      const answer = window.__bridge && msg && window.__bridge[msg.cmd];
      return answer ? answer(msg) : {{ ok: true }};
    }},
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
    base = fixtures_for(key) / ws
    files = files_under(base, ("crm" if app == "crm" else "analytics") + "/" + base.name)
    with tempfile.TemporaryDirectory() as tmp:
        stage = pathlib.Path(tmp)
        for f in src.iterdir():
            if f.is_file():
                shutil.copy2(f, stage / f.name)
        shutil.copy2(ROOT / "tools" / "fsshim.js", stage / "fsshim.js")
        taburl, ctx = PANEL_CTX[app]
        (stage / "shot.js").write_text(
            PANEL_STUB.format(name=json.dumps(NAME[app]), files=json.dumps(files), script=script,
                              hosts=hosts_of(app),
                              taburl=json.dumps(taburl), ctx=ctx),
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
        capture(page, dest, 60000)
    return dest



OPTIONS_STUB = """// **When is the picture final?** Under `--virtual-time-budget` that question answered itself: the
// clock ran forward, so every timer had already fired by the time the capture happened and one
// number covered every page. Driving a real browser there is no such clock, and guessing from
// outside does not work - a fixed wait left six of twenty-seven images different, and waiting for
// two identical captures left twenty-one, because these pages are perfectly still right after load,
// before the shot script has done anything at all.
//
// So the page answers instead. Every `setTimeout` and `requestAnimationFrame` scheduled from here on
// is counted, and `__zoostPending` is what is left outstanding; the renderer waits for it to reach
// zero. `setInterval` is deliberately not counted - the panel polls its context every few seconds,
// so a counter that included it would never reach zero and the wait would be a wait for the cap.
//
// First in the file, before anything else runs, or the work scheduled by whatever ran earlier is
// invisible to it.
(function pending() {{
  let out = 0;
  const ST = window.setTimeout, RAF = window.requestAnimationFrame;
  window.setTimeout = function (fn, ms) {{
    if (typeof fn !== 'function') return ST.apply(window, arguments);
    out++;
    const rest = Array.prototype.slice.call(arguments, 2);
    return ST.call(window, function () {{
      try {{ fn.apply(this, rest); }} finally {{ out--; }}
    }}, ms);
  }};
  window.requestAnimationFrame = function (fn) {{
    out++;
    return RAF.call(window, function (t) {{
      try {{ fn(t); }} finally {{ out--; }}
    }});
  }};
  Object.defineProperty(window, '__zoostPending', {{ get: () => out }});
}})();
// A screenshot of a running animation is a different screenshot every time: `.spin` rotates for
// ever, the assistant's waiting dots pulse, and a focused search box blinks a caret. Measured on
// crm-health at 2x - five identical renders and a sixth that was not - which is why the published
// WebP kept changing by a few dozen bytes while the picture looked the same. It is also a better
// picture: a frame caught mid-transition shows a state the reader never sits in front of.
(function still() {{
  const css = '*,*::before,*::after{{animation:none!important;transition:none!important;'
    + 'caret-color:transparent!important}}';
  const put = () => {{ const st = document.createElement('style'); st.textContent = css;
    (document.head || document.documentElement).appendChild(st); }};
  put();
  document.addEventListener('DOMContentLoaded', put);
}})();

window.chrome = {{
  runtime: {{ getManifest: () => ({{ name: {name}, version: '0.0.0', host_permissions: {hosts} }}), id: 'shot',
              openOptionsPage: () => {{}}, sendMessage: async () => ({{ ok: true }}),
              onMessage: {{ addListener: () => {{}}, removeListener: () => {{}} }}, lastError: null }},
  storage: {{ local: {{ get: async (k) => ({stored}), set: async () => {{}}, remove: async () => {{}},
                        onChanged: {{ addListener: () => {{}} }} }},
              session: {{ get: async () => ({{}}), set: async () => {{}} }},
              onChanged: {{ addListener: () => {{}} }} }},
  tabs: {{ query: async () => [], create: () => {{}}, onUpdated: {{ addListener: () => {{}} }} }},
  windows: {{ getAll: async () => [], create: () => {{}} }},
}};
window.idbHandle = {{ get: async () => null, set: async () => {{}} }};
window.addEventListener('load', () => setTimeout(() => {{
  try {{ {script} }} catch (e) {{ document.title = 'SHOT ERROR: ' + e.message; }}
}}, 700));
"""


def render_options(shot):
    """The settings page. It needs no folder and no Zoho tab - only `chrome.storage` for what it
    shows and `idbHandle` for the working-folder row, both stubbed here rather than through the file
    shim, because nothing on this page reads the mirror."""
    key, app, stored, script = shot
    src = ROOT / "apps" / app
    with tempfile.TemporaryDirectory() as tmp:
        stage = pathlib.Path(tmp)
        for f in src.iterdir():
            if f.is_file():
                shutil.copy2(f, stage / f.name)
        (stage / "shot.js").write_text(
            OPTIONS_STUB.format(name=json.dumps(NAME[app]), stored=stored, script=script,
                                hosts=hosts_of(app)),
            encoding="utf-8")
        page = stage / "options.html"
        html = page.read_text(encoding="utf-8")
        first = '<script src="options.js"></script>'
        assert first in html, key + ": the settings page does not load options.js where this expects"
        page.write_text(html.replace(first, '<script src="shot.js"></script>\n  ' + first, 1),
                        encoding="utf-8")
        OUT.mkdir(parents=True, exist_ok=True)
        dest = OUT / (key + ".png")
        capture(page, dest, 60000)
    return dest


# The settings page, which is where the AI engine, the key and the passphrase are chosen - the one
# screen the site describes at length and had no picture of. `stored` is what chrome.storage answers,
# so the shot shows a configured install rather than an empty form.
OPTIONS = [
    ("crm-settings", "crm",
     "{ aicfg: { engine: 'anthropic', anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-ant-...' },"
     " openai: { model: '', apiKey: '' }, maxIter: 20, seedCap: 72000 } }", ""),
    ("analytics-settings", "analytics",
     "{ aicfg: { engine: 'anthropic', anthropic: { model: 'claude-sonnet-4-5', apiKey: 'sk-ant-...' },"
     " openai: { model: '', apiKey: '' }, maxIter: 20, seedCap: 72000 } }", ""),
]

PANEL_CTX = {
    # What the bridge answers for `context`. Without a matching one the environment guard fires and
    # covers the panel - correct behaviour, and a photograph of nothing.
    "crm": ("https://crm.zoho.eu/crm/sampleorg/tab/Home",
            "{ ok: true, org: '1234567890', instance: 'sampleorg', origin: 'https://crm.zoho.eu', zuid: '0' }"),
    "analytics": ("https://analytics.zoho.eu/workspace/99000001",
                  "{ ok: true, workspace: '99000001', origin: 'https://analytics.zoho.eu' }"),
    # It used to be `{ ok: false }` against example.com, so every Analytics panel shot carried an
    # amber «Not on a Zoho Analytics tab» - the off-platform state, photographed and published to the
    # Store. The workspace id is the fixture's own, so the bar now says what it says in use.
}

PANELS = [
    ("crm-sample", "crm", "crm/sampleorg-1234567890", """
        // Start from nothing: clear the shim's tree, then press the button. This is the feature
        // end to end - the files are written by the shipped generator through the shipped panel.
        window.__fsshim.clear();
        loadWorkspaces().then(() => setTimeout(() => {
          document.getElementById('wssample').click();
          setTimeout(() => {
            const el = [...document.querySelectorAll('#tree .f')].find((e) => /buildInvoice/.test(e.textContent));
            if (el) el.click();
          }, 2500);
        }, 400));
    """),
    ("crm-actions", "crm", "crm/sampleorg-1234567890", """
        // What a rule fires, with one open: the kinds grouped, the count of rules beside each row,
        // and the detail showing what the notification sends and which rule sends it.
        const seg = [...document.querySelectorAll('.mseg,#modebar button')].find((b) => /Actions/.test(b.textContent));
        if (seg) seg.click();
        setTimeout(() => {
          const el = [...document.querySelectorAll('#tree .f')].find((e) => /Invoice reminder/.test(e.textContent));
          if (el) el.click();
        }, 1200);
    """),
    ("crm-panel", "crm", "crm/sampleorg-1234567890", """
        // The tree is already drawn; open one function so the preview has something in it.
        // The pattern used to be /uild.nvoice/, which asks for ONE character between «uild» and
        // «nvoice» where the display name «Build invoice» has two - so it matched nothing, silently,
        // and this shot went to the Store as a picture of a list with no selection.
        const el = [...document.querySelectorAll('#tree .f')].find((e) => /Build invoice/.test(e.textContent));
        if (el) el.click();
    """),
    ("crm-modules", "crm", "crm/sampleorg-1234567890", """
        const seg = [...document.querySelectorAll('.seg')].find((s) => /Modules/.test(s.textContent));
        if (seg) seg.click();
        setTimeout(() => {
          const el = [...document.querySelectorAll('#tree .f')].find((e) => /Orders/.test(e.textContent));
          if (el) el.click();
        }, 900);
    """),
    ("analytics-panel", "analytics", "analytics/sample-workspace", """
        // open a query table, so the SQL and the lineage the panel is for are on screen
        setTimeout(() => {
          const el = [...document.querySelectorAll('#list tbody tr')].find((e) => /Revenue_By_Region/.test(e.textContent));
          if (el) el.click();
          setTimeout(() => { const t = [...document.querySelectorAll('.dtab')].find((x) => /SQL/.test(x.textContent)); if (t) t.click(); }, 700);
        }, 1400);
    """),
    ("analytics-columns", "analytics", "analytics/sample-workspace", """
        setTimeout(() => {
          const el = [...document.querySelectorAll('#list tbody tr')].find((e) => /Order_Lines/.test(e.textContent));
          if (el) el.click();
        }, 1400);
    """),

    # --- the screens the site describes and had no picture of -----------------------------------
    # «Total visual coverage of the features» - every capability the pages claim should be visible
    # somewhere, not only described. tools/coverage.py holds the map and reports what is missing.
    ("crm-preview", "crm", "crm/sampleorg-1234567890", """
        // A function open, on its Details tab: who calls it, where it is used, what is failing in
        // Zoho, how big it is. Until the tabs landed this clicked the function and stopped, which
        // rendered the Code tab - byte for byte the same image as crm-panel, published twice under
        // two captions, one of which promised callers and a size the picture no longer showed.
        const el = [...document.querySelectorAll('#tree .f')].find((e) => /Build invoice/.test(e.textContent));
        if (el) el.click();
        setTimeout(() => document.getElementById('pvtab_info').click(), 2000);
    """),
    ("crm-runtime", "crm", "crm/sampleorg-1234567890", """
        // The measured half, beside the static proxies that were the only thing here before.
        document.getElementById('health').click();
        setTimeout(() => { const t = [...document.querySelectorAll('.htab')].find((x) => /Size/.test(x.textContent)); if (t) t.click(); }, 900);
    """),
    ("crm-failures", "crm", "crm/sampleorg-1234567890", """
        // There is no Failures tab - a failure is something that happened to a function, so the list
        // lives in the health view under Functions, next to the other things wrong with them. Which
        // means this shot and crm-health open the same screen, and until the section was scrolled to
        // they were byte-identical: two figures in the guide, one picture, two captions.
        document.getElementById('health').click();
        setTimeout(() => {
          const sec = [...document.querySelectorAll('#healthbody .hsec')]
            .find((x) => /Failing in Zoho/.test(x.textContent));
          // Land the section's title just under the sticky tab row. Computed from where the two
          // actually are rather than from offsetTop and a guessed margin: the first attempt put the
          // heading behind the sticky row, which is a screenshot of a control overlapping a title.
          const body = document.getElementById('healthbody');
          const tabs = document.querySelector('#healthbody .htabs');
          if (sec && tabs) body.scrollTop += sec.getBoundingClientRect().top
            - tabs.getBoundingClientRect().bottom - 8;
        }, 900);
    """),
    ("crm-search", "crm", "crm/sampleorg-1234567890", """
        // Full-text search across every function at once, which Zoho CRM has no way of doing. The
        // first version of this shot searched *names* - `#smode` is the toggle, not a select - and
        // rendered «No matches» under a caption about searching code. A screenshot that advertises
        // a feature by showing it finding nothing is worse than no screenshot.
        document.getElementById('smode').click();          // in: names -> in: code
        const f = document.getElementById('find');
        f.value = 'planShipment'; f.dispatchEvent(new Event('input'));
    """),
    ("crm-health", "crm", "crm/sampleorg-1234567890", """
        document.getElementById('health').click();
    """),
    ("crm-export", "crm", "crm/sampleorg-1234567890", """
        document.getElementById('export').click();   // the dialog that decides what may leave
    """),
    ("crm-ai", "crm", "crm/sampleorg-1234567890", """
        document.getElementById('askai').click();
    """),
    ("crm-workflows", "crm", "crm/sampleorg-1234567890", """
        const seg = [...document.querySelectorAll('.seg')].find((s) => /Workflows/.test(s.textContent));
        if (seg) seg.click();
        setTimeout(() => { const el = document.querySelector('#tree .f'); if (el) el.click(); }, 900);
    """),
    ("crm-connections", "crm", "crm/sampleorg-1234567890", """
        const seg = [...document.querySelectorAll('.seg')].find((s) => /Connections/.test(s.textContent));
        if (seg) seg.click();
        setTimeout(() => { const el = document.querySelector('#tree .f'); if (el) el.click(); }, 900);
    """),
    ("analytics-health", "analytics", "analytics/sample-workspace", """
        setTimeout(() => document.getElementById('health').click(), 1400);
    """),
    ("analytics-export", "analytics", "analytics/sample-workspace", """
        setTimeout(() => document.getElementById('export').click(), 1400);
    """),
    ("analytics-ai", "analytics", "analytics/sample-workspace", """
        setTimeout(() => document.getElementById('askai').click(), 1400);
    """),
    ("analytics-search", "analytics", "analytics/sample-workspace", """
        // The twin of crm-search, one product over: the scope switch on, and a term that is inside
        // the queries rather than in their names - which is the whole difference the switch makes.
        setTimeout(() => {
          document.getElementById('smode').click();
          setTimeout(() => {
            const f = document.getElementById('find');
            f.value = 'JOIN'; f.dispatchEvent(new Event('input'));
          }, 1200);
        }, 1400);
    """),
    ("analytics-lineage", "analytics", "analytics/sample-workspace", """
        setTimeout(() => {
          const el = [...document.querySelectorAll('#list tbody tr')].find((e) => /Revenue_By_Region/.test(e.textContent));
          if (el) el.click();
          setTimeout(() => { const t = [...document.querySelectorAll('.dtab')].find((x) => /Used|Lineage|Depend/i.test(x.textContent)); if (t) t.click(); }, 700);
        }, 1400);
    """),
]


ALL = [(s[0], s) for s in SHOTS + PANELS + OPTIONS]


# Beside the images, not among them: the folder is opened and its contents uploaded in order,
# so anything in it that is not one of the five is a file somebody has to know to skip.
def stamp_file(app: str) -> pathlib.Path:
    return ROOT / "dist" / "store" / ".stamps" / f"{app}.json"


def publish_store_set(rendered: dict) -> None:
    """Copy the published subset to dist/store/<app>_<n>.png, in the declared order.

    The numbering is the whole point: the Store has five slots and no names, so a file called
    `crm-er.png` tells whoever is uploading nothing about which slot it belongs in. It also makes
    «did the screenshots change» answerable - `store/<app>/screenshots.json` records the sha of the
    set that was last uploaded, so a release can say «re-upload these» instead of leaving it to
    memory, which is what left the Analytics listing on one image from its first submission.
    """
    import hashlib
    for app, keys in STORE.items():
        if not all(k in rendered for k in keys):
            continue
        # A folder per product, and the files called nothing but their slot number. Uploading means
        # opening one folder and taking what is in it in order; a shared folder of `crm_3.png` and
        # `analytics_3.png` is a folder you can pick the wrong five from.
        dest = ROOT / "dist" / "store" / app
        dest.mkdir(parents=True, exist_ok=True)
        for stale in dest.glob("*.png"):
            stale.unlink()
        h = hashlib.sha256()
        for n, key in enumerate(keys, 1):
            out = dest / f"{n}.png"
            shutil.copy2(rendered[key], out)
            h.update(out.read_bytes())
        digest = h.hexdigest()[:16]
        from siteimg import source_digest
        f = stamp_file(app); f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({k: source_digest(app, dict(ALL)[k][-1]) for k in keys},
                                indent=2) + "\n", encoding="utf-8")
        ledger = ROOT / "store" / app / "screenshots.json"
        was = json.loads(ledger.read_text(encoding="utf-8")) if ledger.exists() else {}
        state = ("unchanged since the set uploaded for " + was.get("version", "?")
                 if was.get("digest") == digest else
                 "CHANGED since " + was.get("version", "the last upload")
                 + " - upload all five again, in this order")
        print(f"  {app}: dist/store/{app}/1..{len(keys)}.png  [{digest}] {state}")
        # Recording that they *were* uploaded belongs to `tools/submitted.py`, with the ledger
        # row: they are the two facts a submission leaves behind and neither can be observed from
        # here, so one command asks for both instead of two asking for one each.


def current(app: str, keys) -> bool:
    """Is the published set for this app already a picture of what is here?

    The digest is the one `imgstamp` uses - the app's shipped files, its fixture, the click script
    and the renderers - and the stamp sits beside the images it describes, because that is the pair
    that has to stay together: a stamp without its files claims a set that is not there, and files
    without a stamp are a set nobody can date. Missing either means render.
    """
    from siteimg import source_digest
    folder = ROOT / "dist" / "store" / app
    if not all((folder / f"{n}.png").exists() for n in range(1, len(keys) + 1)):
        return False
    try:
        was = json.loads(stamp_file(app).read_text(encoding="utf-8"))
    except Exception:                                    # noqa: BLE001 - absent or unreadable: render
        return False
    by_key = {k: v for k, v in was.items()}
    return all(by_key.get(k) == source_digest(app, dict(ALL)[k][-1]) for k in keys)


def say(*a, **k):
    """Print where the run has got to, immediately - see the note in the loop below for why `flush`
    is the load-bearing half of this."""
    print(*a, flush=True, **k)


def main():
    """No arguments renders what the Store takes; a name renders that one, to be looked at.

    It used to render all twenty-six every time - about three minutes - and twenty-one of them
    produce nothing that survives the run, since `dist/shots/` is working material. What the Store
    needs is ten images, and a set whose sources have not moved is already correct on disk.
    """
    global ALL
    force = "--force" in sys.argv
    named = [a for a in sys.argv[1:] if not a.startswith("--")]
    if named:
        want = named
    else:
        want = [k for keys in STORE.values() for k in keys]
        for app, keys in STORE.items():
            if not force and current(app, keys):
                say(f"  {app}: unchanged, the five published images are still what this renders")
                want = [k for k in want if k not in keys]
    rendered = {}
    if want and not pathlib.Path(chrome()).exists():
        sys.exit("Chrome not found at " + chrome())
    todo = [s for s in SHOTS + PANELS + OPTIONS if s[0] in want]
    bad = []

    def one(i, shot):
        # Named when it starts and again when it ends, both flushed. Printed afterwards - and
        # block-buffered, as stdout is whenever it is not a terminal - the whole run said nothing
        # until it exited, which is indistinguishable from a hung one and was for forty minutes. The
        # elapsed seconds are there because a shot slower than its siblings is the first thing worth
        # knowing; they are what showed the wait this parallelism exists to reclaim.
        say("  [{:>2}/{}] {:<16} …".format(i, len(todo), shot[0]))
        t0 = time.monotonic()
        dest = (render_options if shot in OPTIONS else render_panel if shot in PANELS else render)(shot)
        out = subprocess.run(["file", "-b", str(dest)], capture_output=True, text=True).stdout.strip()
        ok = "1280 x 800" in out and "RGB" in out and "RGBA" not in out
        say("  [{:>2}/{}] {:<16} {}  {}  {:.0f}s".format(
            i, len(todo), shot[0], "ok " if ok else "BAD", out, time.monotonic() - t0))
        if not ok:
            bad.append(shot[0])
        rendered[shot[0]] = dest

    if todo:
        say(f"  rendering {len(todo)} shot(s), {JOBS} at a time")
    with concurrent.futures.ThreadPoolExecutor(max_workers=JOBS) as pool:
        for fut in [pool.submit(one, i, s) for i, s in enumerate(todo, 1)]:
            fut.result()
    if bad:
        sys.exit("that is not what the Store accepts - see store/assets.md: " + ", ".join(bad))
    if not named:
        publish_store_set(rendered)
    # The 1280x800 PNGs are working material: what is published is dist/store/<app>/, and what the
    # site publishes is site/img/. Keeping both meant dist/shots/ sat there afterwards looking like
    # something to upload. A run for one named shot keeps its file - that is what it was asked for.
    if not named:
        for f in OUT.glob('*.png'):
            f.unlink()
        try:
            OUT.rmdir()
        except OSError:
            pass


if __name__ == "__main__":
    main()
