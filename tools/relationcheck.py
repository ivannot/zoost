#!/usr/bin/env python3
"""tools/relationcheck.py - a relation the mirror holds must be one the reader can follow.

**Why this exists, in the author's words: relating the objects built inside Zoho is the core of this
product.** It was said after the fifth report of the same shape in two days - a function called by a
blueprint that the function's own pane did not mention; a task and a notification named in the
blueprint pane and linked to nothing while both sat in the actions catalogue; a blueprint absent from
the wiring drawing; a module drawn by its internal name and a chip that opened nothing. Every one of
them was a relation *already on disk* that no surface made followable, and every one was found by the
user rather than by this repository.

Prose did not stop it. So the rule is derived instead: **take the relations out of the delivered
sample, and require the panel to have a way of opening each kind.**

What it does, exactly:

1. Renders the sample `+ Sample` writes - through `samplecheck.delivered()`, never a second copy, and
   never `fixtures/`, which is the edge-case tree a reader does not receive.
2. Derives every cross-object edge from the files themselves: a blueprint to the module whose records
   walk it, to the function a transition calls and to the action a transition fires; a workflow to its
   module; a schedule to the function it runs; a function to its connections and to everything Zoho
   names in `associated_place`. Nothing is inferred - each edge is a field one file holds about
   another.
3. For each *kind* of edge that the sample actually holds, requires the shipped panel to emit the
   `data-` attribute that opens that kind of target. A kind with edges in the data and no opener
   anywhere is a finding: the product knows the relation and gives the reader no way to follow it.

**What it does not do, stated rather than left to be discovered.** It proves an opener *exists*, not
that the pane which draws that relation uses it: a chip emitted on one surface and forgotten on
another is beyond a static scan, and the browser probe is where that belongs. It says nothing about
edges the sample does not contain - which is why the counts are printed, and why a kind that drops to
zero in the sample stops being checked and says so. And the map below is the one place a kind is tied
to an attribute; a relation kind added tomorrow with no row here is reported as unmapped rather than
silently passing, because an exemption list that grows quietly is a checklist wearing a script's
clothes.
"""
import json
import pathlib
import re
import sys

import samplecheck

ROOT = pathlib.Path(__file__).resolve().parent.parent
PANEL = ROOT / "apps" / "crm"

# Which attribute opens the *target* of each kind of relation. One place, and a kind with no row is a
# finding rather than a pass - see the docstring.
OPENS = {
    "blueprint->module": "data-mod",
    "blueprint->function": "data-fnid",
    "blueprint->action": "data-ap",
    "workflow->module": "data-mod",
    "schedule->function": "data-fnid",
    "function->connection": "data-conn",
    "function->associated_place": "data-ap",
    "field->workflow": "data-wfid",
    "field->blueprint": "data-bpid",
}

# **The second surface, and the one this tool was not looking at.** The report is where a reader
# without the extension meets the same relations, and it carries them as anchors rather than as
# `data-` attributes. Nothing checked that half, so a blueprint's transitions named the action they
# fire, and the Actions table named the process that fires an action, as plain words - found in a
# real export by the author, with the panel already correct. One row per kind, the same rule as
# above: a kind with no row is reported rather than passed over.
REPORT = {
    "blueprint->module": "mod-",
    "blueprint->function": "fn-",
    "blueprint->action": "act-",
    "workflow->module": "mod-",
    "schedule->function": "fn-",
    "function->connection": "conn-",
    "function->associated_place": "act-",
    "field->workflow": "wf-",
    "field->blueprint": "bp-",
}


def edges(crm: pathlib.Path) -> dict:
    """Every cross-object reference the delivered sample holds, counted by kind."""
    out = {}

    def add(kind, n=1):
        out[kind] = out.get(kind, 0) + n

    def load(rel):
        p = crm / rel
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            return []

    for b in load("blueprints/index.json"):
        if b.get("module"):
            add("blueprint->module")
        if b.get("field"):
            add("field->blueprint")
        try:
            acts = json.loads((crm / f"blueprints/{b['id']}.actions.json").read_text(encoding="utf-8"))
        except Exception:
            acts = {}
        for t in acts.values():
            for a in (t or {}).get("actions") or []:
                add("blueprint->function" if a.get("type") == "functions" else "blueprint->action")

    for w in load("workflows/index.json"):
        if w.get("module"):
            add("workflow->module")
        add("field->workflow")

    for s in load("schedules/index.json"):
        if s.get("function_id") or s.get("function_name"):
            add("schedule->function")

    for meta in (crm / "functions").rglob("*.meta.json"):
        try:
            d = json.loads(meta.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("associated_place"):
            add("function->associated_place", len(d["associated_place"]))
        if d.get("connections"):
            add("function->connection", len(d["connections"]))
    return out


def emitters() -> dict:
    """Which shipped script emits each openable attribute, read from the source rather than listed."""
    found = {}
    for f in sorted(PANEL.glob("*.js")):
        src = f.read_text(encoding="utf-8")
        for attr in set(re.findall(r'(data-[a-z]+)="', src)):
            found.setdefault(attr, []).append(f.name)
    return found


def report_anchors() -> dict:
    """Per anchor prefix, whether the report defines the target and whether anything links to it.

    Both halves are needed and they fail apart: a target nobody links to is a section with an id
    nothing reaches, and a link to a target that does not exist is a dead `#`. Two kinds had neither -
    blueprints and actions - which is why the references to them could only ever be words.
    """
    src = (PANEL / "export.js").read_text(encoding="utf-8")
    out = {}
    for prefix in sorted(set(REPORT.values())):
        helper = re.search(rf"const (\w+Anchor) = \([^)]*\) => '{re.escape(prefix)}'", src)
        name = helper.group(1) if helper else None
        # Both spellings of the same emission. The report is built partly with template literals and
        # partly with `+` concatenation - the Actions table is a row of `'<td>' + …` - so a pattern
        # that knew only `id="${escA(` reported the action anchor as missing while it was there. One
        # spelling of a thing is the mistake this repository keeps recording about other people's
        # code, met here in the check written to stop it.
        out[prefix] = {
            "target": bool(name and re.search(rf'id="(?:\$\{{|\' \+ )escA\({name}\(', src)),
            # A *call site*, not merely the definition. `href="#${escA(bpAnchor(` also appears inside
            # the one-line helper that builds such a link, so a report whose every call site had been
            # deleted would still have matched - the check would have been measuring that the helper
            # exists, which nobody doubted.
            "link": bool(name and re.search(rf'href="#(?:\$\{{escA\(|\$\{{|\' \+ escA\(){name}\(', src)
                         and len(re.findall(rf"[^a-zA-Z]{name}\(", src)) > 1),
            "helper": name,
        }
    # A link may also be emitted through a small helper of its own - `modLink`, `bpLink`, `actLink`,
    # `linkByName` - which is the shape this file prefers wherever the target has to be checked for
    # existence first. Read those too, or the check would report the tidier half of the code.
    for helper_name, prefix in (("modLink", "mod-"), ("bpLink", "bp-"),
                                ("actLink", "act-"), ("linkByName", "fn-")):
        if re.search(rf"const {helper_name} = ", src) and re.search(rf"\b{helper_name}\(", src):
            out.setdefault(prefix, {"target": False, "link": False, "helper": None})["link"] = True
    return out


def main() -> int:
    crm, _ = samplecheck.delivered()
    held = edges(crm)
    emit = emitters()
    findings = []

    for kind, n in sorted(held.items()):
        attr = OPENS.get(kind)
        if attr is None:
            findings.append(f"{kind}: {n} in the sample and no row in OPENS - an unmapped relation "
                            "passes without anyone deciding it should")
            continue
        if attr not in emit:
            findings.append(f"{kind}: {n} in the sample, and nothing in the panel emits {attr} - the "
                            "product holds the relation and gives the reader no way to follow it")

    # The same question of the report, which is the surface a reader without the extension gets. A
    # relation followable in the panel and spelled out as words in the export is the same defect one
    # document further on, and it was reaching the author rather than this tool.
    anchors = report_anchors()
    for kind, n in sorted(held.items()):
        prefix = REPORT.get(kind)
        if prefix is None:
            findings.append(f"{kind}: {n} in the sample and no row in REPORT - the export was not "
                            "considered for this relation at all")
            continue
        state = anchors.get(prefix) or {}
        if not state.get("target"):
            findings.append(f"{kind}: {n} in the sample, and the report gives `{prefix}` no anchor - "
                            "there is nothing in the document for a reference to point at")
        elif not state.get("link"):
            findings.append(f"{kind}: {n} in the sample, and nothing in the report links to `{prefix}` "
                            "- the reference is printed as words the reader cannot follow")

    # A kind this tool knows about and the sample no longer contains is not a pass: it means the
    # check went quiet, which is exactly how a sweep comes to prove nothing.
    silent = [k for k in OPENS if k not in held]

    print(f"relationcheck: {sum(held.values())} edge(s) of {len(held)} kind(s) in the delivered "
          f"sample; {len(emit)} openable attribute(s) emitted across {len(list(PANEL.glob('*.js')))} "
          "shipped script(s).")
    if silent:
        print("  not exercised by the sample, so not checked: " + ", ".join(sorted(silent)))
    for f in findings:
        print("  " + f)
    print()
    print(f"{len(findings)} finding(s). A relation the mirror holds must be one the reader can follow."
          if findings else
          "0 findings. Every relation the sample holds has a way to be followed.")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
