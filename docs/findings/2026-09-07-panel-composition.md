# Panel composition became a maintenance boundary

The Analytics panel held navigation, pull orchestration, AI, report generation and Health in one
4,720-line script. Its markup also held 477 lines of CSS; the CRM page held 676. That made an edit to
one surface require navigating unrelated code and kept presentation rules mixed with document
structure.

Analytics AI, export and Health now live in `ai.js`, `export.js` and `health.js`, loaded as readable
classic scripts before the 3,572-line orchestration file. Both panels load `sidepanel.css` instead of
embedding their styles. No module bundler, framework or runtime dependency was introduced.

The move exposed a blind spot rather than hiding it: `twincheck.py` and `csscheck.py` only inspected
inline style blocks. With linked CSS they could report a clean comparison over no panel rules.
They now include local linked stylesheets and standalone extension CSS, and focused tests hold that
subject. Panel tests compose the scripts in the order declared by the HTML, so moving a declaration
does not replace behaviour coverage with a hand-maintained file list.

The pure navigation and search-state modules now opt into `@ts-check` and define their input/state
contracts with JSDoc. Together with the existing workspace contracts, this puts static checking at
the state boundaries where it gives value while keeping the shipped source build-free.

React was deliberately not introduced. After this extraction the remaining UI code can already be
split and tested through explicit models and adapters; React would add a build/runtime migration but
would not simplify filesystem, Zoho bridge or pull orchestration. Reconsider it only for a new,
state-heavy view after measuring the native implementation against a contained pilot.

## The rules it left behind

- A page-level checker reads linked local assets as part of the page; moving code or CSS may not make
  the subject disappear from its audit.
- The HTML is the authority for classic-script composition and load order; tests derive that set.
- Separate a panel by responsibility without changing the browser contract or adding a build step.
- Add static contracts first to pure state and boundary modules, where a diagnostic has one owner.
- A framework enters only when a contained comparison demonstrates less state and maintenance cost.
