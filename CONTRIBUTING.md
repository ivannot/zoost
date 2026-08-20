# Contributing to Zoost

Thanks for looking. A few things worth knowing before you spend your time on this.

## What this project is

Zoost is a free tool built and maintained by one person in his spare time. It is licensed under
Apache-2.0, which means you may use, modify and redistribute it. It does **not** mean there is a
team behind it, a roadmap, or a service-level agreement.

- Issues and pull requests are welcome, and read.
- There is **no guaranteed response time**, and none is promised.
- Not every issue will be fixed and not every pull request will be merged. A "no" is not a
  judgement of your work - it usually means the change pulls the tool somewhere I do not want it
  to go, or adds something I cannot commit to maintaining.

If that is not a good deal for you, forking is a perfectly reasonable answer. The licence exists
precisely so you do not need permission.

## Reporting a bug

The single most useful thing you can include is **how to reproduce it**. Specifically:

- Zoost version (shown in **About**) and Chrome version.
- Operating system, and whether the working folder is on a local disk or a synced one
  (OneDrive, Dropbox, iCloud Drive - these are known to cause trouble).
- Which Zoho data centre (`crm.zoho.eu`, `.com`, `.in`, …), and whether production or sandbox.
- What you did, what you expected, what happened.
- Anything in the browser console: right-click the side panel → Inspect → Console.

**Never paste Deluge source, org ids, instance names, API keys or CRM data into an issue.**
The panel will build you something that is safe to paste: when something fails, **Report this
problem** produces a report from a fixed list of fields, with ids, addresses, quoted names and URLs
already taken out, shows it to you in full, and lets you delete any part of it before it goes. That
is the preferred way to report a break. It becomes a public issue, so it is still not the channel
for a security problem - those go to ivan@zoost.it, as below. Without an account, or without a panel
in front of you, https://zoost.it/report takes a description written by hand and opens the issue for
you; it carries no trace, and it is labelled so nobody reads it as one.
Redact them. If a bug can only be explained with real code, describe the shape of it instead.

## Suggesting a feature

Describe the **problem**, not only the solution you have in mind. "I cannot tell which functions
touch a module before I rename a field" is far more useful than "add a column to the table" -
it leaves room for a better answer than either of us has thought of.

Two kinds of request are unlikely to land:

- **Writing back to Zoho.** Not an editor, on purpose: Zoost calls no endpoint that creates, edits
  or deletes anything. Zoho compiles and validates server-side, and a write path means owning
  deployment, conflicts and rollback - a different product.
- **More AI providers.** Only Anthropic and OpenAI are supported, because those are the two that
  are actually tested and the only two the manifest grants network access to. An untested claim
  is worse than a missing feature.

## Pull requests

- Open an issue first for anything beyond a small fix, so you do not build something that will
  be declined for a reason you could not have known.
- Keep the change focused. One concern per pull request.
- Match the surrounding style: plain JavaScript, no build step, no dependencies, no frameworks.
  This is deliberate - the extension ships as readable source and stays auditable by anyone who
  is about to give it access to their CRM.
- No new permissions in `manifest.json` without discussing it first. Every permission has to be
  justified to the Chrome Web Store and to users, and the bar is high.
- Test against both a production and a sandbox org if your change touches the environment guard.

By submitting a contribution you agree it is licensed under Apache-2.0, per section 5 of the
licence. There is no separate agreement to sign.

## Building

```bash
./build.sh              # store package, manifest at archive root
./build.sh --unpacked   # for chrome://extensions → Load unpacked
```

No dependencies, no toolchain. If you have `zip` and a shell, you can build it.

## Security

Please do not open a public issue for a security problem. Write to ivan@zoost.it instead, and
give me a reasonable window to fix it before disclosing.
