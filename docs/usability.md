# User validation

Open this before changing first-run guidance or the sample path. It separates what the product can
measure from what only watching a person can establish.

## Primary outcome

The first outcome is **install one extension and open its sample workspace**. A real workspace is the
next outcome, not a prerequisite: the sample needs no Zoho account, reads no organisation and writes
only invented files into the chosen local folder.

The measurable path is:

1. visit the homepage;
2. choose CRM or Analytics;
3. follow the attributed Chrome Web Store link;
4. install the extension;
5. open the sample;
6. create and pull a real workspace.

zoost.it records aggregate visits to its four page families without an identifier. Store links use
the Chrome Web Store's standard campaign parameters. Installation is measured by the Store. The site
cannot observe steps 5 and 6, and the extensions send no telemetry; do not present either as measured.

## Five-session protocol

Recruit five people who use or administer Zoho and have not used Zoost. Run each session separately,
preferably with at least two CRM users and two Analytics users. The facilitator says only:

> Starting from zoost.it, decide whether this is relevant to your work. If it is, install the product,
> open the invented sample, find one function or view, inspect what depends on it, and export what you
> found. Say aloud what you expect before each click.

Do not teach the interface and do not rescue a participant until they have stopped for 30 seconds or
explicitly ask. If help is given, record the exact prompt. Screen recording is off by default; turn it
on only with explicit consent and agree when it will be deleted.

For each session record:

| Field | Value |
|---|---|
| Participant role and Zoho product | |
| Homepage understood without help | yes / no |
| Chose the intended product | yes / no |
| Reached the Store | time / blocked |
| Installed and found the side panel | time / blocked |
| Opened the sample | time / blocked |
| Found one item | time / blocked |
| Opened dependencies or diagram | time / blocked |
| Produced an export | time / blocked |
| Help given | exact words / none |
| First unexpected result | exact observation |
| Would use it on a real workspace | yes / no / why |

Record actions and words, not interpretations. “Clicked Settings twice looking for the sample” is an
observation; “the navigation is confusing” is a conclusion to make only after the sessions.

## How findings enter the backlog

- A security or data-loss failure is fixed immediately.
- A task blocked for at least two participants is P0.
- A task needing help for at least two participants is P1.
- A hesitation seen once is retained as an observation, not turned into a feature request.
- Requests made after participants succeeded are separated from first-run failures.

Repeat the same protocol after a change. Do not compare participants by speed and do not claim a
conversion improvement from five people: the sessions locate friction, and nothing here measures a
population. The site counts nothing - its funnel was removed on 7 September 2026, unread, because no
decision depended on it - so the only population figure that exists is what the Chrome Web Store
reports about installs.
