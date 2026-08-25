#!/usr/bin/env python3
"""What the assistant sends, against what the privacy page says it sends.

**A privacy policy enumerates, and an enumeration is the thing this repository has already been
caught keeping in step by hand.** Section 4.2 listed the categories from memory and the memory was a
year old in places: Analytics was sending the folder a view sits in, its description, the two dates
Zoho records for it and - the one that matters - `owner`, which is a person's name, while the page
said «view names, column names and data types, the relations, the dependency graph and the SQL». The
CRM was sending the values inside a picklist, which are the reader's own vocabulary rather than
Zoho's, and the scopes granted to each connection.

So the list is derived from the code that builds the answers, and the ledger says where each field is
named on the page. A field emitted by a tool and absent from `tools/aisends.txt` is a finding; a
ledger row for a field nothing emits any more is a finding too, because a policy that over-declares
is as wrong as one that under-declares - it describes a product that does not exist.

**What this does not do**, stated rather than left to be found. It reads `key: ${...}` inside the
functions named below, which is how every answer in both products is written today; a tool that
returns a bare sentence, a JSON blob or a table without that shape sends data this cannot see. It
says nothing about *whether the wording on the page is a fair description* of what the field holds -
only that somebody wrote a row for it and had to look at the page to do so. And it does not read the
Italian page: the two are held together by `sitecheck.py`, which is where that comparison lives.
"""
import pathlib
import re
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ledger import delta as ledger_delta, count as ledger_count, keep_comments  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEDGER = ROOT / "tools" / "aisends.txt"

# The answer builders, per product. Named because there is no cruder enumeration available: «every
# function whose name starts with ai» would sweep the streaming, the markdown renderer and the lock
# dialog, none of which sends anything. The count of functions read is printed, so a fifth one added
# to a product and not added here is at least visible as a number that did not move.
SOURCES = {
    "crm": ("apps/crm/ai.js", ["aiExecTool", "aiModuleText", "aiBuildSeed", "aiFocus"]),
    "analytics": ("apps/analytics/sidepanel.js", ["aiExecTool", "aiStructureText", "aiBuildSeed"]),
}

# A field starts a line; a word followed by a colon in the middle of a sentence is prose. The first
# version allowed any whitespace before the key and pulled «in the 24 hours before that: ${n}» and
# «Total in workspace: ${n}» into the ledger as fields of the answer - a checker inventing subjects,
# which is the class this repository catches by measuring its own tools. Anchored to a newline
# escape or the opening backtick, both of which are how every real field in both files is written.
FIELD = re.compile(r"(?:\\n|`)([a-z][a-z_]{2,}):\s*\$\{")


def _body(text: str, name: str) -> str:
    """The function, from its declaration to the line that closes it.

    Crude on purpose and checked: the declaration is at column zero in both files and so is its
    closing brace, which is the convention this repository already relies on in `asynccheck`. A
    function that stops matching raises rather than returning nothing, because an empty body would
    read here as «this product sends nothing».
    """
    m = re.search(rf"^(?:async )?function {re.escape(name)}\(", text, re.M)
    if not m:
        raise SystemExit(f"aidatacheck: {name}() not found - renamed or moved. Fix this list.")
    end = text.find("\n}\n", m.start())
    if end < 0:
        raise SystemExit(f"aidatacheck: {name}() has no closing brace at column zero.")
    return text[m.start():end]


def sent() -> dict:
    """{app: {field}} - every key the answer builders interpolate a value into."""
    out = {}
    for app, (rel, fns) in SOURCES.items():
        text = (ROOT / rel).read_text(encoding="utf-8")
        keys = set()
        for fn in fns:
            keys |= set(FIELD.findall(_body(text, fn)))
        out[app] = keys
    return out


def ledger() -> dict:
    rows = {}
    if not LEDGER.exists():
        return rows
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            raise SystemExit(f"aidatacheck: malformed ledger row: {line!r}")
        rows[(parts[0], parts[1])] = parts[2]
    return rows


def main() -> int:
    accept = "--accept" in sys.argv
    now = sent()
    have = ledger()
    pairs = {(app, k) for app, ks in now.items() for k in ks}
    unrecorded = sorted(pairs - set(have))
    stale = sorted(set(have) - pairs)

    if accept:
        head = ["# What the assistant sends, and where the privacy page says so.",
                "#",
                "# Derived by tools/aidatacheck.py: one row per field a tool interpolates into an",
                "# answer - app, field, and the words in section 4.2 of site/privacy.html that cover",
                "# it. The third column is written by hand on purpose, because it is a claim about a",
                "# page and deriving it would only prove the file agrees with itself; `--accept`",
                "# carries it forward, and fills a new row with UNNAMED, which is a finding until",
                "# somebody reads the page and replaces it."]
        # Whatever a person wrote here that this tool did not, kept - see `keep_comments`.
        lines = head + keep_comments(LEDGER, head) + [""]
        for app, k in sorted(pairs):
            lines.append(f"{app}\t{k}\t{have.get((app, k), 'UNNAMED - read site/privacy.html 4.2')}")
        before = ledger_count(LEDGER)
        LEDGER.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(ledger_delta(f"aidatacheck: {LEDGER.relative_to(ROOT)}", before, ledger_count(LEDGER)), flush=True)
        return 0

    read = sum(len(fns) for _, fns in SOURCES.values())
    print(f"aidatacheck: {len(pairs)} field(s) sent by {read} answer builder(s) across "
          f"{len(SOURCES)} product(s); tools/aisends.txt names where each is declared.", flush=True)
    for app, k in unrecorded:
        print(f"  {app}: the assistant sends «{k}» and tools/aisends.txt has no row for it - "
              f"section 4.2 of the privacy page may not declare it.", flush=True)
    for app, k in stale:
        print(f"  {app}: tools/aisends.txt still records «{k}» and nothing sends it - the page "
              f"declares data this product no longer has.", flush=True)
    blank = sorted(k for k in have if k in pairs and have[k].startswith("UNNAMED"))
    for app, k in blank:
        print(f"  {app}: «{k}» is recorded but its row says UNNAMED - read the page and say which "
              f"words cover it.", flush=True)
    n = len(unrecorded) + len(stale) + len(blank)
    print(f"aidatacheck: {n} finding(s).", flush=True)
    return 1 if n else 0


if __name__ == "__main__":
    raise SystemExit(main())
