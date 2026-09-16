# 16 September 2026 - relations the mirror held and no surface could follow

Five reports in two days, all the same class, every one found by the user and none by this
repository. The product's stated core is relating the objects built inside Zoho; each of these was a
relation **already on disk** that no surface made followable.

## What broke

- A function called by a blueprint transition. The blueprint pane drew the chip; the function's own
  pane said `Used in workflow_rules (1)` and nothing about the process that runs it.
- The task, the notification and the webhook a transition fires: named in the pane as words, while
  all three sat in the actions catalogue the mirror already holds.
- Blueprints were absent from the wiring drawing altogether, so a process that calls a function or
  fires a notification was missing from the one picture whose subject is what connects to what.
- The module of a blueprint was drawn by its internal name, and its chip opened nothing: in the
  modules index a custom module is `api_name: Iscrizioni` with `module_name: CustomModule20`, and the
  blueprints reply puts `CustomModule20` into a field it also calls `api_name`. One key in the wrong
  dimension, fixed four times in the wrong place before the two names were measured.
- The Fields table counted the workflow rules that touch a field and not the blueprints.

## What was done

Each was fixed where it belonged, and the module label is now resolved by either name with the file
read under the one the pull actually writes. But the class is what matters: **the author asked for a
way to intercept these without him finding them.**

`tools/relationcheck.py` is that way. It renders the delivered sample, derives every cross-object
edge out of the files themselves - blueprint to module, to function, to action; workflow to module;
schedule to function; function to connection and to everything Zoho names in `associated_place`;
field to workflow and to blueprint - and requires the panel to emit the attribute that opens each
kind of target. A kind with edges in the data and no opener anywhere is a finding. It was proven in
both directions on the day it was written: renaming `data-bpid` made it name `field->blueprint` and
exit 1, and restoring it returned 0.

`tests/tools_test.py` gained the guard that makes it real: every `tools/*check*.py` must be invoked
by `tests/run.sh`, derived from the folder, with three exemptions named and reasoned. A checker
nobody runs is a rule that only looks enforced.

## The rules it left behind

**A relation the mirror holds must be one the reader can follow, and that is checked by deriving the
relations from the data rather than by listing the surfaces.** Prose did not stop this five times;
a list of surfaces would have been one more thing to keep in step by hand. What the check cannot do
is stated in its own docstring: it proves an opener exists, not that the pane drawing that relation
uses it - a chip emitted on one surface and forgotten on another is the browser probe's ground.
