# Releases

Every version submitted to the Chrome Web Store, with the commit it was built from and the SHA-256
of the package that was uploaded.

The point is that **you do not have to take our word for it.** The build is reproducible: the same
commit produces the same bytes on any machine, because every file is stamped with the commit's own
date, the file list is sorted before it reaches `zip`, and machine-specific attributes are dropped.
So the hash below is not a fact about our laptop — it is a fact about the source, and you can check
it:

```bash
git clone https://github.com/ivannot/zoost && cd zoost
git checkout <tag>
./build.sh <app>
shasum -a 256 dist/zoost-<app>-<version>-store.zip
```

If that number matches the row below, the package on the Web Store was built from exactly the source
in this repository at that tag, and nothing else went into it.

| App | Version | Tag | Commit | SHA-256 of the uploaded `.zip` | Submitted |
|---|---|---|---|---|---|
<!-- release rows are appended here, newest last -->
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

## Making a release

```bash
tools/release.sh <crm|analytics>
```

It refuses a dirty tree, builds twice and compares the two hashes before writing anything down — a
number nobody can reproduce is worse than no number — then tags the commit and appends the row here.
Pushing and uploading stay manual, because both leave this machine.
