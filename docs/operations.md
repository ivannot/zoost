# Transferable configuration and runbook

The machine-readable inventory is `tools/operations-manifest.json`. `tools/configcheck.py`
derives the Worker `env.*`, Wrangler bindings and GitHub `secrets.*` references and compares them
with that inventory; this table supplies the transfer procedure and the dashboard-only checks.

| System | Non-secret configuration | Secrets / owner | Transfer verification |
|---|---|---|---|
| GitHub Actions | workflows in `.github/workflows/`, full-history checkout | `CF_KV_TOKEN`, `CWS_SERVICE_ACCOUNT`, repository owner | run `bash tests/run.sh` and the `battery` workflow |
| Cloudflare Worker | `site/wrangler.jsonc`, asset directory `site/` | Cloudflare account, `STATUS` binding | `wrangler deploy --dry-run` and request `/api/versions` |
| Cloudflare KV | `STATUS` namespace declared in wrangler | account KV access | read the `status` key without modifying it |
| Cloudflare RUM | site RUM setting, no extension code | Cloudflare owner | verify the beacon only on the site and disclose it in privacy |
| Chrome Web Store | manifest and archives produced by `build.sh` | publisher account and Store credentials | compare archive hash with the approved tag |
| Zoho canary | `tools/zoho-canary-contract.json`, raw-endpoint fixtures and local probes | no live Zoho organisation or credentials in the project | the tracked marker is `not-applicable`; private live records remain optional operator tooling, never release evidence |

Secrets and bindings are intentionally separated by consumer:

| Consumer | Secret or binding | Minimum privilege and verification |
|---|---|---|
| GitHub Actions | `CF_KV_TOKEN`, `CWS_SERVICE_ACCOUNT` | deploy/status and Store upload only; rotate in repository secrets and run the battery workflow |
| Cloudflare Worker | Worker `GH_TOKEN`, `TURNSTILE_SECRET`, optional `REPORT_SALT` | issue creation and Turnstile verification only; rotate in Worker secrets and exercise `/api/report` with a test challenge |
| Cloudflare Worker | `STATUS`, `ASSETS`, `CF_VERSION` | non-secret KV/assets/version bindings from `wrangler.jsonc`; deploy dry-run and read `/api/versions` |
| Report page | Turnstile site key | public key paired with the Worker secret; verify the widget appears only when configured |
| Cloudflare dashboard | Web Analytics/RUM | dashboard-only setting; verify beacon on site pages and document EU policy |

Transfer checklist: create a new owner account, export the non-secret bindings, recreate each secret
in the correct consumer, revoke the former owner's tokens, run the offline battery, deploy a dry run,
read `/api/versions` and perform a synthetic report. Live Zoho access is intentionally outside the
project boundary; no real organisation, cookie, token or secret value belongs in this repository.

Transfer does not include tokens or cookies. The new owner recreates secrets in their vault and runs
offline checks first. A separately governed operator may enable the optional read-only canary, but it
is not part of this project's release evidence. No command updates fixtures automatically.

## Optional live-canary tooling

The tracked `tools/zoho-canary-status.json` is deliberately `not-applicable`: this project and its
tests never receive a real organisation or credentials. The authoritative compatibility evidence is
the committed raw-endpoint fixtures, parser tests and local browser probes. The following commands
remain available as optional tooling for an operator who has a separate controlled environment;
their records are never required by the repository battery:

```text
node tools/zoho-canary.mjs --app=crm --record=/private/zoost-canary/crm.json
node tools/zoho-canary.mjs --app=analytics --record=/private/zoost-canary/analytics.json
node tools/zoho-canary.mjs --check-record=/private/zoost-canary/crm.json
node tools/zoho-canary.mjs --check-record=/private/zoost-canary/analytics.json
```

The record contains only schema version, timestamp, product, route names, HTTP statuses and the
SHA-256 of the reviewed contract. Cookies, tokens, organisation ids, workspace ids and response
values never enter it. If used outside the project, `--check-record` fails distinctly for missing,
never-run, malformed, stale, contract-mismatched, incomplete or unsuccessful evidence. Run the two
profiles independently and retain any sanitized records outside this repository.

The CRM canary variables are explicit: `ZOOST_CANARY_CRM_BASE`, `ZOOST_CANARY_CRM_SESSION`,
`ZOOST_CANARY_CRM_CSRF`, `ZOOST_CANARY_CRM_ORG` and `ZOOST_CANARY_CRM_INSTANCE`. Analytics uses
`ZOOST_CANARY_ANALYTICS_BASE`, `ZOOST_CANARY_ANALYTICS_SESSION` and
`ZOOST_CANARY_ANALYTICS_WORKSPACE`.
