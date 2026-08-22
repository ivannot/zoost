#!/usr/bin/env python3
"""tools/samplecheck.py - the sample page states numbers; this derives them and compares.

`site/try.html` is the trust argument: it tells a reader exactly what `+ Sample` writes to disk, file
by file, so they can count it themselves. That makes every number on it a claim of the kind this
repository refuses to leave unchecked - and it was the one page whose claims nothing measured.

**Which sample, and this is the whole difficulty.** `fixtures/` is *not* it: that tree is rendered
with the edge cases turned on - an unreadable query, an empty draft, extra rows the tests need - and
a reader never receives any of it. What the page describes is `tools/fixtures.mjs --as-delivered`,
the same code `+ Sample` runs with `edgeCases: false`. Counting the wrong one of the two makes every
number look stale by exactly the edge cases, which is how a review of this page came to "correct"
seven numbers that were right and had to put them all back.

What was genuinely wrong when this was written: the total said 293 against 295 delivered, and the two
files making up the difference - the automation-actions index and the runtime-failures index - had no
row at all, so the table did not add up to its own heading.

Run it by hand, or let `tests/run.sh` run it. `--json` prints what it measured, for a tool that wants
the numbers rather than the verdict.
"""
import atexit
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Rendered on demand into a temporary tree: the delivered sample is not kept in the repository, and
# copying it here would be a second source of truth for the thing this file exists to check.
_TMP = None


def delivered():
    """The workspace `+ Sample` writes, rendered by the shipped generator, cached for this run."""
    global _TMP
    if _TMP is None:
        _TMP = tempfile.mkdtemp(prefix="zoost-samplecheck-")
        out = subprocess.run(["node", str(ROOT / "tools/fixtures.mjs"), "--as-delivered", _TMP],
                             capture_output=True, text=True)
        if out.returncode != 0:
            raise SystemExit("samplecheck: the sample generator would not run:\n" + out.stderr[-400:])
    return next(pathlib.Path(_TMP).glob("crm/*")), next(pathlib.Path(_TMP).glob("analytics/*"))


def _load(path):
    d = json.loads(path.read_text(encoding="utf-8"))
    return d


def measure() -> dict:
    """What the delivered sample holds, counted rather than remembered."""
    CRM, AN = delivered()
    files = lambda d: len([f for f in d.rglob("*") if f.is_file()])
    fns = _load(CRM / "functions/index.json")
    fns = fns["functions"] if isinstance(fns, dict) and "functions" in fns else fns
    views = _load(AN / "views.json")
    views = views["views"] if isinstance(views, dict) and "views" in views else views
    kinds = {}
    for v in views:
        kinds[v.get("type", "?")] = kinds.get(v.get("type", "?"), 0) + 1
    schema = _load(AN / "schema.json")
    rel = schema.get("relations", []) if isinstance(schema, dict) else []
    return {
        "crm": {
            "total": files(CRM),
            "functions": len(fns), "functions.files": files(CRM / "functions"),
            "modules": len(_load(CRM / "modules/index.json")), "modules.files": files(CRM / "modules"),
            "workflows": len(_load(CRM / "workflows/index.json")), "workflows.files": files(CRM / "workflows"),
            "schedules": len(_load(CRM / "schedules/index.json")), "schedules.files": files(CRM / "schedules"),
            "connections": len(_load(CRM / "connections/index.json")), "connections.files": files(CRM / "connections"),
            "actions": len(_load(CRM / "actions/index.json")), "actions.files": files(CRM / "actions"),
            "failures.files": files(CRM / "failures"),
            # The page gives these a row of their own, so they are measured rather than assumed. A
            # row whose number nothing computes is a claim on a public page with no check behind it,
            # which is the whole reason this tool exists.
            "config.files": 1 if (CRM / ".zoost.json").exists() else 0,
        },
        "analytics": {
            "total": files(AN),
            "views": len(views), "tables": kinds.get("Table", 0), "queries": kinds.get("QueryTable", 0),
            "charts": kinds.get("Chart", 0), "pivots": kinds.get("Pivot", 0),
            "dashboards": kinds.get("Dashboard", 0),
            "relations": len(rel),
            "sql.files": files(AN / "sql"),
            "views.files": 1 if (AN / "views.json").exists() else 0,
            "schema.files": 1 if (AN / "schema.json").exists() else 0,
            "lineage.files": 1 if (AN / "lineage.json").exists() else 0,
            "config.files": 1 if (AN / ".zoost.json").exists() else 0,
        },
    }


# Each claim is (page pattern, the key it must equal). The pattern carries enough words to be the
# claim and not a number that happens to be nearby - a bare `\d+` would match the first digit on the
# page and report nonsense.
CLAIMS = [
    (r'Zoost CRM\s*-\s*(\d+)\s*fil', "crm.total"),
    (r'(\d+)\s*(?:Deluge functions|funzioni Deluge)', "crm.functions"),
    (r'(\d+)\s*(?:modules|moduli)\b', "crm.modules"),
    (r'(\d+)\s*(?:workflows|workflow)\b', "crm.workflows"),
    (r'(\d+)\s*(?:schedules|schedulazioni)\b', "crm.schedules"),
    (r'(\d+)\s*(?:connections|connessioni)\b', "crm.connections"),
    (r'(\d+)\s*(?:automation actions|azioni di automazione)', "crm.actions"),
    (r'Zoost Analytics\s*-\s*(\d+)\s*fil', "analytics.total"),
    (r'(\d+)\s*(?:views|viste)\b', "analytics.views"),
    (r'(\d+)\s*(?:tables|tabelle)\b', "analytics.tables"),
    (r'(\d+)\s*query tables?\b', "analytics.queries"),
    (r'(\d+)\s*(?:charts|grafici)\b', "analytics.charts"),
    (r'(\d+)\s*pivot', "analytics.pivots"),
    (r'(\d+)\s*(?:dashboards|dashboard)\b', "analytics.dashboards"),
    (r'(\d+)\s*(?:relations|relazioni)\b', "analytics.relations"),
]

PAGES = ["site/try.html", "site/it/try.html"]

# The **Files** column, which nothing compared until today.
#
# Every one of these numbers was already being measured - `functions.files`, `modules.files`, and the
# rest are in `--json` and always were - and no claim referred to any of them. Eight numbers on a
# public page, in the tool built to check that page's numbers, and its silence read as coverage. The
# same shape as `htmlcheck` inspecting two thirds of its subject: what a tool computes and does not
# compare is worth exactly nothing.
#
# Matched on the first cell, per table, because «the workspace config» is a row in both of them and
# the two mean different files. A row that matches nothing here is a finding: an exemption list is a
# checklist wearing a script's clothes, and this check has no way to know what a new row claims.
ROW_KEYS = [
    (r'deluge|funzioni deluge', "functions.files"),
    (r'\bmodul', "modules.files"),
    (r'workflow', "workflows.files"),
    (r'schedul', "schedules.files"),
    (r'connection|connession', "connections.files"),
    (r'automation action|azioni di automazione', "actions.files"),
    (r'runtime', "failures.files"),
    (r'query table', "sql.files"),
    (r'\bviews\b|\bviste\b', "views.files"),
    (r'relations|relazioni', "schema.files"),
    (r'depends on what|da cosa dipende', "lineage.files"),
    (r'workspace config|configurazione del workspace', "config.files"),
]
ROW = re.compile(r'<td data-label="(?:What it holds|Cosa contiene)">(.*?)</td>\s*'
                 r'<td data-label="(?:Files|File)">(\d+)</td>', re.S)


def row_claims(markup):
    """(app, key, stated) for every row of the two tables, in the order they are written.

    The app comes from the heading above the table rather than from the row, because the same row
    text appears under both.
    """
    out = []
    for chunk in re.split(r'<h3[^>]*>', markup)[1:]:
        head = chunk[:120].lower()
        app = "crm" if "crm" in head else "analytics" if "analytics" in head else None
        if not app:
            continue
        for what, n in ROW.findall(chunk):
            plain = " ".join(re.sub(r'<[^>]+>', ' ', what).split()).lower()
            key = next((k for pat, k in ROW_KEYS if re.search(pat, plain)), None)
            out.append((app, key, int(n), plain))
    return out


def main() -> int:
    m = measure()
    if "--json" in sys.argv:
        print(json.dumps(m, indent=2))
        return 0
    findings = []
    rowcount = 0
    for rel in PAGES:
        page = ROOT / rel
        text = re.sub(r'<[^>]+>', ' ', page.read_text(encoding="utf-8"))
        for pattern, key in CLAIMS:
            app, field = key.split(".", 1)
            want = m[app][field]
            hits = {int(x) for x in re.findall(pattern, text, re.I)}
            if not hits:
                findings.append(f"{rel}: nothing on the page states «{key}» - the sample has {want}")
            elif want not in hits:
                findings.append(f"{rel}: says {sorted(hits)} where the sample has {want} ({key})")
        rows = row_claims(page.read_text(encoding="utf-8"))
        for app, key, stated, plain in rows:
            if key is None:
                findings.append(f"{rel}: the row «{plain}» states {stated} file(s) and this check "
                                f"measures nothing for it - add the measurement, or the row")
                continue
            want = m[app].get(key)
            if want is None:
                findings.append(f"{rel}: «{plain}» maps to {app}.{key}, which is not measured")
            elif want != stated:
                findings.append(f"{rel}: the row «{plain}» says {stated} file(s), the sample has "
                                f"{want} ({app}.{key})")
        rowcount += len(rows)
    print(f"samplecheck: {sum(len(v) for v in m.values())} measurements from the delivered sample, "
          f"{len(CLAIMS)} claims and {rowcount // len(PAGES)} file counts per page, {len(PAGES)} pages")
    for f in findings:
        print("  " + f)
    print()
    print(f"{len(findings)} finding(s). The sample page must state what «+ Sample» actually writes."
          if findings else
          "0 findings. Every number on the sample page is what the sample holds.")
    return 1 if findings else 0


if __name__ == "__main__":
    atexit.register(lambda: shutil.rmtree(_TMP, ignore_errors=True) if _TMP else None)
    sys.exit(main())
