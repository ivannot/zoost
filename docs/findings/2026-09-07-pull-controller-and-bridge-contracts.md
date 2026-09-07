# Pull orchestration and bridge messages have explicit contracts

The CRM panel still owned the lock, current-area dispatch, seven-area Pull all walk, recheck
consumption and closing summary in one global block. Those parts change for one reason: a user starts
or finishes a read from Zoho. `pull-controller.js` now owns that complete use case and receives its
readers, runners, renderers and state publications explicitly. The panel remains the adapter for
Chrome, Zoho and the filesystem; the controller contains no one of those APIs.

The extraction reduced `apps/crm/sidepanel.js` from 7,110 to 7,016 lines. More important than the
number, the nesting counter is private now: `pullBusy` has one publication callback, and every exit
from a user-initiated read passes through the controller's `finally`. Pull all walks one immutable
plan, checks its operation before each area, spends only rechecks whose verdict moved, preserves the
last runner's summary and appends every declared gap before releasing the lock.

Chrome messages were the other untyped boundary. The panel had three separate acts embedded in
large functions: attach the workspace identity, decide whether a context reply is affirmative, and
rebuild an `Error` after Chrome flattened it into an object. Both products now load the same
app-local `bridge-contract.js`. Its checked contract preserves status, refusal, note and diagnostic
facts; context probes deliberately carry no expected identity because their purpose is to discover
a mismatch. Analytics now uses the same error reconstruction instead of preserving only status and
`forbidden`.

The static gate itself exposed a development blind spot during this change. `git grep` saw only
tracked files, so the first local run reported the old 13-module set and ignored the three new
unchecked files until they would have been committed. Discovery now uses portable `grep` over the
filesystem: the gate reads 9 CRM and 7 Analytics modules before staging, while remaining usable on
the GitHub runner that does not provide `rg`.

No React, bundler, generated JavaScript or runtime package was added. The public inventory now names
30 CRM and 23 Analytics JavaScript files, matching what each package actually contains.

## The rules it left behind

A long-running use case owns its lock and its release path in one module, mutable panel state crosses
that boundary through named readers and publications, and every Chrome message is formed and decoded
through a checked contract. A derived gate must see the files on disk before they are staged, not
only the files Git already knows.
