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
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
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
  runtime: {{ getManifest: () => ({{ name: {name}, host_permissions: {hosts} }}), sendMessage: () => {{}} }},
  storage: {{ local: {{ get: async () => ({{ graphData: {data} }}), set: async () => {{}} }} }},
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
        subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                        "--window-size=1280,800", f"--force-device-scale-factor={SCALE}",
                        "--virtual-time-budget=9000", "--screenshot=" + str(dest),
                        page.as_uri()], check=True, capture_output=True)
    return dest


PANEL_STUB = """window.chrome = {{
  runtime: {{ getManifest: () => ({{ name: {name}, host_permissions: {hosts} }}), sendMessage: (m, cb) => cb && cb(null),
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
    query: async () => [{{ id: 1, url: {taburl}, active: true }}],
    get: async () => ({{ id: 1, status: 'complete' }}),
    create: () => {{}},
    sendMessage: async (id, msg) => (msg && msg.cmd === 'context' ? {ctx} : {{ ok: true }}),
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
        subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                        "--window-size=1280,800", f"--force-device-scale-factor={SCALE}",
                        "--virtual-time-budget=12000", "--screenshot=" + str(dest),
                        page.as_uri()], check=True, capture_output=True)
    return dest



OPTIONS_STUB = """
window.chrome = {{
  runtime: {{ getManifest: () => ({{ name: {name}, version: '0.0.0', host_permissions: {hosts} }}), id: 'shot',
              openOptionsPage: () => {{}}, sendMessage: async () => ({{ ok: true }}),
              onMessage: {{ addListener: () => {{}} }}, lastError: null }},
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
        subprocess.run([CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
                        "--window-size=1280,800", f"--force-device-scale-factor={SCALE}",
                        "--virtual-time-budget=12000", "--screenshot=" + str(dest),
                        page.as_uri()], check=True, capture_output=True)
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
    # «Copertura visiva totale delle feature» - every capability the pages claim should be visible
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
                print(f"  {app}: unchanged, the five published images are still what this renders")
                want = [k for k in want if k not in keys]
    rendered = {}
    if want and not pathlib.Path(CHROME).exists():
        sys.exit("Chrome not found at " + CHROME)
    for shot in SHOTS + PANELS + OPTIONS:
        if shot[0] not in want:
            continue
        dest = (render_options if shot in OPTIONS else render_panel if shot in PANELS else render)(shot)
        out = subprocess.run(["file", "-b", str(dest)], capture_output=True, text=True).stdout.strip()
        ok = "1280 x 800" in out and "RGB" in out and "RGBA" not in out
        print("{:<16} {}  {}".format(shot[0], "ok " if ok else "BAD", out))
        if not ok:
            sys.exit("that is not what the Store accepts - see store/assets.md")
        rendered[shot[0]] = dest
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
