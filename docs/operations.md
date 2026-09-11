# Transferable configuration and runbook

| System | Non-secret configuration | Secrets / owner | Transfer verification |
|---|---|---|---|
| GitHub Actions | workflows in `.github/workflows/`, full-history checkout | `CF_KV_TOKEN`, `CWS_SERVICE_ACCOUNT`, repository owner | run `bash tests/run.sh` and the `battery` workflow |
| Cloudflare Worker | `site/wrangler.jsonc`, asset directory `site/` | Cloudflare account, `STATUS` binding | `wrangler deploy --dry-run` and request `/api/versions` |
| Cloudflare KV | `STATUS` namespace declared in wrangler | account KV access | read the `status` key without modifying it |
| Cloudflare RUM | site RUM setting, no extension code | Cloudflare owner | verify the beacon only on the site and disclose it in privacy |
| Chrome Web Store | manifest and archives produced by `build.sh` | publisher account and Store credentials | compare archive hash with the approved tag |
| Zoho canary | `tools/zoho-canary-contract.json`, per-product `ZOOST_CANARY_*` variables (never committed) | synthetic organisation/workspace, CSRF token and temporary session | run `node tools/zoho-canary.mjs --app=crm` and `--app=analytics` with `ZOOST_CANARY_CONTRACT=tools/zoho-canary-contract.json` |

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
read `/api/versions`, perform a synthetic report, then enable the read-only Zoho canary. No secret
value belongs in this repository.

Transfer does not include tokens or cookies. The new owner recreates secrets in their vault, runs
offline checks first, and only then enables a read-only canary. No command updates fixtures
automatically.

The CRM canary variables are explicit: `ZOOST_CANARY_CRM_BASE`, `ZOOST_CANARY_CRM_SESSION`,
`ZOOST_CANARY_CRM_CSRF`, `ZOOST_CANARY_CRM_ORG` and `ZOOST_CANARY_CRM_INSTANCE`. Analytics uses
`ZOOST_CANARY_ANALYTICS_BASE`, `ZOOST_CANARY_ANALYTICS_SESSION` and
`ZOOST_CANARY_ANALYTICS_WORKSPACE`.
