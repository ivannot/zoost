# Trust boundaries, and what is assumed on each side of them

Open this before touching anything that crosses a boundary: the hook in Zoho's page, the content
bridge, what the panel is allowed to do with a message, what the assistant may reach, and what is
written to disk. Everything here is a property of the code as it is, not a plan.

It exists because an outside audit asked "which boundary is trusted for what" and the answer was
spread across a dozen comments, each correct and none of them the map. A boundary that only exists
in the code is one nobody can review.

---

## The picture

```
                    ┌──────────────────────────────────┐
                    │        Zoho CRM / Analytics      │
                    │         page and its APIs        │
                    └────────┬──────────────┬──────────┘
      observes its own saves │              │ authenticated reads, the user's own session
                             ▼              ▼
                    ┌────────────────┐  ┌────────────────────┐
                    │    hook.js     │  │  content-bridge.js │
                    │   MAIN world   │  │   ISOLATED world   │
                    │  48 lines, no  │  │  every endpoint,   │
                    │  authority     │  │  CSRF, pagination  │
                    └───────┬────────┘  └─────────┬──────────┘
             window.postMessage│                  │ chrome.runtime messaging
                               └────────┬─────────┘
                                        ▼
                              ┌────────────────────┐
                              │     side panel     │
                              │  the only writer   │
                              └───┬────────────┬───┘
                                  │            │
                                  ▼            ▼
                         local mirror      AI provider
                    File System Access     Anthropic / OpenAI
                    (a folder the user      (only with a key the
                     granted, per app)       user supplied)
```

## What each side is trusted for

| Boundary | Trusted for | Not trusted for |
|---|---|---|
| **Zoho's page (MAIN world)** | nothing. Any script on that page can run in it | anything at all: what arrives is a hint |
| **`hook.js`** | noticing that the editor issued a `PUT` on a function and saying so | it holds no data, reads no response body, and cannot act |
| **`content-bridge.js` (ISOLATED)** | reaching Zoho's APIs with the user's own session, and deciding whether an answer is the shape it reads | deciding what to keep: it returns, it never writes |
| **the side panel** | every decision - what to pull, what to write, what to show, what to send to a model | nothing arrives here with authority attached; a bridge reply is data |
| **the mirror on disk** | being what the user granted, per app, and the only place anything is written | it is *read back* as untrusted content: it is text a workspace author wrote |
| **the AI provider** | answering | its answer is text. It names tools; it cannot invent one, and it reaches nothing outside the list |

## The one channel that crosses from the page

`hook.js` sees the editor save a function and posts `{ source, type, id }` to `location.origin`. The
bridge accepts it only if the sender is this window, the two strings are exact, and the id is digits;
it then asks the panel to **re-read that function from Zoho**. So the worst a forged message can do is
ask for a re-read of something that exists. Nothing downstream takes the payload as content, and no
write, no AI call and no filesystem operation is authorised by it.

This is the shape to keep for anything added here: **a message from the page world may only ever
cause the extension to go and look for itself.**

## What the assistant can reach

The tools are a fixed list in the panel, dispatched by name, with an `Unknown tool` at the end. There
is deliberately no tool that takes a path, a URL, or code: everything answers from what is already in
memory - the mirror as it was loaded. So a model that asks for something outside the list gets a
sentence back, and a model that has read a hostile Deluge comment can still only ask for functions,
modules, workflows, actions, connections and failures of *this* workspace.

The constraint is in the code rather than in the prompt, which is the point: a system prompt is a
request, and this has to be a refusal.

## What "read-only" means exactly, and where it is enforced

The product's first non-negotiable is that nothing here writes to Zoho. It is enforced in
`tests/tools_test.py`, not by reading: every `fetch` in the shipped code is read whole, constants are
resolved so a URL moved into a variable cannot hide, and anything that is not a GET must be either one
of the two declared AI hosts or an endpoint named in an allowlist with its reason. Today that
allowlist holds exactly one entry - `ZDBCreateERD`, which computes the ER model of a workspace and
creates nothing - and handing a second endpoint to the same helper fails the suite.

The same test asserts that nothing injected into the page drives it: an injected file must be one of
our two, and an injected function must not click, dispatch an event or set a value. That is the "never
click-and-hope" rule, as an assertion.

## Secrets

An API key the user supplies is either in `chrome.storage.local` in plaintext - which the settings
page states, in those words - or encrypted with a passphrase the user holds and nothing else. The
envelope records the derivation cost beside the ciphertext, so raising it later cannot make yesterday's
key unreadable. The unlocked key lives in `chrome.storage.session`, which is memory, and leaves it when
the user forgets that provider.

What this does **not** defend against, stated because the alternative is implying otherwise: anyone
who controls the browser profile can read a plaintext key, and encryption without a passphrase would
be decoration - the key to decrypt would sit next to the ciphertext. That is why the option exists and
why it is the user's choice.

## Adversaries this is built against

- **a script on the Zoho page** - it can forge the save notice, and that is all it can reach;
- **hostile content in the mirror** - a Deluge comment or a workspace name written to look like an
  instruction. It reaches the model as data, and the model's tools cannot be widened by it;
- **an answer from the AI provider** - text, dispatched by name against a fixed list;
- **a contributor, or a session here, adding a write path by accident** - which is what the CI gate is
  for, because this is the adversary that has actually turned up.

Not defended against, deliberately: a compromised browser or operating system, and a user who grants
the folder to something else.

## Dependency direction

Not enforced by tooling - there is none, and adding a bundler to get it would cost more than it buys -
but this is the direction, and a change that reverses one of these arrows is worth arguing about:

```
hook.js        → nothing (it posts one message and holds no state)
content-bridge → Zoho HTTP and the page. Never the filesystem, never the model
side panel     → the bridge, the mirror, the model, the exports
graphlogic.js  → nothing: no DOM, no chrome.*, no network. That is the criterion it was extracted by
```

The one already mechanised is the last: `tests/tools_test.py` holds `graphlogic.js` free of every DOM
handle and byte-identical between the two products, so the rule is a check rather than a habit.
