# Security policy

## Reporting

Please report security issues privately to **ivan@zoost.it** rather than opening a public issue.

Include what you would put in any bug report — version, browser, steps — plus what an attacker
could achieve. Please allow a reasonable window for a fix before public disclosure. This is a
spare-time project: I will acknowledge as soon as I can, but I cannot promise a fixed timeline.

## Scope

Zoost runs entirely in the browser. It has no server, no account and no backend, so the
interesting surface is small and specific:

- The content scripts injected into Zoho CRM pages (`content-bridge.js`, `hook.js`).
- The side panel, options page and graph window, and anything they render from data read out of
  Zoho or off the disk.
- The local files written through the File System Access API.
- The requests made to the AI provider the user configured, when that optional feature is on.

Out of scope: vulnerabilities in Zoho CRM itself, in Chrome, or in the AI providers.

## What Zoost deliberately does not do

- It never writes to Zoho CRM. It reads metadata and Deluge source only.
- It never reads CRM records — no contacts, deals or customer data.
- It sends nothing to the developer. There is no telemetry, no analytics and no remote code.
- It runs only on Zoho CRM domains and is inert everywhere else.

The one path off the machine is the optional AI assistant, which goes directly from the browser
to Anthropic or OpenAI using the user's own API key. Those are the only two AI destinations the
manifest permits.
