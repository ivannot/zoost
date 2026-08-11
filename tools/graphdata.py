#!/usr/bin/env python3
"""The diagram window's payloads, produced by the panel that produces them in use.

    python3 tools/graphdata.py            # write fixtures/graph-*.json
    python3 tools/graphdata.py --check    # report a difference instead

`tools/fixtures.mjs` used to build these itself, from the same files, "so the two cannot describe
different orgs". They described different orgs anyway - which is the whole argument against a second
implementation, made by the thing itself rather than by anybody's opinion. Its workflow reader looked
for `conditions[].actions`, the key the pull stopped writing when it started writing
`instant_actions.actions`, so **every workflow-to-function edge was missing from the fixture** while
the panel drew nine of them. Nothing said so: both files parsed, both produced a graph, and the
screenshots were of a graph the product does not build.

So the payload is taken from the shipped code, through the shipped page: `tools/fsshim.js` puts the
fixture's own files under the panel, and the panel's `callGraphWithContext()` and `buildSchemaGraph()`
answer. What is written here is what a user's own workspace would put in `chrome.storage`, minus the
one thing that has no business in a repository - the sources, which are already on disk beside it.

It needs Chrome, which is why it is not part of `tools/fixtures.mjs`: that writes the file tree and
stays pure node. Run it after the generator, or after anything that changes what the graph is made of.
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import shots  # noqa: E402  - the staging and the stubs are already written there

# What to ask each panel for, and where the answer goes. The expression runs inside the page with
# every one of the panel's own globals in scope.
PAYLOADS = [
    ('graph-crm-calls.json', 'crm', 'crm/sampleorg-1234567890', 'callGraphWithContext()'),
    ('graph-crm-schema.json', 'crm', 'crm/sampleorg-1234567890', 'buildSchemaGraph()'),
    ('graph-analytics.json', 'analytics', 'analytics/sample-workspace', 'buildSchemaGraph()'),
]
# A source belongs in the workspace, not in a payload committed here: it is tens of kilobytes per
# function of text that is already in fixtures/crm/..., and the window reads it from the node only to
# print it. Dropped after the panel has built the graph, so nothing about the building changes.
HEAVY = ('source_code',)


def payload(app: str, ws: str, expr: str) -> dict:
    src = ROOT / 'apps' / app
    files = shots.files_under(ROOT / 'fixtures' / ws, ws)
    with tempfile.TemporaryDirectory() as tmp:
        stage = pathlib.Path(tmp)
        for f in src.iterdir():
            if f.is_file():
                shutil.copy2(f, stage / f.name)
        shutil.copy2(ROOT / 'tools' / 'fsshim.js', stage / 'fsshim.js')
        taburl, ctx = shots.PANEL_CTX[app]
        script = ("(async () => { try { const g = await %s;"
                  " const d = document.createElement('pre'); d.id = '__out';"
                  " d.textContent = JSON.stringify(g); document.body.appendChild(d); }"
                  " catch (e) { const d = document.createElement('pre'); d.id = '__err';"
                  " d.textContent = String(e && e.message || e); document.body.appendChild(d); } })();") % expr
        (stage / 'shot.js').write_text(
            shots.PANEL_STUB.format(name=json.dumps(shots.NAME[app]), files=json.dumps(files),
                                    script=script, hosts=shots.hosts_of(app),
                                    taburl=json.dumps(taburl), ctx=ctx), encoding='utf-8')
        page = stage / 'sidepanel.html'
        html = page.read_text(encoding='utf-8')
        first = '<script src="sidepanel.js"></script>'
        page.write_text(html.replace(
            first, '<script src="fsshim.js"></script>\n<script src="shot.js"></script>\n' + first, 1),
            encoding='utf-8')
        out = subprocess.run([shots.CHROME, '--headless', '--disable-gpu', '--hide-scrollbars',
                              '--window-size=1280,800', '--virtual-time-budget=20000', '--dump-dom',
                              page.as_uri()], capture_output=True, text=True).stdout
    if 'id="__err"' in out:
        err = out.split('id="__err">', 1)[1].split('</pre>', 1)[0]
        sys.exit(f'{app}: the panel refused to build it - {err}')
    if 'id="__out"' not in out:
        sys.exit(f'{app}: the panel produced nothing - the page did not reach the end of its script')
    g = json.loads(out.split('id="__out">', 1)[1].split('</pre>', 1)[0])
    for n in g.get('nodes', {}).values():
        for k in HEAVY:
            n.pop(k, None)
    return g


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--check', action='store_true', help='report a difference instead of writing')
    args = ap.parse_args()
    bad = 0
    for name, app, ws, expr in PAYLOADS:
        g = payload(app, ws, expr)
        want = json.dumps(g, indent=2, sort_keys=True) + '\n'
        f = ROOT / 'fixtures' / name
        have = f.read_text(encoding='utf-8') if f.exists() else ''
        counts = g.get('counts', {})
        if args.check:
            if want != have:
                bad += 1
                print(f'  {name}: not what the panel builds - run: python3 tools/graphdata.py')
            continue
        f.write_text(want, encoding='utf-8')
        print(f'  {name}: {counts.get("nodes", "?")} nodes, {counts.get("edges", "?")} edges')
    if args.check:
        print(f'{bad} payload(s) behind the panel.' if bad
              else f'{len(PAYLOADS)} graph payload(s) are what the panels build.')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
