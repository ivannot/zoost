#!/usr/bin/env bash
# tools/release.sh <app>
#
# Cuts a release tag. It deliberately does **not** produce the file you upload.
#
# That used to be its job, and that was the weak link: a package built on this laptop and uploaded
# from it asks a reviewer to take the author's word that the two match the tagged commit.
# Now the tag is the trigger — GitHub checks out that commit, builds it, proves the build is
# deterministic by doing it twice, attaches the archive to a Release and signs a provenance
# statement for it. The log is public.
#
# So the rule is: **upload the asset from the GitHub Release, never a local build.** A local build of
# the same commit should be byte-identical, and this script checks that before letting you tag — but
# identical-in-principle is not the same as the artifact anyone can trace, and only one of the two
# has GitHub's signature on it.
set -euo pipefail

# macOS ships `shasum`, most Linux ships `sha256sum`, and WSL has both only sometimes. The hash is
# the thing this whole chain rests on, so it must not depend on which of the two is installed.
sha256() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi; }
cd "$(dirname "$0")/.."

APP="${1:-}"
[[ -n "$APP" && -f "apps/$APP/manifest.json" ]] || { echo "usage: tools/release.sh <crm|analytics>"; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "The tree is dirty. A release has to be a commit someone else can check out — commit or stash first."
  git status --short
  exit 1
fi

VERSION=$(python3 -c "import json;print(json.load(open('apps/$APP/manifest.json'))['version'])")
TAG="$APP-v$VERSION"
SHORT=$(git rev-parse --short HEAD)
ZIP="dist/zoost-$APP-$VERSION-store.zip"

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && {
  echo "Tag $TAG already exists — bump the version in apps/$APP/manifest.json first."; exit 1; }



# The release notes, and the release stops without them.
#
# `release.yml` already writes a body — the hash, the commit, the verification commands — and that
# body looked complete, which is exactly why nobody noticed there was nothing in it about what
# changed. Two different questions: how the archive was built, and what the person who installs it is
# getting. 69 commits reached one submission with an answer to only the first.
#
# The Chrome Web Store has no field for this (checked: the Store listing tab has no per-version note
# anywhere), so the Release **is** the only place these can be published. That makes forgetting them
# unrecoverable rather than untidy, which is why this refuses to tag instead of warning.
NOTES="store/$APP/whatsnew/$VERSION.md"
if [[ ! -s "$NOTES" ]]; then
  echo "No release notes at $NOTES."
  echo
  echo "The Release body is the only place they can be published — the Store has no field for them."
  echo "Gather the raw material, then write it for somebody who has the extension installed:"
  echo
  echo "    python3 tools/whatsnew.py $APP"
  echo
  echo "Then write $NOTES and commit it."
  exit 1
fi

# Fail here rather than in CI: a non-reproducible build makes every published hash meaningless, and
# The battery, before the tag rather than beside it.
#
# This refused a dirty tree and nothing else, so a red suite could be tagged: the one step that is
# public and irreversible was the one step that checked least. What it checks here is that the store
# copy still matches the manifests and that no absolute claim has gone out unread.
#
# `--before-tag`, not `--offline`: the live comparison says nothing until the commit is pushed, which
# is the step after this one, and `--offline` reports that skip as a *finding* - deliberately, so a
# session cannot call something fixed while nothing is deployed. Behind this gate that made it
# unpassable: it refused every run, over a line nobody could act on, from the hour it landed until
# somebody tried to cut a release. Proving a check can fail is half of it; this is the other half.
echo "== the battery, before anything public happens"
bash tests/run.sh >/dev/null || { echo "The suite is red. A tag is public; fix it first."; exit 1; }
python3 tools/auditcheck.py --before-tag >/dev/null || {
  echo "auditcheck has findings. Run: python3 tools/auditcheck.py --before-tag"; exit 1; }
echo "   suite and checkers pass"

# And the half of the testing that no machine here can do. A defect that made every Pull all fail
# reached a submitted package: nothing in this repository executed a pull, and the parts that need a
# real Zoho org cannot be executed here by anyone. `tools/probe.py` now runs both pulls headless
# against the sample workspace; what is left needs an org, a role, a data centre and a person.
#
# So the author is in the chain rather than around it: he runs what only he can run and records the
# answer, and this refuses to tag without it. The record names a commit, so an answer about code that
# has since changed does not count - which is the property that makes it a gate and not a ritual.
echo "== what only a person can run"
python3 tools/handcheck.py "$APP" --check || {
  echo
  echo "The manual checks are not recorded for this commit. What to run, and how to answer:"
  echo "    python3 tools/handcheck.py $APP"
  exit 1; }

# The build has to be deterministic, and this is where that is proven cheaply:
# finding that out after the tag is pushed means an orphaned tag to clean up.
./build.sh "$APP" >/dev/null
A=$(sha256 "$ZIP" | cut -d' ' -f1)
./build.sh "$APP" >/dev/null
B=$(sha256 "$ZIP" | cut -d' ' -f1)
if [[ "$A" != "$B" ]]; then
  echo "The build is not reproducible on this machine — two runs of the same commit differ:"
  echo "  $A"
  echo "  $B"
  echo "Fix build.sh before tagging: a hash nobody can reproduce is worse than none."
  echo "The two archives are left in dist/ for you to compare."
  exit 1
fi

# The proof is the hash, not the file. A local .zip of the version being released is exactly the
# archive this whole chain says must never be uploaded - so it does not survive the check that
# produced it. dist/ had grown to 72 of them, one per version ever built here, any one of which
# could have been dragged into the dashboard by mistake.
rm -f "$ZIP" "dist/zoost-$APP-$VERSION-unpacked.zip"

git tag -a "$TAG" -m "Zoost for $APP $VERSION

commit  $(git rev-parse HEAD)

Built and attested by GitHub Actions on this tag. The archive to submit is the asset
on the Release, not a local build. Verify with:

  gh attestation verify zoost-$APP-$VERSION-store.zip --repo ivannot/zoost
  tools/verify.sh $APP $VERSION"

# The screenshots on the listing are pictures of an interface, and a release that changed one has to
# replace them. That step lived only in the routine, so it depended on somebody remembering it at the
# end of a long day - which is how a listing ends up showing a product two versions old, and how this
# one did: Analytics was carrying 1.23.0's pictures into a 1.26.0 release, and the CRM's set had no
# recorded version at all. Whether they *look* different cannot be known without rendering them;
# whether they were taken of a different version can, and that is the question worth asking here.
SHOTS_VER=$(python3 -c "import json,sys;print(json.load(open('store/'+sys.argv[1]+'/screenshots.json')).get('version','unknown'))" "$APP" 2>/dev/null || echo unknown)
SHOTS_NOTE=""
if [ "$SHOTS_VER" != "$VERSION" ]; then
  SHOTS_NOTE="
    !   the screenshots on the listing are of $SHOTS_VER and this release is $VERSION:
        python3 tools/shots.py    then upload dist/store/$APP/1..5.png beside the package"
fi

cat <<EOF

  tag        $TAG   (local — not pushed)
  commit     $SHORT
  local hash $A
             ↑ this should match what CI publishes. If it does not, stop and find out why
               before uploading anything.

  Next:
    1.  git push --follow-tags
    2.  wait for two workflows: 'release' builds it twice, signs a provenance statement and
        publishes the Release - and 'store upload' then puts that archive on the item as a
        **draft**, by itself. Nobody downloads or uploads anything by hand.
    3.  open the dashboard: check the draft is there, upload dist/store/$APP/1..5.png if the
        interface moved, paste anything the listing needs, then press Submit for review
    4.  paste the RELEASES.md row from the Release body, commit, push$SHOTS_NOTE

  What reaches the Store is the archive CI built and signed. A local build is not the artifact
  anyone can trace, and nothing in this chain uploads one - which is why step 2 has no work in it.
EOF
