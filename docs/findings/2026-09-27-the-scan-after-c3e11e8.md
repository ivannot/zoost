# The scan after `c3e11e8`: three residues, and what checking them cost

A second plan arrived hours after the first, read against the commit the first one produced. Its
summary was accurate and its restraint is why it was worth executing: no P0, no architectural
programme, and an explicit stop - no React, no wholesale TypeScript, no coverage target, no further
splitting without a measured boundary.

Three P1 items, two P2, two P3. What follows is what happened to each, and the two defects found
while doing it - both in checks written to prove the work, both invisible until they were planted
against.

---

## P1.2 The upgrade fixture told three stories at once

It mixed values 1.x really wrote, values deliberately malformed, and one key that could not reach
that storage at all - `previewW`, which only the CRM panel writes, in a fixture for Analytics, whose
extension has separate storage. The note above the fixture said every value was in the shape the
named versions wrote. Two of those three classes make that sentence false.

**The fix is one table, not two fixtures.** `UPGRADE_KEYS` in `tools/probe.py` carries provenance,
key, value, the product that wrote it, what 2.0 does with it, and a class - `real` for a state a
user can arrive at, `synthetic` for one nobody can. The two fixtures are *derived* from it: the
upgrade scenario seeds the real rows, the corruption scenario seeds real and synthetic together, so
the second is the same install with one value spoiled. `storage-manifest.json` names the table
instead of listing the keys again; three copies of one fact is how the first version came to hold a
key no version had written.

**And the check written to hold that could not see the defect it was written for.** It compared each
row's provenance with its product's tag and its class with its provenance - both of which a
fabricated row satisfies. Planting `sidePanelMode` back, claiming `crm-v1.53.0` and class `real`,
the suite stayed green. The only ground truth is the tree that version shipped, so the tree is what
is asked now: `git grep` the key in the tag, and a row no file of that tag mentions is a finding.
Planted again, it goes red. Where the tag is not in the checkout - a shallow clone has no tags - the
case skips and says so, because a provenance claim cannot be checked without the tree that made it.

## P1.3 One control run proved one assertion

The negative control - the scenario over an empty store - stops at the first failure, so it proved
the data centre and carried everything after it. «The rest would obviously fail too» is the
reasoning that put a decoration in the tree in the first place.

Each promise now has its own pair, in `tests/panel.test.mjs`, running the loader the product
actually uses: once over the value 1.x stored and once over an empty store, asserting the two
differ. Removing one key turns exactly one of them red. Three so far - the data centre, the hidden
tab, the preview height - and the height's case also pins the *shape*: 1.x stored a CSS string, and
a number sets nothing at all, silently.

**One of those cases accused the product of a defect it does not have.** An empty array built inside
the `vm` context has that context's prototype, and strict `deepEqual` compares prototypes - so a
correct reader was reported as reading old preferences as «skip the pull». The values are re-made in
the test's own realm before they are compared.

## P1.1 The manual checks are stale, and only he can move them

`handcheck --check` reports eight expired for each product: the answers name `8620953945` and the
files they cover have changed. Nothing here can run them - they need an org, a role, a data centre
and a person - so the plan and the material are produced and the answer is his. Not recorded until
he says what happened, which is the whole value of the step.

## P2.1 and P2.2 The sweep was lying in one direction, then fixed and read

`deadcode.py` excluded every identifier after a dot so `obj.foo` would not keep a declared `foo`
alive - and the third dot of a spread is a dot, so `...pullDepth(...)`, which is how five shipped
files call it, scored nothing. A list whose purpose is to say what to delete carried a name the
product calls. The decision needs the two characters before the dot, which `re` cannot express as a
lookbehind, so it is made in Python.

The tool also gained a third verdict. A name declared twice in one product is **ambiguous**, not
dead: the tally cannot tell two scopes apart, so a dead alias scores its namesake's uses. That was
`removeFileAt` yesterday, found by a reader and not by the tool.

Six removals followed, each with the sweep re-run after it: `openTargetZoho` and its stale comments,
`ZOHO_HOST_RE`, two loops in the CRM export that sorted and walked every function and every module
to compute one local each and discard it, and two aliases. An assertion went with the first: it
grepped for a line inside the deleted function, and a check that greps for a spelling no file
contains passes for ever and guards nothing.

What is left is six candidates, and they are the six the plan says to keep - contracts the suite
holds and structural landmarks.

## P3 Recorded, not attempted

Both products are still `PENDING_REVIEW`; the post-publication checks cannot run against an artefact
Google has not published. And no further extraction from `analytics/workbench.js`: the plan's own
condition is a measured boundary, and there is not one.

---

## The rules it left behind

- **A check written to catch a fabrication must be tested against a fabrication.** Comparing a
  claim with another field of the same claim is self-consistency, not verification. Ask the source
  the claim is about - here, the tagged tree - and plant the original defect to prove the question
  is being asked.
- **One fact, one table; fixtures are derived from it.** Two hand-written fixtures and a manifest
  listing the same names is three places to disagree, and the disagreement is silent.
- **A negative control stops at its first failure, so it proves one thing.** Every promise that is
  worth making gets its own pair - with the value, and without it.
- **A value built inside a `vm` context is not comparable to one built outside it.** Strict
  `deepEqual` compares prototypes; re-make it in the asserting realm or the failure will be about
  the harness and read as being about the product.
- **Delete the assertion with its subject.** A check that greps for a line no file contains is worse
  than a missing one: it is green for ever and guards nothing.
