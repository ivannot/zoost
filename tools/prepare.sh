#!/usr/bin/env bash
# tools/prepare.sh — derive everything a change implies, then check it. Stops at the first finding.
#
# These were five commands run by hand, in an order that matters, every time anything moved: render
# the images, stamp the pages, move the translation markers, rebuild the sitemap, run the battery.
# Forgetting one leaves the site describing a product that has moved, which is the class of thing
# this repository spends its length preventing - so it is one command, and the order is written down
# once instead of remembered each time.
#
# It derives and it verifies. It does not commit, does not tag and does not push: those are
# decisions. `auditcheck` is deliberately not here either - it compares the live site against the
# repository, which says nothing until the commit is pushed. `tools/release.sh` runs it.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Order matters, and each line says why it is where it is.
step 'images — rendered only where a source that can change a pixel has moved'
python3 tools/siteimg.py

step 'stamps — the version and date each page prints, and every asset URL, from their own bytes'
python3 tools/stamp.py

step 'translation markers — after the English pages have settled, never before'
python3 tools/sitecheck.py --retranslated

step 'sitemap — lastmod comes from git, so it is rebuilt after the files are final'
python3 tools/sitemap.py

step 'the battery'
bash tests/run.sh

step 'the panels, driven — what a unit test cannot see: a click, a key, the state afterwards'
python3 tools/probe.py

step 'images again — the derived checks, now that the pages are stamped'
# `--publishing`: this is the one moment a picture older than the panel is a defect rather than a
# queue. The battery prints the same fact and does not refuse, because rendering the set costs seven
# minutes and a day of panel work would spend it over and over on files that come out identical.
python3 tools/imgcheck.py --publishing

printf '\n\033[1mReady to commit.\033[0m auditcheck runs after the push, and release.sh runs it for you.\n'
