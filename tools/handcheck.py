#!/usr/bin/env python3
"""tools/handcheck.py - the part of a release only a person can do, and their answer on the record.

    python3 tools/handcheck.py crm              # what to exercise for this release, and how to answer
    python3 tools/handcheck.py crm --pass 1,3   # record those as done and working
    python3 tools/handcheck.py crm --fail 2 --note "the tree came back empty"
    python3 tools/handcheck.py crm --check      # what tools/release.sh asks before it will tag

**Why this exists.** A defect that made every Pull all fail reached a submitted package. Nothing here
could have caught it: `node --check` accepts a free variable, the panels are not importable so no unit
test runs them, and the probe drove a workspace that was already on disk. The hole was not a missing
assertion, it was that **nothing executed a pull** - and the parts of this product that need a real
Zoho org cannot be executed here at all, by anyone, ever.

`tools/probe.py` now runs both pulls headless against the sample workspace, which closes most of it.
What it cannot close is what only a real org has: rate limits, role refusals, a data centre's own
shapes, a tab that logs out mid-pull, thousands of rows. So the author asked to be *in* the chain
rather than around it: he runs what only he can run, he says whether it worked, and that answer is
recorded and gates the tag.

**What makes this a check and not a checklist.** The catalogue below is written by hand - a machine
cannot know that «press Pull all on a real org» is a thing to do. What is derived is *which* entries
apply: the shipped files changed since this app's last tag decide it. And a changed file that no entry
covers is a **finding**, not a silence - so the catalogue has to grow when the product does, which is
the failure mode of every checklist this repository has met.

**A certification names a commit, not a version.** `HEAD` moves, and an answer about code that has
since changed is worth nothing. Change one line after certifying and this says so, by name.

**And it records only what happened.** No `--pass all` for a run nobody did: the ids are typed one by
one, and a failure is recordable - a tool that can only hear «yes» is a tool that is asking nothing.

**Who types it is not the point; whose answer it is, is.** The author does not run commands: «I talk
to you in natural language and I use the app as a user, that's it». So he reads the plan, exercises
the product, says in words what happened, and the assistant records it - with his words in `--note`,
because the sentence he used is the evidence and «pass» is only the filing. Nothing here is inferred
from a green suite or from an assistant's confidence: if he has not said it, it is not recorded, and
`release.sh` stops.

**Not part of `tests/run.sh`.** Every answer it records is a person's: what he saw on a real org,
in his words, on a named commit. Nothing here can produce one, so a battery run would either skip
it silently or invent it, and the second is the failure this whole file exists to prevent. It runs
where it belongs - in the release routine, before the tag, with `release.sh` refusing without it.
"""
import argparse
import contextlib
import datetime
import io
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def in_its_repository() -> bool:
    """This tool is only correct where the repository is. It reads the manifest for the version, asks
    git what changed since the tag, and writes a record that has to be committed - so a copy of it
    somewhere else does not do less, it answers *wrongly*: no tag, so nothing changed, so nothing to
    run, so the release looks certified. That is the one failure a tool like this must not have, and
    the author raised it before it happened: «I am not sure I have an up-to-date tools directory».

    So the copy that travels is the **plan**, which is text and cannot be run, and the tool refuses to
    work anywhere but here. See `--plan-file`, which is what tools/totest.sh writes into the folder
    the browser machine sees."""
    return (ROOT / '.git').exists() and (ROOT / 'apps').is_dir()

# What only a person with a real org can establish. Each entry: what to do, what a pass looks like,
# and which shipped files make it apply. `covers` is matched against the paths changed since the tag.
#
# Write the *observation*, never the verdict: «the tree fills and the count matches the org» is
# something he can see, «works correctly» is something he has to interpret.
CHECKS = [
    {
        'id': 'pull-all',
        'title': 'Pull all, on a real org, from an empty workspace',
        'do': ['Create a new workspace bound to a real org (or delete the contents of one).',
               'Press Pull all and leave it alone until it stops.'],
        'pass': ('It ends on a line that names what it read - not on «interrupted», not on «could not». '
                 'The tree fills, and the counts match what the platform shows you.'),
        'covers': ['apps/*/sidepanel.js', 'apps/*/content-bridge.js', 'apps/*/modules.js',
                   'apps/*/automation.js', 'apps/*/connections.js'],
    },
    {
        'id': 'pull-again',
        'by': "probe.py: pull-analytics runs a second pull over the first",
        'title': 'Pull all a second time, over the workspace the first one wrote',
        'do': ['Press Pull all again on the same workspace, without changing anything.'],
        'pass': ('It finishes the same way, nothing is reported as failed to remove, and the counts '
                 'do not move. A second pull is where a half-written mirror shows.'),
        'covers': ['apps/*/sidepanel.js', 'apps/*/content-bridge.js'],
    },
    {
        'id': 'progress',
        'by': "probe.py: pull-analytics reads the status line as it changes",
        'title': 'The panel says what it is doing, the whole way through',
        'do': ['Watch the status line during the pull above.'],
        'pass': ('No stretch where the line stands still on a finished stage while the spinner turns. '
                 'Every stage names itself, and the ones that count, count.'),
        'covers': ['apps/*/sidepanel.js'],
    },
    {
        'id': 'wrong-tab',
        'by': "probe.py: pull-analytics moves the tab and asserts the refusal",
        'title': 'The guard on the wrong Zoho tab',
        'do': ['With a workspace bound to one org, open a Zoho tab for another (or a sandbox).',
               'Try a pull.'],
        'pass': 'It refuses, names both sides, and offers the way to align them. It does not write.',
        'covers': ['apps/*/sidepanel.js', 'apps/*/content-bridge.js'],
    },
    {
        'id': 'live-save',
        'title': 'A function saved in Zoho reaches the mirror (Zoho CRM only)',
        'do': ['With the panel open, edit and save a Deluge function in Zoho\'s own editor.'],
        'pass': 'The row updates on its own, without a pull, and the file on disk carries the change.',
        'covers': ['apps/crm/hook.js', 'apps/crm/content-bridge.js', 'apps/crm/sidepanel.js'],
        'app': 'crm',
    },
    {
        'id': 'assistant',
        'title': 'The assistant answers about the org, with a real key',
        'do': ['With an API key configured, ask it something that needs a tool - «who calls X».'],
        'pass': 'It answers, the tools it opened are listed in the chat, and nothing it says is invented.',
        'covers': ['apps/crm/ai.js', 'apps/*/sidepanel.js', 'apps/*/options.js'],
    },
    {
        'id': 'export',
        'title': 'An export opens and reads as the panel reads',
        'do': ['Export HTML and Markdown from the real workspace, and open both.',
               'Open the other product\'s HTML export beside it.'],
        'pass': ('Every section the panel shows is in them, nothing in them is empty or invented, and '
                 'the two HTML reports are the same document: same header, same index, same cards, '
                 'same foot.'),
        'covers': ['apps/crm/export.js', 'apps/*/sidepanel.js', 'apps/crm/health.js',
                   'apps/*/reportshell.js'],
    },
    {
        'id': 'diagram',
        'by': "shots.py: both diagram windows are rendered on every image run",
        'title': 'The diagram window opens on the real workspace',
        'do': ['Open the call graph (Zoho CRM) or the ER model (Zoho Analytics) from the panel.'],
        'pass': 'It draws, the focus lands where you asked, and the counts agree with the panel.',
        'covers': ['apps/*/graphview.js', 'apps/*/graphlogic.js', 'apps/crm/graph-core.js'],
    },
    {
        'id': 'sample',
        'by': "shots.py: the crm-sample shot clears the folder and presses + Sample",
        'title': 'The sample workspace still writes and opens',
        'do': ['Press + Sample in a working folder.'],
        'pass': ('It writes, the tree fills, and the panel says nothing was fetched from Zoho. This is '
                 'the workspace every picture on the site is rendered from, so it is also the one a '
                 'first-time reader sees.'),
        'covers': ['apps/*/sample-org.js', 'apps/*/sidepanel.js'],
    },
    {
        'id': 'fresh-profile',
        'title': 'A profile that has never seen Zoost',
        'do': ['Load the extension into a Chrome profile that has never had it, or clear its storage.',
               'Click the toolbar icon.'],
        'pass': ('The side panel opens from the icon, and the two starter search patterns are already '
                 'in the list. Both are written once, on install, and only a fresh profile runs that.'),
        'covers': ['apps/*/background.js', 'apps/*/manifest.json'],
    },
    {
        'id': 'chrome',
        'by': "probe.py: the toolbar is measured at the panel's minimum width",
        'title': 'The panel at its narrowest, and the help inside it',
        'do': ['Drag the side panel to its minimum width.',
               'Open the ? help from the panel.'],
        'pass': ('Every control in the toolbar is still reachable without scrolling the row sideways, '
                 'and the help describes what you are actually looking at.'),
        'covers': ['apps/*/sidepanel.html', 'apps/*/product-help.js'],
    },
    {
        'id': 'detail',
        'by': "probe.py: both panels open an item and read what came back",
        'title': 'One item opened, and read',
        'do': ['Open a Deluge function (Zoho CRM) or a query table (Zoho Analytics) from the tree.'],
        'pass': ('The source is coloured, and a name inside it that Zoost can open is a link that goes '
                 'where it says. For a query, the SQL is the SQL the platform shows.'),
        'covers': ['apps/*/highlight.js', 'apps/analytics/analytics-sql.js', 'apps/*/sidepanel.js'],
    },
    {
        'id': 'passphrase',
        'title': 'The API key under a passphrase, across a browser restart',
        'do': ['In Settings, protect the key with a passphrase.',
               'Quit Chrome entirely, open it again, and ask the assistant something.'],
        'pass': ('It asks for the passphrase once, the answer comes back, and it does not ask again '
                 'that session. After «Forget», the assistant says there is no key rather than '
                 'answering anyway.'),
        'covers': ['apps/*/keyvault.js', 'apps/*/options.js'],
    },
    {
        'id': 'restart',
        'title': 'A full browser restart: the folder, and what you changed in Settings',
        'do': ['Change something in Settings - a hidden tab, a saved pattern, the AI model.',
               'Quit Chrome entirely, open it again, and open the panel.'],
        'pass': ('It says the folder needs re-granting and one click anywhere in the panel restores '
                 'it; the change you made in Settings is still there. A stored handle loses its '
                 'permission between sessions, and that is the path every returning user takes.'),
        'covers': ['apps/*/idb.js', 'apps/*/sidepanel.js', 'apps/*/options.js', 'apps/*/options.html',
                   'apps/crm/tabs.js'],
    },
]


def sh(*args: str) -> str:
    return subprocess.run(args, capture_output=True, text=True, cwd=str(ROOT)).stdout.strip()


def head() -> str:
    return sh('git', 'rev-parse', 'HEAD')


def version(app: str) -> str:
    return json.loads((ROOT / 'apps' / app / 'manifest.json').read_text(encoding='utf-8'))['version']


def last_tag(app: str) -> str:
    tags = [t for t in sh('git', 'tag', '--list', f'{app}-v*').splitlines() if t]
    return sorted(tags, key=lambda t: [int(n) for n in t.rsplit('-v', 1)[1].split('.')])[-1] if tags else ''


def changed_between(app: str, since: str) -> list:
    """Shipped files of this app touched between a commit and now. What makes an answer expire."""
    out = sh('git', 'diff', '--name-only', f'{since}..HEAD', '--', f'apps/{app}')
    return [p for p in out.splitlines() if p]


def stale_for(check: dict, app: str, since: str) -> list:
    """Which of the files this check exercises have moved since it was answered.

    The first version expired an answer whenever **any** line of the product changed, which is honest
    and expensive: a fix in the diagram window sent him back to re-run a pull on a real org. What an
    answer is about is the code that check exercises, and that is derivable - so a run of six things
    costs six re-runs only when all six were touched. Asked for as a rule: «minimise the manual
    operations, they are slow and they carry human error»."""
    if not since:
        return []
    return [f for f in changed_between(app, since)
            if any(pathlib.PurePath(f).match(g) for g in check['covers'])]


def changed(app: str) -> list:
    """Shipped files of this app touched since its last tag. Only `apps/<app>/` - the site, the tools
    and the other product cannot change what a person has to exercise here."""
    tag = last_tag(app)
    rng = f'{tag}..HEAD' if tag else 'HEAD'
    out = sh('git', 'diff', '--name-only', rng, '--', f'apps/{app}')
    return [p for p in out.splitlines() if p]


def applies(check: dict, app: str, files: list) -> bool:
    if check.get('app') and check['app'] != app:
        return False
    return any(pathlib.PurePath(f).match(g) for g in check['covers'] for f in files)


def record_path(app: str) -> pathlib.Path:
    """One ledger per product, not one per version.

    Per version was the first shape and it threw the answers away at every bump: a release that
    changed a label sent him back through a pull on a real org, an assistant conversation and two
    browser restarts, for nothing. «If between one release and the next only a label changed, it makes
    no sense to redo all the tests - they must be run only if something inside that perimeter moved.»

    So an answer is kept with the commit it was given on, and it stands until the code *that check
    exercises* moves - across releases, across versions. What each answer was about is still recorded:
    the version is a field of the answer rather than the name of the file."""
    return ROOT / 'store' / app / 'handchecks.json'


def read_record(app: str) -> dict:
    p = record_path(app)
    return json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}


def uncovered(app: str, files: list) -> list:
    """A shipped file nobody has said how to exercise. The catalogue is written by hand, so this is
    the only thing stopping it from ageing into decoration."""
    out = []
    for f in files:
        if f.endswith(('.json', '.md')) or '/icons/' in f:
            continue
        if not any(pathlib.PurePath(f).match(g) for c in CHECKS
                   if not c.get('app') or c['app'] == app for g in c['covers']):
            out.append(f)
    return out


def plan(app: str) -> int:
    files = changed(app)
    all_applying = [c for c in CHECKS if applies(c, app, files)]
    todo = [c for c in all_applying if not c.get('by')]
    machine = [c for c in all_applying if c.get('by')]
    rec = read_record(app)
    commit = head()
    print(f'{app} {version(app)} - {len(files)} shipped file(s) changed since {last_tag(app) or "the beginning"}')
    print(f'commit {commit[:10]} - an answer is about this commit, and stops counting if the code moves.')
    print()
    if not todo:
        print('Nothing shipped changed: there is nothing here for you to run.')
        return 0
    print('Run these on a real org, then record what happened. Nothing here is derivable, which is')
    print('why it is being asked rather than checked.')
    print()
    for n, c in enumerate(todo, 1):
        was = (rec.get('checks') or {}).get(c['id'])
        moved = stale_for(c, app, (was or {}).get('commit', '')) if was else []
        mark = '' if not was else (f'   [recorded {was["result"]}'
                                   + ('' if not moved else f', and {len(moved)} file(s) it covers have changed since')
                                   + ']')
        print(f'  {n}. {c["title"]}{mark}')
        for step in c['do']:
            print(f'       - {step}')
        print(f'     pass: {c["pass"]}')
        print()
    if machine:
        # Named, not silently absent. «What is being checked for me» is the other half of «what am I
        # being asked», and a list that shrinks without saying why reads as a list that forgot.
        print(f'Already run for you, on this commit ({len(machine)} of {len(all_applying)}):')
        for c in machine:
            print(f'  - {c["title"]}')
            print(f'      {c["by"]}')
        print()
    print('Answer with the numbers above:')
    print(f'  python3 tools/handcheck.py {app} --pass 1,2,3')
    print(f'  python3 tools/handcheck.py {app} --fail 4 --note "what you saw"')
    left = uncovered(app, files)
    if left:
        print()
        print('And these changed with nothing here covering them - add an entry to CHECKS, or say')
        print('why one is not needed, before the release:')
        for f in left:
            print(f'  {f}')
    return 0


def record(app: str, ids: list, result: str, note: str) -> int:
    files = changed(app)
    todo = [c for c in CHECKS if applies(c, app, files) and not c.get('by')]
    rec = read_record(app)
    rec.setdefault('checks', {})
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    for i in ids:
        if not (1 <= i <= len(todo)):
            print(f'{i} is not one of the {len(todo)} things asked for. Run the tool with no flags.')
            return 1
        c = todo[i - 1]
        rec['checks'][c['id']] = {'result': result, 'at': now, 'commit': head(),
                                  'version': version(app), 'title': c['title'],
                                  **({'note': note} if note else {})}
        print(f'  {c["id"]}: {result}')
    p = record_path(app)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(rec, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    # `relative_to` throws when the record is not under the repository, which is only ever true in a
    # test - and a tool that dies while *reporting* what it just wrote is a poor way to find that out.
    where = p.relative_to(ROOT) if str(p).startswith(str(ROOT)) else p
    print(f'recorded in {where} - commit it with the release.')
    return 0


def check(app: str) -> int:
    """What release.sh asks. Anything but a full set of passes on this exact commit is a refusal.

    Only the entries a person is asked for: one a machine runs is checked by that machine on every run
    of the battery, and asking for it twice would teach him to type `--pass` at a list he has not
    read - which is how a gate becomes a formality."""
    files = changed(app)
    todo = [c for c in CHECKS if applies(c, app, files) and not c.get('by')]
    rec = read_record(app)
    commit = head()
    problems = []
    for c in todo:
        was = (rec.get('checks') or {}).get(c['id'])
        if not was:
            problems.append(f'{c["id"]}: never run - «{c["title"]}»')
        elif was['result'] != 'pass':
            problems.append(f'{c["id"]}: recorded as {was["result"]}'
                            + (f' - {was["note"]}' if was.get('note') else ''))
        else:
            moved = stale_for(c, app, was.get('commit', ''))
            if moved:
                problems.append(f'{c["id"]}: run on {was["commit"][:10]}, and what it exercises has '
                                f'changed since - {", ".join(moved[:3])}'
                                + (f' and {len(moved) - 3} more' if len(moved) > 3 else ''))
    left = uncovered(app, files)
    for f in left:
        problems.append(f'{f} changed and no manual check covers it - add one to tools/handcheck.py')
    for p in problems:
        print('  ' + p)
    print()
    if problems:
        print(f'{len(problems)} finding(s). The release needs what only you can run, on this commit.')
        print(f'  python3 tools/handcheck.py {app}')
        return 1
    # What it means and not what is convenient to print: the answers were given on the commits below,
    # and they still stand because nothing they exercise has moved since. Printing HEAD here read as
    # «he ran them on this commit», which is a claim about a person and would have been false.
    when = sorted({(rec['checks'][c['id']].get('commit') or '?')[:10] for c in todo})
    print(f'{len(todo)} manual check(s) still standing at {commit[:10]}, answered on '
          + ', '.join(when) + ' - nothing they exercise has changed since.')
    return 0


def main() -> int:
    # First, before argparse: the parser reads apps/ to know the product names, so a copy elsewhere
    # died on a traceback rather than on the sentence written for exactly this. A guard that only
    # fires after the thing it guards has already thrown is the shape of guard this repository keeps
    # finding - «a check that skips when the thing is absent is not a check».
    if not in_its_repository():
        print('This is a copy: it is only correct inside the Zoost repository, where the manifest, the')
        print('tags and the record it writes all are. Run it there - and if you are reading a plan on')
        print('another machine, that file is the thing that travels.')
        return 2
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('app', choices=[p.name for p in sorted((ROOT / 'apps').iterdir()) if p.is_dir()])
    ap.add_argument('--pass', dest='passed', help='ids that were run and worked, e.g. 1,2')
    ap.add_argument('--fail', dest='failed', help='ids that were run and did not')
    ap.add_argument('--note', default='', help='what you saw - kept with the answer')
    ap.add_argument('--check', action='store_true', help='what tools/release.sh asks before tagging')
    ap.add_argument('--plan-file', help='write the plan there as plain text, for the machine you test on')
    a = ap.parse_args()
    if a.plan_file:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            plan(a.app)
        pathlib.Path(a.plan_file).write_text(out.getvalue(), encoding='utf-8')
        return 0
    if a.check:
        return check(a.app)
    if a.passed or a.failed:
        ids = lambda s: [int(x) for x in s.split(',') if x.strip()]
        rc = 0
        if a.passed:
            rc |= record(a.app, ids(a.passed), 'pass', a.note)
        if a.failed:
            rc |= record(a.app, ids(a.failed), 'fail', a.note)
        return rc
    return plan(a.app)


if __name__ == '__main__':
    raise SystemExit(main())
