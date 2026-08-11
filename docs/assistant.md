<!-- Split out of docs/decisions.md, which had grown to 102k in one flat run of 147
     decisions with no heading to navigate by. Nothing was cut: this is the same text,
     in the file CLAUDE.md's index now names. -->

# The assistant, and the key it is given

**The assistant is told what the extension itself does, and that is the point of the product.**
`product-help.js` in each app is a plain-language description of what exists, where it is, and what it
will not do — same shape as `analytics-sql.js`: one text, more than one consumer, so it cannot drift
between them. The reason is not convenience. Zoost is used by people who know their org and are not
developers, and the assistant exists so their questions stop travelling to whoever administers the
system. That fails if the questions merely change shape: replacing "what does this workflow do?" with
"how do I use Zoost?" solves nothing, because the same person is still being asked. So "how do I
export this?" is answered in the panel, where the user already is.

It costs about a thousand tokens on **every** message, so the context line under the chat title
counts it: it reads *sent with every message*, not *index*, because a figure that reported only the
org index would understate what is billed. What belongs in that file is what exists and what it
refuses to do; how anything works inside does not — nobody asking "what happens if I click Export?"
wants to hear about the file system API. **A capability added to a panel belongs there too**, or the
assistant will confidently describe a product that is one version out of date.

**The AI index is layered, and what does not fit is named — in both apps.** A workspace of a thousand views does
not fit in a system prompt sent with every message, so the question is never "how big a cap" but
"what gets dropped". Dropping the tail is the wrong answer: it cuts an arbitrary half and the model
cannot tell it is missing, which is how it ends up asserting a view does not exist. `aiBuildSeed(cap)`
assembles in priority order — **the vocabulary is never dropped**: data objects in Analytics,
the function list in CRM, because they are the vocabulary
needed to write a query or follow a foreign key; reports and dashboards go first because
`list_views` can find them by name — and whatever is left out is stated in the prompt itself with
what to call instead. Measured: 1144 views and 444 data objects come to ~62k characters (~15k
tokens) and fit whole; at 2429 views the tables still fit in full and the reports are declared
absent.

The cap is a **setting**, because the trade it makes is the user's to price: a bigger index means
the assistant knows more names, and it is billed on every message. A number in a form is not a
choice, though — so the panel measures the index for the workspace actually open and prints it under
the chat title, in characters and approximate tokens. The knob and the consequence are in the same
sentence.

**`aiCap()` existed in Analytics only, for months, while this file described it as the rule.** The
CRM panel had no such helper and `search_code` truncated at 60 hits in silence — the exact defect the
convention was written against, on the side nobody checked. Ported byte-identical.

**Tool answers are capped too, and say how to narrow.** A tool that returns nine hundred lines has
not answered. `aiCap()` cuts the list, states the true total, and tells the model which argument
would narrow it.

**The assistant is told what you are looking at, whatever kind of thing it is.** `aiFocus()` builds
the `CURRENT FOCUS` block from `currentPath`, which every tab already sets. It handled `.dg` files
only for a long time, so selecting a workflow and asking "what does this do?" got "give me details"
while the same question about a function worked — the "one of a set" miss, invisible until somebody
asks the obvious question. The non-function kinds are **serialised from the captured data** rather
than described field by field: a second description of each shape is free to drift from the pull
that produces it, and a field named here that does not exist is how an assistant ends up discussing
something that was never there. Workflows read their **file**, not the index entry, because
conditions and actions are what the question is about — and when only the index is on disk the
prompt says so instead of looking complete.

**AI configuration lives in the options page**, not the side panel. The panel is ~400px wide and
those are set-once fields. The panel picks changes up via `chrome.storage.onChanged` plus a
`window.focus` re-read. A selector that changes a *mode* saves on change, not behind a Save button.

**The API key is stored in clear text by default, and the passphrase that changes that is opt-in.**
Chrome gives extensions no encryption at rest and no credential store, so anything the extension can
unlock by itself, anyone with the browser profile can unlock too — encrypting with a key kept beside
the ciphertext would be **theatre, and worse than storing plainly**, because it lets us claim a
protection we do not provide. The only real protection is a secret we do not hold. So `keyvault.js`
(byte-identical in both apps) offers PBKDF2-SHA256 → AES-GCM-256 over a passphrase the user chooses,
the ciphertext is what sits in `chrome.storage.local`, and the unlocked key lives in
`chrome.storage.session` for the browser session. **There is no recovery** — no hint, no escrow, no
reset — because a secret whose replacement costs one visit to a provider's dashboard does not deserve
a back door, and a back door is what a recovery path is.

**The switch works in both directions, and getting that wrong was nearly the worst bug in the
feature.** Turning the protection *off* needs the passphrase too — clear text means decrypting what is
stored, and we do not hold the secret — so the first version simply deleted the ciphertext and wrote a
config with no key at all: silent, total, irreversible. Two rules came out of it, both binding.
`mergeKeys()` **never destroys**: a failed or absent unlock keeps the ciphertext exactly as it was.
And the handler **refuses to save** a config that says "no protection" while a ciphertext survives,
because that state is a key nobody can read described as one anybody can. The question that found it
was the obvious one — *can I go back?* — asked by the user, not by a test, which is the failure.

**You cannot re-encrypt what you have not decrypted, and three different-looking actions are that one
fact.** Changing the passphrase, replacing the API key while protected, and turning the protection off
all end in a write that must start from the plaintext — which only the user can produce. Missing it
made **Change passphrase ask for the new one twice, save, report success and change nothing**: the
merge read `had.apiKeyEnc && !typed` as "leave it alone" and never looked at the new passphrase at all.
The form therefore asks for the passphrase **in use** whenever any of the three is happening
(`aiNeedCurrent()`), and the handler **proves it against the stored ciphertext before writing** rather
than taking it on trust — encrypting a new key with a mistyped passphrase locks the user out of a key
they believe they can open, and nothing would tell them until the next browser restart.

**A blank key field means "keep", except in the one place that says "erase".** Those two are the same
screen state and must do opposite things: blank-means-keep is what stops an unrelated save from wiping a
key the user cannot retype because it is encrypted, and a **Forget** button per provider is the declared
exception — it clears model and key on the next Save, and it is the only way out for a key whose
passphrase is gone. Without it "I have forgotten the passphrase" would have no answer inside the page,
because the merge rightly refuses to drop a ciphertext it cannot read.

**A rule enforced on the user and not on the default is worse than no rule.** The engine selector
refused a move *to* an unconfigured provider and said nothing about *sitting on* one — and a fresh
install sits on Anthropic with nothing filled in, so it showed a chosen, working engine that could not
answer a single question. Two consequences: every option states whether it is ready
(`markEngineOptions()`), and a save that leaves **exactly one** usable engine selects it and says so,
because choosing the only engine that works is not a decision worth asking about.

**A recovery path that has to be worked out is not a recovery path.** Losing the passphrase already had
an answer — Forget on each provider, untick, save — and it was reachable only by deduction, which is no
use to somebody who has just lost a passphrase. **Remove the protection** does it in one control, acts
immediately rather than through Save (Save asks for the passphrase in use, which is the one thing that
does not exist here), is offered in **every** state where a passphrase exists rather than only the quiet
one, and states what goes and what stays before acting. Every message that mentioned the old sequence
now names this button; a test asserts none of them says "Forget above" again.

**The engine selector refuses a provider with no model or no key**, names what is missing, and puts
itself back. Not a preference: choosing an engine that cannot answer is a dead end the *panel* discovers
later, in another window, at the moment of a question. It judges the **form**, never what is stored —
refusing a key the user can see they have just typed would be the tool arguing with its own screen — and
it is not a dead end either way, because both providers' fields are on the same page.

It is **off by default and stated rather than defaulted**, on the user's own reasoning: on a personal
machine a passphrase each session buys little, on a shared one it buys a lot, and nobody but the user
can price that. Three consequences that are not optional. The limit is named next to the promise — a
key already unlocked is in the browser's memory, so what a passphrase protects is the key *at rest*.
`aiGetCfg()` is the **single** place that puts the plaintext back into the config, so nothing
downstream learns about passphrases at all — which is why `aiSaveCfg()` had to go: it was already
dead, and the moment `aiGetCfg()` started returning a decrypted key, a config written back would have
put the plaintext on disk. And `mergeKeys()` in `options.js` exists as a named function purely so it
can be tested: **a blank key field with a key already stored means "leave it alone", never "erase
it"**, because a protected key cannot be redisplayed and reading that blank as a deletion would throw
the user's key away on any unrelated save.
