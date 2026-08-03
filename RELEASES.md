# Releases

Every version submitted to the Chrome Web Store, with the commit it was built from and the SHA-256
of the package that was uploaded.

The point is that **you do not have to take our word for how the release asset was built.** The build
is reproducible: the same commit produces the same bytes, because every file is stamped with the
commit's own date, the file list is sorted before it reaches `zip`, and machine-specific attributes
are dropped. So the hash below is not a fact about our laptop — it is a fact about the source, and
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
asset* was produced. Uploading it to the Store is a manual step, so nothing here cryptographically
proves the file Google received is that one. What closes that circle is at the far end — unpack the
installed extension and diff it against the tag. See *What this cannot prove*.

<!-- release rows are appended below the header, newest last -->

| App | Version | Tag | Commit | SHA-256 of the uploaded `.zip` | Submitted |
|---|---|---|---|---|---|
| analytics | 1.0.0 | `analytics-v1.0.0` | `b3db394` | *not reproducible — see below* | 2026-08-03 |

## What this table cannot tell you, and why

**Zoho CRM 0.13.8, the version on the Store today, is not in this table and cannot be.** It predates
this repository — the earliest commit here is CRM 1.0.0, on 2 August 2026 — so there is no commit to
point at and no honest hash to publish. The chain starts at the first submission made after this file
existed. Saying so is the whole point: a verifiable record that quietly papered over its first entry
would be worth less than no record.

**Zoost for Zoho Analytics 1.0.0** was submitted on 3 August 2026 from commit `b3db394`, before the
build was made reproducible. Its tag exists and points at the right source, but no hash is recorded
for it: the file uploaded that day was built by the old, non-deterministic script, so any number we
published now would be one nobody could reproduce.

**A hash proves what was built, not what was reviewed.** Google re-signs and repackages what it
serves, so the `.crx` a user installs is not byte-identical to the `.zip` we uploaded. What this
table lets you verify is the input to that process: that the source in this repository, at that tag,
is what was submitted.

**The tag `v1.0.0`** is from before this repository held two products, when a bare version number was
unambiguous. It is left alone rather than deleted — moving published refs is worse than an untidy
one. Every tag from here on is `<app>-v<version>`.

## How the package is produced, and why that matters

Nothing here is built on a laptop any more.

Pushing a tag `crm-v*` or `analytics-v*` makes GitHub check out that exact commit, build it, prove
the build is deterministic by doing it **twice** and comparing, attach the archive to a Release, and
sign a [provenance attestation](https://docs.github.com/actions/security-guides/using-artifact-attestations)
binding that file to this repository, that commit and that workflow. The workflow is
[`.github/workflows/release.yml`](.github/workflows/release.yml) — read it; it is short, does
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

# 3. read what is actually inside — a couple of dozen files, no bundler, no minifier, no deps
unzip -l zoost-<app>-<version>-store.zip
```

The third is the one that matters most and takes the least trust. Zoost ships as plain readable
JavaScript and HTML: what you download is what runs, and you can read all of it in an afternoon.
There is no build step that could put something in the package that is not in the repository.

## What this cannot prove

**What Google serves is not byte-identical to what was uploaded.** The Store repackages and re-signs
every extension, so the `.crx` a browser installs cannot be compared to the `.zip` here. What the
chain above establishes is the *input* to that process. To check the far end, unpack the installed
extension from your Chrome profile and diff its files against the tag — they are plain text, and
this is also what settles the one manual step in the chain, since the upload to Google is done by
hand and no signature covers it.

**An attestation says who built a file, not that the file is good.** It removes "trust the author's
laptop" from the chain. It does not remove "read the code", and nothing can.

**Reproducibility is claimed for an environment, not for every machine on earth.** `build.sh` drives
whatever `zip` is on the system, and a different implementation could in principle deflate the same
bytes differently. It is verified on two: Info-ZIP 3.0 on macOS, and whatever `ubuntu-latest` carries
in CI, where every release is built twice and the run fails if the hashes differ. Each build prints
the archiver it used, so the log says which. Making the guarantee universal would mean pinning the
toolchain in a container; that is not done today, and claiming it were would be the kind of
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
