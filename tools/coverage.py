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

What it cannot say: that a watched file is *well* watched. `namecheck` opening a file means the file
is read for product names and nothing else. Coverage here is «somebody looks», not «somebody looks
at everything» - the second is what the per-tool coverage lines are for.

    python3 tools/coverage.py            # the table, and the unwatched list
    python3 tools/coverage.py --json     # the numbers, for a trend
"""
import builtins
import io
import json
import pathlib
import re
import sys
import contextlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

# The product, as a reader receives it, plus the copy that describes it. Tools and tests are not in
# the subject: they are the instrument, and `tools/` checking itself is a different question.
def subject():
    out = []
    for pat in ("apps/*/*.js", "apps/*/*.html", "apps/*/manifest.json",
                "site/*.html", "site/it/*.html", "site/*.js", "site/*.css",
                "store/*/store-listing.md"):
        out += [p for p in ROOT.glob(pat) if p.is_file()]
    return sorted(set(out))


CHECKERS = ["csscheck", "htmlcheck", "asynccheck", "namecheck", "callcheck", "featurecheck",
            "samplecheck", "sitecheck", "twincheck", "langcheck", "deadcode", "imgcheck"]


def touched_by(mod):
    """Run one checker with reads recorded. Returns the set of paths it opened."""
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

    builtins.open, pathlib.Path.read_text = open_, read_
    try:
        m = __import__(mod)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            try:
                m.main()
            except SystemExit:
                pass
    except Exception as e:                      # a checker that cannot run covers nothing
        print(f"  ! {mod} did not run: {e}", file=sys.stderr)
    finally:
        builtins.open, pathlib.Path.read_text = real_open, real_read
    return seen


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


def declares(mod):
    """(work units named, audits its own coverage) - read from what the checker prints."""
    try:
        m = __import__(mod)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            try:
                m.main()
            except SystemExit:
                pass
        out = buf.getvalue()
    except Exception:
        return 0, False
    units = sum(int(n.replace(',', '')) for n, _ in UNIT.findall(out))
    return units, bool(AUDITED.search(out))


def main() -> int:
    files = subject()
    per, watched = {}, {}
    for mod in CHECKERS:
        got = touched_by(mod)
        per[mod] = sum(1 for f in files if f.resolve() in got)
        for f in files:
            if f.resolve() in got:
                watched.setdefault(f, []).append(mod)
    node = node_suite_reads()
    for f in files:
        if f.resolve() in node:
            watched.setdefault(f, []).append("node suite")

    decl = {mod: declares(mod) for mod in CHECKERS}
    audited = [m for m in CHECKERS if decl[m][1]]
    silent = [m for m in CHECKERS if decl[m][0] == 0]
    unwatched = [f for f in files if f not in watched]

    if "--json" in sys.argv:
        print(json.dumps({
            "files": len(files), "files_opened": len(watched), "files_unopened": len(unwatched),
            "checkers": len(CHECKERS), "checkers_auditing_their_own_coverage": len(audited),
            "audited": sorted(audited), "no_work_unit": sorted(silent),
            "unwatched_files": [f.relative_to(ROOT).as_posix() for f in unwatched],
        }, indent=2))
        return 0

    print(f"coverage: {len(files)} shipped files, {len(unwatched)} opened by no check at all.")
    print()
    print("The number that matters is the second column: a checker that cannot say how much of its")
    print("own subject it read is a checker whose «0 findings» means «0 findings in what I happened")
    print("to look at». Three of these were measured this week at 63%, 89% and 17% of their subject,")
    print("all while printing zero.")
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
