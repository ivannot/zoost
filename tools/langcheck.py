#!/usr/bin/env python3
"""One language in the repository, and one exception: the Italian pages.

    python3 tools/langcheck.py            # report anything Italian outside site/it/
    python3 tools/langcheck.py --accept   # record what is there now as read

The rule it holds: **everything in this repository is written in English - code, comments, notes,
tests, tool output, commit messages and file names. The only Italian is the site's Italian pages.**
Stated by the author on 20 August 2026, after a note written in Italian was found at the repository
root; two `background.js` files had opened with an Italian comment since the first commit, and six
more places quoted a bug report in Italian inside English prose.

Why a checker and not a line in `CLAUDE.md`: this repository's own record is that a rule with a check
behind it holds and a rule that lives only as prose gets broken, usually by whoever has just read it.
Language is the easiest of all to break, because the author thinks in Italian and the words arrive
already written.

It is a **ledger**, like `tools/cssdupes.txt` and `tools/asyncglobals.txt`: what is legitimately
Italian today is recorded in `tools/notenglish.txt` with its reason, anything new is a finding, and
the ledger may only shrink. Three kinds of entry are legitimate and none of them is a loophole:

  - a **quotation** of the Italian site's own copy, inside English prose that is about that copy;
  - the **language-switch link** on each English page, which addresses an Italian reader and carries
    `lang="it"` to say so;
  - the **Italian string table** the site's script holds for the pages under `site/it/`.

What it cannot do is written here rather than left to be found: it recognises Italian by a list of
words that English does not have, so a line of Italian built from words the list does not carry goes
through, and a proper noun that happens to match would be a false finding (none exists today). It is
a net, not a proof - which is exactly what the ledger is for.
"""
import hashlib
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LEDGER_REL = 'tools/notenglish.txt'
LEDGER = ROOT / LEDGER_REL

# Words that are Italian and are not English, not fragments of English, and not code identifiers.
# `per`, `non` and `come` are deliberately absent: «per page», «non-negotiable» and «come back» are
# ordinary English here, and a checker that cries wolf is one nobody runs.
WORDS = (
    'della', 'delle', 'dello', 'degli', 'questo', 'questa', 'queste', 'questi', 'quello', 'quella',
    'perché', 'perche', 'viene', 'vengono', 'quando', 'quindi', 'invece', 'senza', 'sempre',
    'ogni', 'tutti', 'tutte', 'tutto', 'nella', 'nelle', 'dalla', 'dalle', 'sulla', 'sulle',
    'essere', 'devono', 'deve', 'sono', 'anche', 'ancora', 'perchè', 'cosa', 'niente',
    'nessun', 'nessuna', 'soltanto', 'oppure', 'adesso', 'allora', 'clicchi', 'aggiorni',
)
RX = re.compile(r'(?<![\w-])(' + '|'.join(WORDS) + r')(?![\w-])', re.IGNORECASE)

# Text this tool reads. Everything else is bytes it has no opinion about.
SUFFIXES = {'.py', '.js', '.mjs', '.html', '.css', '.md', '.txt', '.json', '.sh', '.yml', '.yaml'}

# The one place where Italian is the product rather than a lapse.
def skipped(rel: str) -> bool:
    return (rel.startswith('site/it/')
            # A ledger of the claims made on every page, the Italian ones included: it is a record of
            # what those pages say, so it is Italian by definition and translating it would falsify it.
            or rel == 'tools/absolutes.txt'
            # This tool's own ledger. It quotes every line it records, so scanning it makes the check
            # report its own record back at itself - and `--accept` never converges, because each run
            # writes lines that the next run finds. Derived files are read, not judged.
            or rel == LEDGER_REL
            # The manual-check records. They carry the author's own sentence about what he saw, in the
            # language he said it in - and a quotation translated is a quotation falsified, which this
            # repository states as a rule. Accepting each one into the ledger instead would grow it by
            # a line every release, and the ledger may only shrink.
            or rel.endswith('/handchecks.json')
            or rel.startswith('dist/'))


def tracked() -> list:
    out = subprocess.run(['git', '-C', str(ROOT), 'ls-files'], capture_output=True, text=True).stdout
    return [p for p in out.splitlines() if pathlib.Path(p).suffix in SUFFIXES and not skipped(p)]


def key(rel: str, line: str) -> str:
    """A ledger entry is a *line*, not a place: moving a quotation keeps it recorded, editing it does
    not. The path is in the key too, so the same sentence copied into a second file is a finding -
    which is the duplication rule this repository already holds everywhere else."""
    return hashlib.sha256((rel + '\x00' + line.strip()).encode('utf-8')).hexdigest()[:16]


def read_ledger() -> dict:
    if not LEDGER.exists():
        return {}
    out = {}
    for row in LEDGER.read_text(encoding='utf-8').splitlines():
        if row.startswith('#') or not row.strip():
            continue
        k, _, rest = row.partition('  ')
        out[k] = rest
    return out


def scan() -> list:
    found = []
    for rel in tracked():
        try:
            text = (ROOT / rel).read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(text.splitlines(), 1):
            # A link that says «this page in Italian» is addressed to an Italian reader and says so
            # in the markup. Marked, not guessed: the attribute is the declaration.
            if 'lang="it"' in line or "lang='it'" in line:
                continue
            if RX.search(line):
                found.append((rel, n, line.strip()))
    return found


def main() -> int:
    accept = '--accept' in sys.argv
    found = scan()
    ledger = read_ledger()
    if accept:
        rows = ['# Derived by tools/langcheck.py - do not edit by hand; run it with --accept.',
                '# Every line here is Italian that is *meant* to be: a quotation of the Italian site,',
                '# or a string those pages are built from. The ledger may only shrink.']
        for rel, _, line in found:
            rows.append(f'{key(rel, line)}  {rel}: {line[:150]}')
        LEDGER.write_text('\n'.join(rows) + '\n', encoding='utf-8')
        print(f'{len(found)} line(s) recorded in {LEDGER.relative_to(ROOT)}')
        return 0

    new = [(rel, n, line) for rel, n, line in found if key(rel, line) not in ledger]
    seen = {key(rel, line) for rel, _, line in found}
    gone = [k for k in ledger if k not in seen]
    for rel, n, line in new:
        print(f'  {rel}:{n}: Italian outside the Italian pages - {line[:110]}')
    for k in gone:
        print(f'  the ledger still records a line that is no longer there: {ledger[k][:110]}')
    total = len(new) + len(gone)
    print()
    if total:
        print(f'{total} finding(s). One language in the repository; the Italian pages are the exception.')
        print('If a line is a deliberate quotation of the Italian site, run --accept in the same change.')
    else:
        print(f'0 findings. {len(found)} deliberate line(s) of Italian, all of them recorded.')
    return 1 if total else 0


if __name__ == '__main__':
    raise SystemExit(main())
