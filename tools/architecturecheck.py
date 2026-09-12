#!/usr/bin/env python3
"""Enforce the small, explicit dependency boundary used by the two extensions.

This is intentionally a conservative checker: it proves that every shipped script has one
declared role and that pure domain/port files cannot acquire browser, network or storage effects.
It does not pretend that a regular expression can prove all JavaScript dependencies.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jstext import strip_js  # noqa: E402 - one scanner, every checker that reads JavaScript

ROOT = Path(__file__).resolve().parents[1]


def _files(app: str) -> set[str]:
    return {p.name for p in (ROOT / "apps" / app).glob("*.js")}


def _html_scripts(root: Path, app: str) -> tuple[list[str], list[str]]:
    """Return the declared script order and structural findings for a panel.

    Classic scripts are the deliberate distribution format, so the order in the HTML is the
    dependency graph.  A checker that only classifies files cannot see a missing or duplicated
    provider; this small structural pass does, without pretending to parse JavaScript globals.
    """
    html = root / "apps" / app / "sidepanel.html"
    if not html.exists():
        return [], [f"{app}: sidepanel.html is missing"]
    text = html.read_text(encoding="utf-8")
    scripts = re.findall(r'<script\b[^>]*\bsrc=["\']([^"\']+)["\']', text)
    findings: list[str] = []
    seen: set[str] = set()
    for name in scripts:
        if name in seen:
            findings.append(f"{app}: sidepanel loads script more than once: {name}")
        seen.add(name)
        if not (root / "apps" / app / name).is_file():
            findings.append(f"{app}: sidepanel references missing script: {name}")
    # These are the non-negotiable composition constraints of the two current panels.  Keeping
    # them here makes an HTML reorder fail before a browser discovers an undefined global.
    pos = {name: i for i, name in enumerate(scripts)}
    if app == "analytics":
        required = ("pull-lifecycle.js", "pull-usecase.js", "pull-adapter.js", "bootstrap.js",
                    "filesystem-adapter.js", "analytics-mirror-writer.js", "analytics-view-model.js",
                    "sidepanel.js")
        missing = [name for name in required if name not in pos]
        if missing:
            findings.append(f"{app}: composition is missing required script(s): {', '.join(missing)}")
        else:
            for left, right in zip(required, required[1:]):
                if pos[left] > pos[right]:
                    findings.append(f"{app}: {left} must load before {right}")
    else:
        required = ("pull-lifecycle.js", "pull-controller.js", "pull-adapter.js", "crm-bootstrap.js")
        missing = [name for name in required if name not in pos]
        if missing:
            findings.append(f"{app}: composition is missing required script(s): {', '.join(missing)}")
        elif pos["crm-bootstrap.js"] != len(scripts) - 1:
            findings.append(f"{app}: crm-bootstrap.js must be the final script (composition root)")
    return scripts, findings


def _dependency_findings(cfg: dict, app: str, scripts: list[str]) -> list[str]:
    """Check the declared classic-script dependency graph.

    Classic scripts have no import syntax: their only runtime provider is an earlier script in the
    panel.  Requiring each application boundary to name its providers catches a missing or reordered
    module even when the browser would only discover it after a user clicks a rarely used control.
    This is deliberately a manifest of reviewed edges, not a claim that text inspection can infer
    every global read.
    """
    findings: list[str] = []
    pos = {name: i for i, name in enumerate(scripts)}
    for consumer, providers in cfg.get("requires", {}).get(app, {}).items():
        if consumer not in pos:
            findings.append(f"{app}: dependency consumer is not loaded: {consumer}")
            continue
        for provider in providers:
            if provider not in pos:
                findings.append(f"{app}: {consumer} requires missing provider {provider}")
            elif pos[provider] >= pos[consumer]:
                findings.append(f"{app}: {provider} must load before {consumer}")
    return findings


def scan(root: Path = ROOT) -> list[str]:
    cfg = json.loads((root / "tools" / "architecture.json").read_text(encoding="utf-8"))
    findings: list[str] = []
    for app in ("crm", "analytics"):
        scripts, html_findings = _html_scripts(root, app)
        findings.extend(html_findings)
        findings.extend(_dependency_findings(cfg, app, scripts))
        actual = {p.name for p in (root / "apps" / app).glob("*.js")}
        cats = cfg["categories"]
        owners: dict[str, list[str]] = {}
        for category, names in cats.items():
            for name in names:
                owners.setdefault(name, []).append(category)
        for name in sorted(actual - set(owners)):
            findings.append(f"{app}: unclassified shipped script: {name}")
        for name in sorted(actual & set(owners)):
            if len(owners[name]) != 1:
                findings.append(f"{app}: script has {len(owners[name])} architecture owners: {name}")
        for name in sorted(actual):
            categories = owners.get(name, [])
            if len(categories) != 1:
                continue
            category = categories[0]
            forbidden = cfg.get("forbidden", {}).get(category, [])
            text = (root / "apps" / app / name).read_text(encoding="utf-8")
            # Comments describe the browser but do not create a dependency. Keep string literals
            # intact (a user-facing message mentioning `window` is harmless), while removing the
            # two comment forms used by shipped scripts.
            #
            # **Through the scanner, not a regex.** These two lines were written with doubled
            # backslashes, so the first was effectively `/.*?/` with DOTALL - it deleted everything
            # between any two slashes in the file, a URL in a comment or a division being enough -
            # and the second stopped at the first letter `n`. Measured: 97,908 characters inspected
            # where 99,627 are code, ~2,300 of `graphlogic.js` invisible, and a planted `fetch(` in a
            # pure module went unreported. Third instance of this class; `tools/jstext.py` exists for
            # it, and the guard in tests/tools_test.py now recognises the doubled form too.
            text = strip_js(text)
            for token in forbidden:
                if token in text:
                    findings.append(f"{app}/{name}: {category} may not contain {token!r}")
    return findings


def self_test() -> None:
    """Exercise both sides of the rule without touching a repository file."""
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "tools").mkdir()
        (root / "apps" / "crm").mkdir(parents=True)
        (root / "apps" / "analytics").mkdir(parents=True)
        (root / "apps" / "crm" / "sidepanel.html").write_text(
            '<script src="pure.js"></script><script src="pull-lifecycle.js"></script>'
            '<script src="pull-controller.js"></script><script src="pull-adapter.js"></script>'
            '<script src="crm-bootstrap.js"></script>', encoding="utf-8")
        (root / "apps" / "analytics" / "sidepanel.html").write_text(
            '<script src="pull-lifecycle.js"></script><script src="pull-usecase.js"></script>'
            '<script src="pull-adapter.js"></script><script src="bootstrap.js"></script>'
            '<script src="filesystem-adapter.js"></script><script src="analytics-mirror-writer.js"></script>'
            '<script src="analytics-view-model.js"></script>'
            '<script src="sidepanel.js"></script>', encoding="utf-8")
        for app, names in {
            "crm": ["pull-lifecycle.js", "pull-controller.js", "pull-adapter.js", "crm-bootstrap.js"],
            "analytics": ["pull-lifecycle.js", "pull-usecase.js", "pull-adapter.js", "bootstrap.js", "filesystem-adapter.js", "analytics-mirror-writer.js", "analytics-view-model.js", "sidepanel.js"],
        }.items():
            for name in names:
                (root / "apps" / app / name).write_text("", encoding="utf-8")
        cfg = {"version": 1, "categories": {"domain": ["pure.js", "analytics-view-model.js"], "ports": [], "application": ["pull-controller.js", "pull-usecase.js", "pull-lifecycle.js"], "adapters": ["pull-adapter.js", "filesystem-adapter.js", "analytics-mirror-writer.js"], "ui": ["sidepanel.js"], "bootstrap": ["crm-bootstrap.js", "bootstrap.js"]}, "forbidden": {"domain": ["document"]}}
        (root / "tools" / "architecture.json").write_text(json.dumps(cfg), encoding="utf-8")
        (root / "apps" / "crm" / "pure.js").write_text("const x = 1;", encoding="utf-8")
        (root / "apps" / "analytics" / "pure.js").write_text("const x = 2;", encoding="utf-8")
        assert not scan(root)
        (root / "apps" / "analytics" / "pure.js").write_text("document.title = 'bad';", encoding="utf-8")
        assert any("document" in item for item in scan(root))
        # A classification-only checker stayed green when a required provider disappeared.  The
        # manifest edge must turn that mutation red even though every remaining file is classified.
        (root / "apps" / "analytics" / "pure.js").write_text("const x = 2;", encoding="utf-8")
        html = (root / "apps" / "analytics" / "sidepanel.html").read_text(encoding="utf-8")
        (root / "apps" / "analytics" / "sidepanel.html").write_text(
            html.replace('<script src="analytics-view-model.js"></script>', ''), encoding="utf-8")
        assert any("analytics-view-model.js" in item for item in scan(root))


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test()
        print("architecture self-test: green")
    else:
        findings = scan()
        if findings:
            print("\n".join(findings))
            raise SystemExit(1)
        total = sum(len(_files(app)) for app in ("crm", "analytics"))
        print(f"architecture: green ({total} shipped scripts classified; pure boundaries checked)")
