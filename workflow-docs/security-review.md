# Security review (Phase 7a, GUIDE #11 C)

**Scope:** be/ (Express API, Socket.IO, jobs) and fe/ (React SPA), as of commit `ce7c8db` and later.

**Severity:** Critical / High / Medium / Low / Info. **Status:** Fixed / Mitigated / Accepted (with the reason) / Open.

## Summary
| # | Finding | Severity | Status |
|---|---|---|---|
| S1 | react-router < 7.18: open redirect via backslash in `<Link>`/`useNavigate` (GHSA-wrjc-x8rr-h8h6) + constructor-injection advisory | Medium | **Fixed**: upgraded to react-router 7.18.5 (`3dbce6c`); `npm audit` fe = 0 |
| S2 | be dev-only advisories: minimatch ReDoS through eslint and nodemon (GHSA-g3hv-75wg-m249) | Medium (dev only) | **Accepted**: dev tooling, not shipped; it only processes our own globs. Revisit when eslint/nodemon release fixed ranges. |
| S3 | No per-account brute-force protection (IP limit only) | Medium | **Fixed**: 10 failures in 15 min → 15-min lock, generic message, `ACCOUNT_LOCKED` audit |
| S4 | Weak password rules (8 chars) | Medium | **Fixed**: ≥ 10, letter + digit, not the email or its local part, deny-list of common passwords; enforced server-side on create and change; fe shows the rules |
| S5 | JWTs could not be revoked before expiry (8 h) | Medium | **Fixed**: `users.token_version` in the token (`tv`), checked by REST auth, the socket handshake and the 5-min socket re-check; bumped on password change, deactivation and "Log out all sessions" |
| S6 | JWT in `localStorage`: readable by any script running on the page (XSS) | Medium | **Mitigated**: strict CSP without `unsafe-inline`/`unsafe-eval` (S7), React escaping, no `dangerouslySetInnerHTML` (grep: 0). An httpOnly SameSite cookie remains the Phase 7b option. |
| S7 | No CSP for the SPA | Medium | **Fixed**: `fe/csp.config.js` (one definition) → `vite preview` (CSP=1) and the nginx lines below. The e2e suite fails on any `securitypolicyviolation`. |
| S8 | Unsafe production config possible (placeholder secret, simulator, `*` CORS) | Medium | **Fixed**: with `NODE_ENV=production`, startup fails on a JWT_SECRET under 32 bytes or a placeholder, `GPS_PROVIDER=simulator`, CORS `*` or localhost, or an unset TRUST_PROXY (10 unit tests) |
| S9 | Logs could contain cookies, tokens or connection strings | Low | **Fixed**: pino redacts `authorization`/`cookie`/`x-api-key`/`set-cookie`/`password*`/`token`/`secret`/`api_key`/`connectionString`/`DATABASE_URL`; any `postgres://…` text is scrubbed from messages, error messages and stacks |
| S10 | Errors could not be correlated with logs | Info | **Fixed**: `X-Request-Id` (an incoming well-formed id is honoured, else a UUID), included in every error body and in pino `req.id` |
| S11 | Slow-loris / oversized bodies | Low | **Fixed**: `headersTimeout` 20 s, `requestTimeout` 120 s (receiving only; streamed exports unaffected), `keepAliveTimeout` 65 s; JSON body 1 MB → 413; import upload `IMPORT_MAX_FILE_MB` 10 MB (multer, 413) and `IMPORT_MAX_ROWS` 50,000 |
| S12 | API responses had helmet's default (HTML-oriented) CSP | Info | **Fixed**: the API sends `default-src 'none'; frame-ancestors 'none'` (it only returns JSON and files), CORP same-site, HSTS in production |
| S13 | SQL built with template strings | Info (audit) | **No issue found**: every interpolation comes from a whitelist (table below) |
| S14 | Archive download path traversal | Medium (design) | **Fixed in Phase 6** (`safeArchivePath`; tests for `../`, absolute and encoded paths) |
| S15 | CSV formula injection in exports | Medium (design) | **Fixed in Phase 6** (`'` prefix on text cells starting with `= + - @ \t \r`; tested) |

Counts: Critical 0 · High 0 · Medium 10 (9 fixed or mitigated, 1 accepted dev-only) · Low 2 fixed · Info 3.

## Details

### Dependencies (`npm audit`, 2026-11-05)
- **fe:** 2 moderate (react-router, react-router-dom), both fixed by the v7 upgrade. It was essentially an import rename (`react-router-dom` → `react-router`, `RouterProvider` from `react-router/dom`) plus removing the `v7_*` future flags, which are now default. All 110 fe tests passed unchanged. **Now 0.**
- **be:** 5 moderate, **all dev-only** (`eslint`, `@eslint/js`, `@eslint/config-array`, `minimatch`, `nodemon`). The suggested fixes are semver-major tooling changes. Runtime dependencies (express, pg, exceljs, pdfkit, socket.io, jsonwebtoken, bcrypt, helmet, multer, …) have **0** findings.

### Auth
- **Lockout** (`authService.registerFailure`): one atomic UPDATE. A failure outside the window starts a new count; the 10th failure inside it sets `locked_until = now() + 15 min`.
  - A locked account gets the same 401 "Invalid email or password", even with the correct password. bcrypt still runs, so the timing stays uniform.
  - A successful login resets the counters. Audit rows: `LOGIN_FAILED` (with a reason) and `ACCOUNT_LOCKED`.
  - The 5/min/IP limiter stays in place.
- **token_version:** the claim is `tv`. Old tokens without it count as `0`, so existing sessions survived the migration.

### HTTP headers / CSP
**SPA CSP** (from `node fe/csp.config.js`; the tile origin follows `VITE_MAP_TILE_URL`):
```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self' blob:
```
- **Styles:** React, Leaflet and Recharts set styles through the CSSOM (`element.style`), which CSP does not restrict, so `style-src 'self'` is enough. The e2e suite exercises the Leaflet maps (canvas + tiles), Recharts dashboards, the socket, downloads and the PDF/XLSX exports under this policy, with **0 violations**.
- **Socket:** `connect-src 'self'` covers same-origin `ws:`/`wss:` (CSP Level 3) for Socket.IO behind nginx.

**nginx** (the SPA server block, Phase 7b deployment):
```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://tile.openstreetmap.org; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self' blob:" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Permissions-Policy "geolocation=(), camera=(), microphone=()" always;
# index.html must not be cached (new deploys), hashed assets can be cached forever:
location = /index.html { add_header Cache-Control "no-store" always; }
location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable" always; }
```
nginx does not inherit `add_header` into blocks that define their own `add_header`, so the location blocks must repeat the security headers or use an `include` snippet. This will be written out in Phase 7b.

### Injection audit: every SQL interpolation
| Where | Interpolated | Source | Safe because |
|---|---|---|---|
| `repositories/baseRepository.js` | `table`, `cols`, `orderBy`, `select` | `createCrudRepository(def)` in code; `cols = def.writable ∩ keys(data)` | table/select/orderBy are code constants; columns are filtered through the `writable` whitelist (request keys never reach SQL) |
| `repositories/lookupRepository.js` | `def.sql`, `def.orderBy` | `LOOKUPS[type]` | `type` is a zod `z.enum(LOOKUP_TYPES)` |
| `services/reports/definitions.js` `orderedSql` | sort expression, `ASC/DESC`, tiebreak | `def.sortable[q.sort]` | unknown `sort` → 400 before SQL; `dir` reduced to ASC/DESC; the tiebreak is a constant |
| `services/reports/*`, `dashboardService.js`, `pidVisitReadService.js` | WHERE fragments, `${p}` placeholders | `SqlWhere` | values always go through `param()` → `$n`; fragments are code constants |
| `pidVisitReadService.js` `GROUPS[group_by]` | group key/label/join | `z.enum([...])` | enum |
| `gpsReadService.js` `view` | column list | `z.enum(['full','map'])` | enum → one of two constants |
| `gpsTrackerService.js` | column names and casts | `COLS` constant | code constant |
| `pidImportService.js` | `INSERT_COLS`, `ON_CONFLICT[onExisting]`, `$n` tuples | constants; `on_existing` enum | values are `$n` parameters |
| `routeAssignmentService.js` | `COVERED_STATUS`, `routeOn` | constants | code constants |
| `routeComparisonService.js` | `STATIONARY_KMH`, `OUTLIER_SPEED_KMH` | numeric constants | code constants |
| `reports/reportService.js` | `statement_timeout = ${STATEMENT_TIMEOUT_MS}` | numeric constant | code constant |
| `0009` SQL functions | partition names | `format('%I', 'gps_locations_p' || to_char(date))` | built from a date inside SQL, quoted with `%I` |
| `scripts/*` (perf, purge) | schema names | `DB_SCHEMA` | refused unless `^(perf\|test)_[a-z0-9_]+$` (or `e2e_[a-f0-9]+`) |
| `realtime/socketServer.js` | none | – | parameterised |

### Production env validation
`parseEnv()` in `src/config/env.js`; see `tests/unit/securityConfig.test.js` (13 tests). The secrets themselves are never logged: only rule names appear in the error.

### Open / Phase 7b
- httpOnly cookie session instead of a localStorage token (S6), if the deployment allows same-site API hosting.
- nginx config with the headers above, TLS, `TRUST_PROXY=true`, and an `X-Request-Id` pass-through (`proxy_set_header X-Request-Id $request_id;`).
- Rotate the existing development DB password before go-live (it has been in a local file the whole project).
