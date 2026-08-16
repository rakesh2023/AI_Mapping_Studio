# 14 — External Integrations

| Integration | Purpose | Authentication | Called from | Data sent | Data received |
|---|---|---|---|---|---|
| **Anthropic Claude** (via corporate gateway) | Mapping generation/regeneration, schema extraction, ETL/DDL generation, NL→column/entity, deploy SQL auto‑fix | `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`; base URL `ANTHROPIC_BASE_URL`; TLS trusts the corporate CA bundle | `ai_client.anthropic_client()` used by `mapping_service`, `extraction_service`, `etl_service`, `schema_service`, `ai_fix_service` | Prompts built from source/target schema, business context, file chunks, or a failing SQL batch + error (see [11](11-prompt-inventory.md)) — **no credentials, no secrets** | JSON (mappings/tables/columns) or raw T‑SQL; token usage counts |
| **Microsoft SQL Server** (source and/or target of the migration) | Test connection, read metadata, profile columns, execute ETL deploy batches | Per‑request credentials in the body: Windows/trusted auth **or** SQL login (`username`/`password`); never persisted | `db_service` (`/api/db/*`), `sql_execution_service` (deploy) via `pyodbc` | Connection parameters + read/DDL/insert SQL | Metadata, profile stats, `@@VERSION`, execution results |
| **Bootstrap 5.3.3 (CSS/JS)** | UI kit | none (public CDN) | `pages/*.html` `<link>`/`<script>` (`cdn.jsdelivr.net`) | — | Stylesheet/JS |
| **Bootstrap Icons 1.11.3** | Icon font | none (CDN) | `pages/*.html` | — | Icon CSS/font |
| **SheetJS (xlsx) 0.18.5** | In‑browser `.xlsx` parsing for target schema upload | none (CDN) | `pages/target-system.html` | — | Library JS (parsing happens client‑side) |

## Notes

- **Same‑origin API:** the frontend calls only `/api/*` on the same Flask origin — no third‑party API is called directly from the browser except the CDN asset loads above.
- **Model ID handling:** `ai_model()` strips a `[1m]` context‑window suffix before calling the gateway (see [10](10-ai-genai-architecture.md)).
- **CA bundle:** `ca_bundle()` resolves a corporate bundle (`server/win-ca-bundle.pem` first, then `SSL_CERT_FILE`/`REQUESTS_CA_BUNDLE`/`CURL_CA_BUNDLE`), wired into the httpx client so the TLS‑intercepting proxy is trusted. `win-ca-bundle.pem` is gitignored and must be rebuilt locally.

**Observed Limitation:** three CDN dependencies mean the UI degrades (styling/icons/xlsx parsing) without internet access. **Recommended Improvement:** vendor these assets locally for offline/air‑gapped use.
