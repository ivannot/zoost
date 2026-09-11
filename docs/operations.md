# Transferable configuration and runbook

| System | Non-secret configuration | Secrets / owner | Transfer verification |
|---|---|---|---|
| GitHub Actions | workflows in `.github/workflows/`, full-history checkout | `GH_TOKEN`, `TURNSTILE_SECRET`, repository owner | run `bash tests/run.sh` and the `battery` workflow |
| Cloudflare Worker | `site/wrangler.jsonc`, asset directory `site/` | Cloudflare account, `STATUS` binding | `wrangler deploy --dry-run` and request `/api/versions` |
| Cloudflare KV | `STATUS` namespace declared in wrangler | account KV access | read the `status` key without modifying it |
| Cloudflare RUM | site RUM setting, no extension code | Cloudflare owner | verify the beacon only on the site and disclose it in privacy |
| Chrome Web Store | manifest and archives produced by `build.sh` | publisher account and Store credentials | compare archive hash with the approved tag |
| Zoho canary | `ZOOST_CANARY_*` variables (never committed) | synthetic organisation and temporary session | run `node tools/zoho-canary.mjs --live` manually |

Transfer does not include tokens or cookies. The new owner recreates secrets in their vault, runs
offline checks first, and only then enables a read-only canary. No command updates fixtures
automatically.
