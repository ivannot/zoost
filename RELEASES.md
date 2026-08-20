# Releases

Every version submitted to the Chrome Web Store, with the commit it was built from and the SHA-256
of the package that was uploaded.

**There is no date column, deliberately.** Each row's tag is timestamped by GitHub and its Release
carries the build's log, so *when* it was built is a fact anyone can read from the system that holds
it. When the package was handed to Google is not recorded by anything - the Store API reports which
state a revision is in and never when it entered that state - so a date here would be a number I
typed, unverifiable by construction and free to disagree with the record it sits beside. What state a
submission is in is on `zoost.it`, from Google.

The point is that **you do not have to take my word for how the release asset was built.** The build
is reproducible: the same commit produces the same bytes, because every file is stamped with the
commit's own date, the file list is sorted before it reaches `zip`, and machine-specific attributes
are dropped. So the hash below is not a fact about my laptop - it is a fact about the source, and
you can check it:

```bash
git clone https://github.com/ivannot/zoost && cd zoost
git checkout <tag>
./build.sh <app>
shasum -a 256 dist/zoost-<app>-<version>-store.zip
```

If that number matches the row below, the archive published on the Release was built from exactly
the source in this repository at that tag, and nothing else went into it.

Note the precise claim, because the looser one would be false: this establishes how the *release
asset* was produced. The upload to the Store is done by a workflow, from that same asset, so the file
Google receives is the one this proves; what is still by hand is pressing Submit in the dashboard,
which is a decision and moves no bytes. What none of it establishes is the far end - unpack the
installed extension and diff it against the tag. See *What this cannot prove*.

<!-- release rows are appended below the header, newest last -->

| App | Version | Tag | Commit | SHA-256 of the uploaded `.zip` |
|---|---|---|---|---|
| analytics | 1.0.0 | `analytics-v1.0.0` | `b3db394` | *not reproducible - see below* |
| crm | 1.9.0 | `crm-v1.9.0` | `dd94209` | `f34c5ce4a5a38d2f080b29f00e9c8d016dd74bfc84eb2575485c4e1b5ac6344e` |
| crm | 1.11.0 | `crm-v1.11.0` | `c226a5c` | `554e1e57df816b09f8b9e349614a9efc5920449c52c66cc3c8ecfc753480026e` |
| analytics | 1.7.0 | `analytics-v1.7.0` | `c226a5c` | `95659118aed2f3f29b4b1cffe2318f186ffd52553dfdc48347d72e892a07b78c` |
| analytics | 1.7.1 | `analytics-v1.7.1` | `037c50b` | `fd06cc3c70ea8d99d25d7fabc02790ca0dd02c993e5f3c1bb747518dd8f008c5` |
| analytics | 1.8.0 | `analytics-v1.8.0` | `6000f1f` | `6c2ad99e6767bbcdd10c933633c27989ef1d16a26926e2e2853d3c1204cd1f15` |
| crm | 1.38.4 | `crm-v1.38.4` | `6df6603` | `5818741130e1b683b9e784402b591493e03803fb9f086204391b808ddc4e1045` |
| analytics | 1.22.4 | `analytics-v1.22.4` | `3d03074` | `a6c8d4c0935c44851e706d8b809c01eb8be0489e4a259e5f7dcf04ce81181781` |
| crm | 1.39.0 | `crm-v1.39.0` | `5d101c8` | `07b2eeab2d36f1db349907f9de747406805a3fa27950331d5be4f4411a625bc2` |
| analytics | 1.23.0 | `analytics-v1.23.0` | `696e1b3` | `6e1de636c23ddec259491456663004c4fd183ca024bcf31d2acfdfaf027f872c` |
| crm | 1.40.0 | `crm-v1.40.0` | `29757220bac0b4f852421373dd95343e21cfa93c` | `a075cd67154fe26d9f02ad54f7be6d9888886946ac4012f3daf51e156b4d9cdc` |
| analytics | 1.26.0 | `analytics-v1.26.0` | `22f6896052795eddf666d514576c765f3a0ab372` | `77719c67a412ffd00af5f106e0e19e61a7e7b759c2e69c63a2673834034df82d` |
| crm | 1.43.0 | `crm-v1.43.0` | `22f6896052795eddf666d514576c765f3a0ab372` | `037f731f0ca31c8d7b5959b0c022633ea430429c518575863ae8679682dbabc8` |
| crm | 1.44.0 | `crm-v1.44.0` | `1fa4eed57e06a6cf6d766bb6c6160a5b22d6d7f6` | `7941fc51cf074aa8e4b865138db082dbb71561acece44c76c5010039ccc4c7e8` |
| analytics | 1.27.0 | `analytics-v1.27.0` | `1fa4eed57e06a6cf6d766bb6c6160a5b22d6d7f6` | `6197f4fc6e7ffe3f1a284d7f85c8e7a09cbbd720a5c92d7bb9bad918ca06bf2a` |
| crm | 1.45.0 | `crm-v1.45.0` | `55eb3663ee7f38d49eeee9626e9accfee4908ca2` | `114f080e38af603a0e03681ec09f4acdd4d79a67f273ac716ad25f10bcd9cdb0` |

## What this table cannot tell you, and why

**No Zoho CRM version before 1.9.0 is in this table, and the reason differs by version.**

**Nothing in this file is written in the present tense, and that is deliberate.** A ledger is
appended to and never revised, so a sentence about which version the Store happens to serve is a
sentence that will be false within the week - and this section has already been corrected twice. Where the
current state matters, the badge on [zoost.it](https://zoost.it) reads it from the Store's own API
and from this repository's tags; this file says what happened, with the date it happened on.

**Zoho CRM 1.0.0 has a tag and buildable source, but no hash.** It was the published version until
1.9.0 replaced it. The tag `v1.0.0` points at commit `89422fe`, which carries the whole extension under `src/` with a
`src/manifest.json` at version 1.0.0, and `build.sh` at that commit produces `zoost-1.0.0-store.zip`.
So the source is identified and anyone can rebuild it. What is missing is the hash of the archive
actually uploaded that day: it was built before the build was deterministic, so no number published
now could be checked against it. **Identified and buildable, not verifiable byte for byte.**

**0.13.8 and anything earlier predate this repository entirely**, so for those there is neither a
commit nor a hash.

**The chain begins at 1.9.0**, the first release built by GitHub from a tag, attested, and uploaded
as the artefact that build produced.

Two corrections have been made to this section, and they are recorded rather than tidied away,
because a verifiable record that edits its own mistakes out of history is worth less than none.
The first claimed 0.13.8 was the published version and that the earliest commit here was 1.0.0 -
both stale. The second, correcting it, claimed the source entered the repository only at 1.6.2 and
that `v1.0.0` held nothing installable. That was wrong too, and wrong through carelessness: the tree
listing was read truncated, `src/` sits below `site/` alphabetically, and the conclusion was drawn
from the part that had been cut off. It was reported by an outside reader. Of everything in this
file, this is the section that had least business being inaccurate.

**Zoost for Zoho Analytics 1.0.0** was built from commit `b3db394`, before the build was made
reproducible. Its tag exists and points at the right source, but no hash is recorded
for it: the file uploaded that day was built by the old, non-deterministic script, so any number published now would be one nobody could reproduce.

**A hash proves what was built, not what was reviewed.** Google re-signs and repackages what it
serves, so the `.crx` a user installs is not byte-identical to the `.zip` that was uploaded. What this
table lets you verify is the input to that process: that the source in this repository, at that tag,
is what was submitted.

**The tag `v1.0.0` is from before this repository held two products**, when a bare version number was
unambiguous. It identifies real, buildable source - see above - and is left in place rather than
renamed, because moving a published ref is worse than an untidy one. Every tag from here on is
`<app>-v<version>`.

## How the package is produced, and why that matters

Nothing here is built on a laptop any more.

Pushing a tag `crm-v*` or `analytics-v*` makes GitHub check out that exact commit, build it, prove
the build is deterministic by doing it **twice** and comparing, attach the archive to a Release, and
sign a [provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations)
binding that file to this repository, that commit and that workflow. The workflow is
[`.github/workflows/release.yml`](.github/workflows/release.yml) - read it; it is short, does
nothing clever, and every action it uses is pinned to a commit hash rather than a moving tag. The
build log is public.

**The archive attached to the Release is the file submitted to the Chrome Web Store.** Nothing is
rebuilt in between, and nothing is uploaded from a personal machine. That is the rule the whole
chain rests on.

Three things you can check, in increasing order of paranoia:

```bash
# 1. GitHub itself says it built this archive, from this repo, at this commit
gh attestation verify zoost-<app>-<version>-store.zip --repo ivannot/zoost

# 2. the same source produces the same bytes on your machine
tools/verify.sh <app> <version>

# 3. read what is actually inside - a couple of dozen files, no bundler, no minifier, no deps
unzip -l zoost-<app>-<version>-store.zip
```

The third is the one that matters most and takes the least trust. Zoost ships as plain readable
JavaScript and HTML: what you download is what runs, and you can read all of it in an afternoon.
There is no build step that could put something in the package that is not in the repository.

## What this cannot prove

**What Google serves is not byte-identical to what was uploaded.** The Store repackages and re-signs
every extension, so the `.crx` a browser installs cannot be compared to the `.zip` here. What the
chain above establishes is the *input* to that process. To check the far end, unpack the installed
extension from your Chrome profile and diff its files against the tag - they are plain text. It is
the only check left that nothing else covers: the upload itself is a workflow reading the Release
asset, so the gap is no longer between this repository and Google, it is between what Google was
given and what Google serves.

**Diff against the tag of the version you actually have, not the newest one here.** Google publishes
days after a submission, not minutes - how many is Google's to decide - so the newest tag in this
table is routinely ahead of the published one, and a version still in review is not published at all. The
installed extension states its own version on `chrome://extensions`; `<app>-v<that version>` is the
tag it has to match. Diffing against the newest tag instead produces a mismatch that means nothing
except that the release cycle is doing what it does.

**An attestation says who built a file, not that the file is good.** It removes "trust the author's
laptop" from the chain. It does not remove "read the code", and nothing can.

**Reproducibility is claimed for an environment, not for every machine on earth.** `build.sh` drives
whatever `zip` is on the system, and a different implementation could in principle deflate the same
bytes differently. It is verified on two: Info-ZIP 3.0 on macOS, and whatever `ubuntu-latest` carries
in CI, where every release is built twice and the run fails if the hashes differ. Each build prints
the archiver it used, so the log says which. Making the guarantee universal would mean pinning the
toolchain in a container; that is not done, and claiming it were would be the kind of
overstatement this file exists to avoid.

## Making a release

```bash
tools/release.sh <crm|analytics>   # checks the tree is clean and the build reproducible, then tags
git push --follow-tags             # this is what starts the public build
```

Then, when the workflow finishes: download the `.zip` **from the Release it created**, upload that
file to the Chrome Web Store, and paste the `RELEASES.md` row from the Release body.

`release.sh` no longer produces the file you upload, on purpose. It used to, and that was the weak
link: a package built here and uploaded from here asks a reviewer to take the author's word for it.
