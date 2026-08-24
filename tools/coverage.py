#!/usr/bin/env python3
"""tools/coverage.py - which shipped files no automatic check reads.

**Why this exists.** Every sweep of this repository has reported a numerator - «N defects found» -
and no denominator. A count of findings with nothing to divide it by is indistinguishable from a
slot machine: it always pays something, and nobody can say how much is left. Asked for in exactly
those words, and the objection was right.

The denominator is the **unwatched surface**: the files that no derived check opens. A defect there
can only be found by somebody reading, which is why a sweep keeps paying out. A defect inside a
watched file has to get past a check first, which is why the same one does not come back.

**Measured, not deduced.** Every checker is run with `open` and `Path.read_text` instrumented, and
what it actually touched is recorded. Reading the tools and guessing what they read is the mistake
this whole file is about. The Node suite is read differently - its paths are literals in the test
files - and that limit is stated rather than hidden.

What it cannot say: that a watched file is *well* watched - so it does not report one number. It
reports three, and the middle one exists because the top and the bottom were once the same figure:

  subject    what ships or is published, derived from the authorities that decide it - `build.sh`
             copies `apps/<app>/.` whole, `site/.assetsignore` says what reaches the edge, a
             submission is built from everything under `store/`, and a workflow or `build.sh` can
             turn a right tree into a wrong package. It was a hand-written list of globs and read
             **70** files of **147**: `README.md`, `llms.txt`, `_headers`, the sitemap, every Store
             input and the whole release chain sat outside the denominator, and the report said
             «70 of 70, none unwatched».
  opened     some checker read the file, for any reason. `namecheck` opening a panel to find a
             product name takes that panel out of «unwatched» and says nothing whatever about it.
  examined   opened by a checker that names a work unit **and** measures how much of its own subject
             it reached. That is the nearest this can get, and the gap between it and «opened» is the
             honest size of what the middle number is worth.

`tools/` and `tests/` are deliberately outside the subject: they are how the checking is done, not
what is shipped, and folding them in would let a well-tested tool pay for an unread panel.

Each checker is run **once**, in-process with `open` and `Path.read_text` instrumented, and both the
files it touched and the text it printed come out of that one run - it used to be two functions and
two runs, about two minutes with not a line of output while it happened. It prints one now, per
checker, with the seconds it took. The Node suite is read differently - its paths are literals in
the test files - and that limit is stated rather than hidden.

    python3 tools/coverage.py            # the table, and the unwatched list
    python3 tools/coverage.py --json     # the numbers, for a trend
"""
import builtins
import io
import json
import pathlib
import re
import sys
import time
import contextlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

# What this repository actually ships and publishes, read from the things that decide it rather than
# from a list of globs. The list was `apps/*/*.js`, `site/*.html` and a few more, and it left out
# `README.md`, `site/llms.txt`, `site/_headers`, `site/sitemap.xml`, every Store submission input, the
# workflows and the release tooling - **77 files of 147**, while the report said «70 of 70». A
# denominator you write by hand is a denominator that flatters you.
#
# The authorities, each named where it is used:
#
#   apps      `build.sh` copies `apps/<app>/.` whole, minus `.DS_Store`. So the folder is the answer,
#             icons included - and an icon nothing reads is a true thing to say, not a reason to omit it.
#   site      everything under `site/`, minus what `site/.assetsignore` excludes from the upload. That
#             file is the platform's own authority on what is published and what is not.
#   store     every input a submission is built from, not only the prose: the listing, the JSON that
#             records what was uploaded, the manual-check answers, and the release notes.
#   release   what can change a shipped artefact without appearing in it - the workflows, `build.sh`,
#             `release.sh`. A defect there produces a wrong package from a right tree.
#   outward   `README.md`, the one file that describes the product and is not under `site/`.
#
# Tools and tests stay outside, deliberately and now explicitly: they are the instrument, and an
# instrument measuring itself is the separate question `matrix.py` and the self-audits answer.
def subject() -> dict:
    """Category -> the files it contributes, so the report can say where the denominator comes from."""
    ignored = {ln.strip() for ln in (ROOT / "site/.assetsignore").read_text(encoding="utf-8").split("\n")
               if ln.strip() and not ln.startswith("#")}

    def published_site():
        for f in sorted((ROOT / "site").rglob("*")):
            if not f.is_file():
                continue
            rel = f.relative_to(ROOT / "site")
            if rel.parts[0] in ignored or rel.as_posix() in ignored:
                continue
            yield f

    return {
        "apps": [f for f in sorted((ROOT / "apps").rglob("*")) if f.is_file() and f.name != ".DS_Store"],
        "site": list(published_site()),
        "store": [f for f in sorted((ROOT / "store").rglob("*")) if f.is_file()],
        "release": [f for f in sorted((ROOT / ".github/workflows").glob("*.yml"))]
                   + [f for f in (ROOT / "build.sh", ROOT / "tools/release.sh") if f.is_file()],
        "outward": [f for f in (ROOT / "README.md",) if f.is_file()],
    }


CHECKERS = ["csscheck", "htmlcheck", "asynccheck", "namecheck", "callcheck", "featurecheck",
            "samplecheck", "sitecheck", "twincheck", "langcheck", "deadcode", "imgcheck"]


def run_once(mod):
    """Run one checker once, recording both what it opened and what it printed.

    It used to be two functions and two runs - `touched_by` for the reads, `declares` for the output -
    so every checker ran twice and the tool took about two minutes without emitting a line. A silent
    process and a hung one look the same from outside, which is a rule this repository already holds
    for its own tools and had not applied to this one. One run, and a line per checker with the
    seconds on it, flushed.
    """
    seen = set()
    real_open, real_read = builtins.open, pathlib.Path.read_text

    def note(p):
        try:
            seen.add(pathlib.Path(p).resolve())
        except (OSError, ValueError):
            pass

    def open_(file, *a, **k):
        note(file)
        return real_open(file, *a, **k)

    def read_(self, *a, **k):
        note(self)
        return real_read(self, *a, **k)

    print(f"  running {mod}\u2026", end="", flush=True)
    t0 = time.monotonic()
    builtins.open, pathlib.Path.read_text = open_, read_
    buf = io.StringIO()
    try:
        m = __import__(mod)
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            try:
                m.main()
            except SystemExit:
                pass
    except Exception as e:                      # a checker that cannot run covers nothing
        builtins.open, pathlib.Path.read_text = real_open, real_read
        print(f" did not run: {e}", flush=True)
        return seen, ""
    finally:
        builtins.open, pathlib.Path.read_text = real_open, real_read
    print(f" {time.monotonic() - t0:.0f}s", flush=True)
    return seen, buf.getvalue()


def node_suite_reads():
    """Paths the Node tests name. Literals only - the stated limit of this half.

    `tests/*.mjs` reach files through `read('…')`, `sliceFn('…', …)` and `sliceConst`, all with the
    path written out. A path built at run time is invisible here, and would make this under-report,
    which is the direction to be wrong in.
    """
    out = set()
    for f in (ROOT / "tests").glob("*.mjs"):
        for m in re.finditer(r"['\"]((?:apps|site|store|tools)/[\w./-]+)['\"]", f.read_text(encoding="utf-8")):
            p = ROOT / m.group(1)
            if p.exists():
                out.add(p.resolve())
    return out


# A checker earns «audited» by doing what CLAUDE.md asks of anything that inspects a tree: print the
# count of things it inspected, and derive the denominator by a cruder method than the check itself.
# The phrase it prints when the two agree is the evidence, and it is the same phrase in each.
AUDITED = re.compile(r'none left unread|NOT LOOKED AT')
# A work unit that is not the file: «223 attribute interpolations», «1477 rules», «60 controls». A
# tool that counts files is honest only when its subject *is* the file.
UNIT = re.compile(r'\b(\d[\d,]*)\s+(rule|attribute interpolation|named control|measurement|'
                  r'claim|shipped script|page|shipped file|screenshot|global write)')


def declares(out: str):
    """(work units named, audits its own coverage) - read from what the checker printed."""
    units = sum(int(n.replace(",", "")) for n, _ in UNIT.findall(out))
    return units, bool(AUDITED.search(out))


def main() -> int:
    cats = subject()
    files = sorted({f for v in cats.values() for f in v})
    per, watched, printed = {}, {}, {}
    print(f"coverage: {len(files)} files in the subject; running {len(CHECKERS)} checkers once each.",
          flush=True)
    for mod in CHECKERS:
        got, out = run_once(mod)
        printed[mod] = out
        per[mod] = sum(1 for f in files if f.resolve() in got)
        for f in files:
            if f.resolve() in got:
                watched.setdefault(f, []).append(mod)
    node = node_suite_reads()
    for f in files:
        if f.resolve() in node:
            watched.setdefault(f, []).append("node suite")

    decl = {mod: declares(printed[mod]) for mod in CHECKERS}
    audited = [m for m in CHECKERS if decl[m][1]]
    silent = [m for m in CHECKERS if decl[m][0] == 0]
    unwatched = [f for f in files if f not in watched]
    # Opened by a checker that names a work unit *and* audits its own reach - the nearest this can get
    # to «examined». Opening a panel to read a product name takes it out of `unwatched` and says
    # nothing about the panel, which is the distance between these two numbers.
    examined = [f for f in files if any(m in audited for m in watched.get(f, []))]

    if "--json" in sys.argv:
        print(json.dumps({
            "repository_subject_files": len(files),
            "subject_by_authority": {k: len(v) for k, v in cats.items()},
            "files_opened_for_any_reason": len(watched),
            "files_opened_by_a_self_auditing_checker": len(examined),
            "files_opened_by_nothing": len(unwatched),
            "checkers": len(CHECKERS),
            "checkers_auditing_their_own_coverage": len(audited),
            "audited": sorted(audited), "no_work_unit": sorted(silent),
            "unwatched_files": [f.relative_to(ROOT).as_posix() for f in unwatched],
        }, indent=2))
        return 0

    print()
    print(f"  subject          {len(files):4d}   " + ", ".join(f"{k} {len(v)}" for k, v in cats.items()))
    print(f"  opened at all    {len(watched):4d}   some checker read the file, for any reason")
    print(f"  read by a tool")
    print(f"    that proves    {len(examined):4d}   …and that tool measures how much of its subject it read")
    print(f"    its own reach")
    print(f"  opened by none   {len(unwatched):4d}   a defect here is found only by somebody reading")
    print()
    print("Three numbers, not one, because they were one and it flattered the middle: «opened» counts")
    print("a panel a checker read to find a product name, which says nothing about the panel. The gap")
    print("between the second and the third is the honest size of what «watched» is worth.")
    print()
    print(f"  {'checker':14s} {'files read':>10s}  {'work units':>10s}  audits its own coverage")
    for mod in CHECKERS:
        units, ok = decl[mod]
        print(f"  {mod:14s} {per[mod]:10d}  {units if units else '-':>10}  {'yes' if ok else 'no'}")
    print()
    print(f"{len(audited)} of {len(CHECKERS)} checkers prove they read their whole subject: "
          f"{', '.join(sorted(audited)) or 'none'}.")
    if silent:
        print(f"{len(silent)} name no work unit at all: {', '.join(sorted(silent))}. Their «0 findings» "
              f"is a statement about an unknown amount of reading.")
    if unwatched:
        print()
        print("Files no check opens - a defect here is found only by somebody reading:")
        for f in unwatched:
            print("  " + f.relative_to(ROOT).as_posix())
    return 0


if __name__ == "__main__":
    sys.exit(main())
