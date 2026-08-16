# 24 — Technical Debt

Only issues supported by evidence in the code/docs are listed. Priority: **High** (correctness/security/production‑blocking), **Medium** (maintainability/risk), **Low** (cleanup).

| Issue | Location | Impact | Priority | Recommendation |
|---|---|---|---|---|
| Flask **dev server + `debug=True`** used as the run mode | `server/main.py` | Not production‑safe (debugger RCE, verbose errors); no scaling | **High** | Run under a WSGI server with `debug=False` behind a reverse proxy ([19](19-deployment.md)) |
| No **CI/CD, containerization, or WSGI config** | repo‑wide | Manual, non‑reproducible deploys; tests not gated | **High** | Add CI (`pytest`), a Dockerfile, and a WSGI entrypoint |
| **No frontend tests** | `js/*.js` | All UI logic (shell, state, CSRF wrapper, streaming, workspace) unverified by automation | **High** | Add smoke/unit tests for the shell + critical controllers ([21](21-testing.md)) |
| `AIMS_SECRET_KEY` **silent random fallback** | `server/app/__init__.py` | If unset in prod, sessions silently invalidate on restart | **Medium** | Fail fast in production when unset |
| Login **user enumeration** via distinct messages | `auth_routes.login`, `auth_service.authenticate_result` | Valid emails discoverable | **Medium** | Optionally collapse to one generic message |
| **No upload size / MIME limit** | `ai_routes` extract endpoints | Large/unexpected uploads accepted | **Medium** | Add `MAX_CONTENT_LENGTH` + extension allowlist |
| **CDN libs without SRI**; **lower‑bound (`>=`) dependency pins** | `pages/*.html`, `server/requirements.txt` | Supply‑chain drift / unexpected upgrades | **Medium** | Add SRI (or vendor assets); pin exact versions / add a lockfile |
| Defined‑but‑unused config constants | `core/config.py` (`EXTRACT_XLSX_ROW_CAP`, `DEPLOY_MAX_ATTEMPTS` vs hardcoded `maxAttempts=1`) | Confusing; deploy retry ladder not actually configurable | **Medium** | Wire them in or remove; align deploy attempts with `DEPLOY_MAX_ATTEMPTS` |
| **Orphaned sample data** | `data/target-metadata.json`, `mappings.json`, `validation-results.json`, `sample-documents.json` | Dead files imply behavior that no longer exists | **Low** | Delete (only `source-metadata.json` is still used) |
| **Two `server.log` copies** + no rotation; `print`‑based diagnostics | `server/server.log`, root `server.log`, various services | Log sprawl; no retention/levels | **Low** | Adopt stdlib `logging` with rotation ([18](18-logging-monitoring.md)) |
| **Stale docs** | `SESSION_SUMMARY.md` (dated 2026‑08‑12, lags git), `server/README.md` (says `debug=True` "auto‑reload" but reloader is off) | Minor confusion for new devs | **Low** | Update the two notes |
| **Settings defaults mismatch** | `common.js` `DEFAULT_SETTINGS.highConfidence=90` vs `settings.js` `SETTINGS_DEFAULTS.highConfidence=85` | Different implied default depending on which path seeds settings | **Low** | Reconcile to a single default |
| **Deploy job store in memory** | `deployment_service` | Jobs lost on restart; not multi‑process safe | **Low/Medium** | Move to a shared/persistent store if multi‑instance |
| Message strings reference old run command | `common.js` toasts ("python server/app.py") | Minor inaccuracy (entry is `server/main.py`) | **Low** | Update the strings |

**General note:** the codebase is clean, layered, and well‑tested on the backend security/tenant surface. The debt is concentrated in **production‑readiness (deploy/observability)** and **frontend test coverage**, not in core correctness.
