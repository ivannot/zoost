#!/usr/bin/env bash
# tests/run.sh — everything, in one command, with nothing installed.
#
# No framework, no dependencies, no build step: node's own test runner and Python's unittest, both
# already on any machine that can build this project. That is the same rule the extensions follow —
# a test suite that needs `npm install` would be the first dependency in a repository whose pitch is
# that it has none.
#
# What is covered, and what is not, stated plainly because a coverage claim nobody can check is
# worth as much as a hash nobody can reproduce:
#
#   covered — pure logic that has actually broken: the Deluge comment/string scanner, which CSRF
#     cookie belongs to which family, how staleness is derived per area, how a tag is read out of an
#     Atom feed, how a version is scraped from a page we do not control, and the three checkers.
#
#   not covered — anything that needs a DOM, a browser, a file handle or Zoho. The panels are
#     browser scripts and are not restructured to be importable: doing that refactor *in order to*
#     add tests would spend the risk before earning the cover. Helpers are lifted out and run alone
#     (see slice.mjs), which proves the logic and not the wiring. A correct function called from the
#     wrong place still passes here.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── unit: node ──"
node --test --test-reporter=spec tests/*.test.mjs

echo
echo "── unit: python ──"
python3 tests/tools_test.py 2>&1 | tail -3

echo
echo "── checks ──"
python3 tools/twincheck.py | tail -1
python3 tools/sitecheck.py | tail -1
python3 tools/namecheck.py | tail -1
python3 tools/featurecheck.py | tail -1
python3 tools/htmlcheck.py | tail -1
python3 tools/sitemap.py --check | tail -1

echo
echo "── build ──"
./build.sh crm >/dev/null && ./build.sh analytics >/dev/null && echo "both apps package"
