# Findings - 23 August 2026, a fold that a relayout quietly undoes

One finding, from driving the diagram window rather than reading it. It is written down because it
is **not fixed**: which of two behaviours is wanted is a decision about the product, and the
measurement should not have to be taken a second time to ask the question.

It came out of `fastpath x diagrams`. The ER view skips `erLayout()` when `erLaidOut` is already
true, which is deliberate and says so - «a drawing filter: nothing is laid out again». What the grid
asks of a fast path is not that it be avoided, but that the slow path agree with it.

## 1. A fold is remembered and stops taking effect - medium, not fixed

**What broke.** Driving the CRM diagram on `graph-crm-schema.json`: switch to ER, fold one branch
away, read the window's own state; then force the slow path with `erLaidOut = false; erShow()` and
ask the same questions again.

    after the fold      badge 17   line 17   erHiddenSet 1   erVisibleIds 17   erCut 1   erIds 18
    after the relayout  badge 17   line 17   erHiddenSet 0   erVisibleIds 18   erCut 1   erIds 17

Three things are true at once afterwards and they cannot all be right. The fold is still recorded -
`erCut` has one entry. The fold hides nothing - `erHiddenSet()` is empty, because it replays `erCut`
against reachability and the box it used to hide is no longer in `erIds`, so `erWouldGo` finds
nothing to take away. And `erVisibleIds()` answers 18, counting the folded box as visible again,
because `gone` is empty; the badge reads 17 only because nothing refreshed it.

The layout excluded the box using `erHiddenSet()` *before* it became empty, and the emptiness is a
consequence of that exclusion. Which number a surface reports depends on when it asked.

**The fix.** None, deliberately, and that is the finding rather than a lapse. Two answers are
defensible and they are different products. Either **a fold survives a relayout** - the reader took a
branch off the drawing and changing the depth is not a request to bring it back, which means
`erHiddenSet` must stop depending on `erIds` - or **a relayout is a fresh drawing**, in which case
`erCut` should be cleared and the window should say so, rather than keeping a record of folds that
do nothing. Today's code is the second minus both halves of saying it. The arrangement format
assumes the first: it saves `folds` beside `positions`, which reads as folds belonging to the
arrangement rather than to one layout. Choosing is Ivan's.

What *was* fixed the same day is the other half this measurement uncovered: `erToggleCut` redrew the
boxes and never re-ran the counts, so folding thirteen boxes away left both counters saying
eighteen. That one had a single right answer. `tools/probe.py` now drives the diagram window and
holds it.

**The rule.** **A fast path is only fast if the slow path agrees with it, and the way to find out is
to run both.** Reading `erShow()` shows a deliberate, well-commented skip and nothing else; running
it and asking the same question twice shows the state the skip leaves behind. Every number above
came from the second, and none of it was visible in the first. Where a check cannot be written
because the right answer is a decision, write the measurement down and name the decision - an
unrecorded finding is one the next session pays for again.
