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
# finding that out after the tag is pushed means an orphaned tag to clean up.
./build.sh "$APP" >/dev/null
A=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)
./build.sh "$APP" >/dev/null
B=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)
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

cat <<EOF

  tag        $TAG   (local — not pushed)
  commit     $SHORT
  local hash $A
             ↑ this should match what CI publishes. If it does not, stop and find out why
               before uploading anything.

  Next:
    1.  git push --follow-tags
    2.  wait for the 'release' workflow, then open the GitHub Release it created
    3.  DOWNLOAD the .zip asset from that Release and upload THAT to the Chrome Web Store
    4.  paste the RELEASES.md row from the Release body, commit, push

  Step 3 is the whole point. A local build is not the artifact anyone can trace.
EOF
