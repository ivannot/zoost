# Five readers on the architecture tranche - 12 September 2026

Eighteen commits since the published 1.50.0 / 1.32.0 decomposed the CRM panel into eleven modules,
introduced a pull lifecycle, an immutable mirror plan, a structured error model, an architecture
checker and a read-only Zoho canary. The battery was green on arrival. Five readers with no memory of
writing any of it were pointed at what does not work; they found four defects in the product and
three in the gates, and the worst was reported independently by three of them.

## The rules it left behind

Every entry below names what broke, what was done, and the rule that stops it returning.

**A record of the pull refused the pull.** `setPullBusy(true)` began the lifecycle and threw when
`begin()` declined, which it does from any non-terminal state. «Complete missing», its Workflows
twin, and a per-tab pull whose runner ends on a non-busy status all take the lock and advance no
phase, so the lifecycle was abandoned in `reading` - and from then on Pull all, the per-tab pull and a
click on a row's status dot threw *before* their `try`, writing no status, leaving the rejection
unhandled and the buttons enabled. Analytics had the same shape, quieter: the next Pull all re-read
the whole workspace, discarded it and said nothing.

**The fix.** A declined `begin()` cancels the abandoned operation and starts a new one; releasing the
lock at depth zero drives any non-terminal state to `cancelled`.

**The rule.** **Instrumentation may observe an operation; it may never be able to refuse one.** A
lifecycle, a budget, a counter - if the product cannot proceed because its own record says no, the
record has become a gate nobody designed. Held by one case per product, both planted red, and one of
them states in its own comment what it cannot see: with the release closing properly the reopening
branch never fires, so the two guards are each other's net.

**A plan and a walk that named different files deleted the wrong half.** For a compiled function
deleted in Zoho, the walk offered every source inside `<stem>.files/` while the plan named the
directory; only the meta was in both, so the manifest went and the sources stayed - unreachable
afterwards, because every later prune needs that meta.

**The fix.** The filter resolves a project file to the project the plan names.

**The rule.** **When two readings of the same subject meet in a filter, the intersection is only as
correct as their agreement about names** - and a deletion is the wrong place to discover they differ.

**`null` was an answer, and the new envelope validator refused it.** The bridge returns `file: null`
when Zoho no longer has a function - the ordinary race between census and download - and the panel has
a branch for it. The validator rejected it in two places, so the row read «bridge fetchOne response
has invalid file», the branch became unreachable, and the retry logic, finding no HTTP code in that
invented sentence, spent a retry on a function that is gone.

**The fix.** `null` passes; a string, a number or an array still does not.

**The rule.** **A contract check must accept every answer the thing it checks deliberately gives.**
Write the absent case into the contract, or the check will reject the product's own vocabulary.

## The gates

**`architecturecheck.py` could not see its subject.** Both comment strippers carried doubled
backslashes, so the first deleted everything between any two slashes in the file. Measured: 97,908
characters inspected where 99,627 are code, and a `fetch(` planted in a pure module went unreported.
**And the guard written five days ago for this exact class did not fire**, because it looked for one
backslash and this line had two.

**The battery's concurrency lock could never refuse:** the run re-execs inside a temporary copy, and
the lock path was derived from `pwd`.

**The canary wrote evidence it would itself reject:** a bare `--record` produced two profiles where
its verifier requires one.

**The rule for all three.** **A gate is only as good as its ability to say no, and that ability is a
separate thing to test from the rule it enforces.** Each of these was green, and each was green
because it could no longer refuse anything. Where a guard exists for a class - the JavaScript comment
scanner is now the answer for the third time - widen the guard the day a new spelling escapes it.

## Reverted, because the existing rule was right

The Analytics SQL prune refuses to delete anything while the mirror plan is incomplete, so one
unreadable view stops all pruning and a renamed query keeps its old file. That is a real cost, and the
change that removes it was written, tested and **reverted**: `validateMirrorPlan` refuses a partial
plan with deletions on purpose, and the case holding it is the fifth of this repository's six
questions - does partial data authorise a destructive act? The answer stays no. What is worth doing
instead, when somebody meets it, is saying that the prune was skipped rather than leaving it silent.
