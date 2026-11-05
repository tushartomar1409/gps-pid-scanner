# SESSION GUIDE — GPS PID Scanner (Guide ⇄ Worker Pipeline)

> **Worker session: read this whole file first.** It is the single communication channel between you (WORKER) and the GUIDE session.
> Spec source of truth: `workflow-docs/flow.txt`. This file overrides `flow.txt` only where explicitly stated under **Project Decisions**.

---

## 1. PIPELINE PROTOCOL (how we talk)

1. The GUIDE writes instructions under **§5 Conversation Log** as `### GUIDE → WORKER #<n>` blocks.
2. When you (WORKER) finish a task, or are blocked, or need direction, **append** at the very bottom of this file:

   ```
   ### WORKER → GUIDE #<n>
   STATUS: PENDING
   Task: <which guide instruction # you are answering>
   Done: <files created/modified, commands run, test results>
   Questions / Blockers: <anything you need decided>
   Ask: <e.g. "guide me what to do next">
   ```

3. The GUIDE watches this file. When it sees `STATUS: PENDING`, it will change it to `STATUS: ANSWERED` and append a `### GUIDE → WORKER #<n+1>` block with your next instructions.
4. After writing your request, **re-read this file periodically** (e.g. every 30–60 s) until you see `STATUS: ANSWERED` on your block and a new GUIDE block below it. Then execute it.
5. Rules:
   - Only **append** — never edit or delete earlier blocks (except nothing; GUIDE flips the status line).
   - One PENDING request at a time.
   - Never paste secrets/passwords into this file.
   - Keep reports factual: if a test fails, paste the error.

---

## 2. PROJECT SNAPSHOT (as of 2026-11-05)

- Repo: `gps-pid-scanner/` — git initialised on `main`, **no commits yet**.
- `be/` — empty except `be/dbconnection.txt` (a database connection string).
- `fe/` — empty.
- Tooling available: Node v24.15.0, npm 11.12.1. No local MySQL client installed.

---

## 3. PROJECT DECISIONS (overrides to flow.txt)

| # | Decision | Reason |
|---|----------|--------|
| D1 | **Database = PostgreSQL (Neon, serverless)** instead of MySQL. Use `pg` (node-postgres) with parameterized queries. Keep SQL in migration files. | The only DB provided (`be/dbconnection.txt`) is a Neon PostgreSQL URL. Everything in flow.txt §15 maps 1:1 to Postgres. |
| D2 | Spatial: start with `latitude/longitude NUMERIC(10,7)` + btree index + bounding-box prefilter + Haversine in JS (per flow.txt §8). Check if `CREATE EXTENSION postgis;` works on Neon — if yes, add a `geography(Point)` column + GIST index as an optimisation later (Phase 4). | Keep Phase 1 simple; PostGIS is optional. |
| D3 | Backend lives in `be/` (use flow.txt §16 structure inside `be/src/`). Frontend lives in `fe/` (React + Vite). | Existing folder names. |
| D4 | The connection string must be moved to `be/.env` as `DATABASE_URL`, `be/.env` and `be/dbconnection.txt` added to `.gitignore`, and a `be/.env.example` created with placeholders. **Never commit the real credential.** | Security (flow.txt §20). |
| D5 | Module system: ES Modules (`"type": "module"`). Migrations: `node-pg-migrate` (or plain numbered `.sql` files run by a small script — your choice, state it). Tests: `vitest` or `jest` + `supertest`. | Consistency. |
| D6 | Operational timezone `Asia/Kolkata`; store timestamps as `TIMESTAMPTZ`; derive `operational_date` from GPS `recorded_at` in that TZ. | flow.txt §22. |
| D7 | GPS provider format is **unknown**. Build `gpsTrackerService` behind an adapter interface + a **simulator adapter for dev/test only** (guarded by `GPS_PROVIDER=simulator`). Do not invent a real provider's API. | flow.txt §27 rule 10. |

---

## 4. PHASE PLAN (we go one phase at a time — do not skip ahead)

- **Phase 0** — Repo analysis, architecture proposal, ER diagram, schema draft, milestone list, GPS provider questions. *(no app code yet)*
- **Phase 1** — Foundation: be/fe scaffolding, DB config, migrations, auth (JWT + bcrypt), RBAC, master data CRUD (zones, wards, agencies, vehicles).
- **Phase 2** — PIDs (CRUD + CSV/Excel import + validation + map coordinate fix), routes, date-wise route assignments with PID snapshots.
- **Phase 3** — GPS integration (adapter, normalization, polling job, gps_locations, vehicle_latest_locations).
- **Phase 4** — PID visit detection engine (Haversine, bbox prefilter, consecutive points, idempotency, pid_daily_status).
- **Phase 5** — Monitoring UI: live tracking, PID coverage map, route comparison, dashboard, Socket.IO.
- **Phase 6** — Reports + Excel/PDF export.
- **Phase 7** — Testing, perf, security review, deployment docs.

Each phase ends with a WORKER report (files changed, APIs, DB changes, test output, remaining items). GUIDE reviews, then releases the next phase.

---

## 5. CONVERSATION LOG

### GUIDE → WORKER #1
**Task: Phase 0 — Analysis & Proposal (plus credential hygiene). Do NOT write application code yet.**

1. **Credential hygiene first (D4):**
   - Create root `.gitignore` containing at least: `node_modules/`, `.env`, `*.env.local`, `be/dbconnection.txt`, `dist/`, `build/`, `coverage/`.
   - Create `be/.env` with `DATABASE_URL=<value from be/dbconnection.txt>`, plus `PORT=5000`, `JWT_SECRET=<generate a random 64-char hex>`, `JWT_EXPIRES_IN=8h`, `APP_TIMEZONE=Asia/Kolkata`, `GPS_PROVIDER=simulator`, `GPS_POLL_INTERVAL_SECONDS=60`.
   - Create `be/.env.example` with the same keys but placeholder values.
   - Run `git status` and confirm `.env` and `dbconnection.txt` are NOT listed as untracked-to-add.
2. **Verify DB connectivity:** in `be/`, `npm init -y`, install `pg` and `dotenv`, write a throwaway script `be/scripts/db-check.js` that connects, runs `SELECT version();` and `SELECT * FROM pg_available_extensions WHERE name='postgis';`, prints results. Report both outputs (version string + whether PostGIS is available).
3. **Write `workflow-docs/phase0-proposal.md`** containing:
   - a. Repo analysis (short — it's essentially empty).
   - b. Proposed architecture (be + fe folder trees, request flow, background jobs, Socket.IO).
   - c. ER diagram (Mermaid `erDiagram`) covering all tables in flow.txt §15.
   - d. Full PostgreSQL DDL draft for every table: PKs, FKs, `NOT NULL`, `CHECK` constraints (lat −90..90, lng −180..180, status enums), `UNIQUE` constraints (`route_assignments(route_id, vehicle_id, operational_date)`, `pid_daily_status(operational_date, route_assignment_id, pid_id)`, `pids(pid_number)`, `vehicles(vehicle_number)`, `vehicles(gps_device_id)`, `gps_locations(vehicle_id, recorded_at)` for dedupe), all indexes listed in §15, `created_at/updated_at TIMESTAMPTZ DEFAULT now()`.
     - Also add tables flow.txt implies but doesn't list: `route_pids` (master route ↔ PID mapping, separate from the daily snapshot `route_assignment_pids`), and `vehicle_route_history` if you think it is needed (justify).
     - Visit status enum values exactly: `GPS_VISIT_CONFIRMED`, `GPS_VISIT_CANDIDATE`, `NOT_VISITED`, `GPS_DATA_UNAVAILABLE`, `UNASSIGNED_PID`.
   - e. Development milestones mapped to §4 phases above.
   - f. List of GPS provider API details we need from the client (auth method, base URL, endpoints for live/history, response sample, rate limits, timestamp TZ, device ID field, etc.).
4. Do **not** commit yet. When done, append a `### WORKER → GUIDE #1` block (format in §1) with: outputs of step 1 `git status`, step 2 results, and a short summary of the proposal + any questions.

### WORKER → GUIDE #1
STATUS: ANSWERED
Task: GUIDE → WORKER #1 (Phase 0 — Analysis & Proposal + credential hygiene)
Done:
- **Step 1 (credential hygiene):**
  - Created root `.gitignore` (node_modules/, .env, *.env.local, .env.*.local, be/dbconnection.txt, dist/, build/, coverage/, *.log, OS files).
  - Created `be/.env` with all 7 keys (DATABASE_URL copied from dbconnection.txt, JWT_SECRET = random 64-char hex via crypto.randomBytes(32)).
  - Created `be/.env.example` with placeholders.
  - `git status` → untracked: `.gitignore`, `be/`, `workflow-docs/`. `git status --ignored --short` shows `!! be/.env` and `!! be/dbconnection.txt`, so both are ignored and will not be added.
- **Step 2 (DB connectivity):** `be/` initialised (`npm init -y`, `"type":"module"`, deps `pg` and `dotenv`, 0 vulnerabilities). Wrote `be/scripts/db-check.js`.
  - `SELECT version()` → `PostgreSQL 18.6 (ac70818) on aarch64-unknown-linux-gnu, compiled by gcc (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0, 64-bit`
  - PostGIS → **AVAILABLE**: `{"name":"postgis","default_version":"3.6.4","installed_version":null}` (not installed yet).
  - Note: pg prints a deprecation warning that `sslmode=require` is treated as `verify-full`. I propose that `config/database.js` set `sslmode=verify-full` explicitly. Behaviour stays the same and the warning goes away.
- **Step 3:** wrote `workflow-docs/phase0-proposal.md` with sections a–f:
  - a. Repo analysis.
  - b. Architecture: be/fe trees, request pipeline, a scope middleware for zone/ward/agency row filtering, three jobs with `pg_try_advisory_lock` single-runner guards, Socket.IO rooms per scope.
  - c. Mermaid ER diagram.
  - d. Full DDL. **Validated against Neon** by running it in a transaction and then `ROLLBACK`: 18 tables created OK, 0 remain afterwards. Plus the seed plan for roles and §8.2 settings, and a sketch of the detection algorithm.
  - e. Milestones per phase, each with a "done when" check.
  - f. 13 questions for the GPS provider.
- Extra tables beyond §15: `route_pids` (master route↔PID list), `gps_poll_runs` (provider health, backs `/api/gps/provider-status`). **No `vehicle_route_history`**, because the date-keyed `route_assignments` table already is the history (reasons in §d).
- Schema choices worth reviewing:
  - Enums are TEXT + CHECK.
  - `route_assignment_pids` also snapshots PID lat/lng.
  - `pid_daily_status` rows are pre-created as NOT_VISITED when an assignment is created. UNASSIGNED_PID is derived at query time.
  - `gps_locations.processed_at` makes detection idempotent, together with UNIQUE(route_assignment_id, pid_id, gps_location_id) on events.
  - `routes.route_code` added (spec example "ROUTE001").
- Migrations choice (D5): **plain numbered `.sql` files + a small `scripts/migrate.js` runner**, tracked in a `schema_migrations` table, one tx per file. Tests: **vitest + supertest**.
- Nothing committed. No tables persisted on Neon.
Questions / Blockers:
1. Can a vehicle have **more than one route assignment on the same date** (multiple shifts/trips)? The current UNIQUE is (route_id, vehicle_id, operational_date), so that is allowed. Optional `shift_start/shift_end` decide which assignment a GPS point belongs to. OK?
2. **Midnight crossing (§22.16):** proposal is that operational_date = the IST date of `recorded_at`, unless the point falls inside an assignment's explicit shift window, in which case the assignment's date wins. Accept?
3. Should "Department" be a real entity (a `departments` table), or is Department Admin just a role with org-wide read access? I assumed the latter.
4. PostGIS is available. Enable it in Phase 1's 0001 migration (cheap to do now), or keep it deferred to Phase 4 per D2?
5. Is it OK to commit Phase 0 now (`.gitignore`, `be/package.json`, lockfile, `.env.example`, `scripts/db-check.js`, workflow-docs)?
Ask: Please review phase0-proposal.md, answer Q1–Q5, and release Phase 1 (or send corrections).

---

### GUIDE → WORKER #2
**Review of Phase 0: APPROVED with the corrections below. Phase 1a (backend foundation) is released.**

#### Answers to Q1–Q5
1. **Multiple assignments per vehicle per date: YES**, keep UNIQUE(route_id, vehicle_id, operational_date). Add a rule in the service layer: for the same vehicle + date, shift windows must not overlap. Return 409 if they do. If two assignments have NULL windows, the vehicle can't be split between them, so allow at most one NULL-window assignment per vehicle+date. A GPS point belongs to the assignment whose window contains `recorded_at`. If no window matches, it falls back to the single NULL-window assignment. If there's still no match, the point is unassigned: store it, but it gets no detection.
2. **Midnight rule: ACCEPTED** as proposed.
3. **Department: no table.** DEPARTMENT_ADMIN is a role with org-wide read access plus operational management (assignments, PIDs, routes). No user/settings admin. Write that into the role-permission seed.
4. **PostGIS:** add `CREATE EXTENSION IF NOT EXISTS postgis;` to 0001 so we know it works. Do **not** add geography columns yet; that stays in Phase 4.
5. **Commit: YES, local only. Do not push.** Before committing, run `git status --ignored --short` and confirm that `be/.env` and `be/dbconnection.txt` show as `!!`. Message: `chore: phase 0 proposal, gitignore, env template, db check`.
6. sslmode: **accepted.** Set `sslmode=verify-full` in `config/database.js`.

#### Schema corrections (apply in 0001_init.sql)
- **C1: zone/ward consistency.** Right now `pids`, `routes`, `vehicles` and `users` can store a ward_id that belongs to a different zone. Fix: add `UNIQUE (id, zone_id)` on `wards`. In those 4 tables, replace the single ward FK with a composite `FOREIGN KEY (ward_id, zone_id) REFERENCES wards(id, zone_id)`. ward_id is nullable in vehicles/users, and MATCH SIMPLE skips the check when it's NULL, which is what we want.
- **C2:** `pid_daily_status.vehicle_id` is a denormalised copy. Add a comment saying it is copied from route_assignments at creation and never updated independently.
- **C3:** `route_assignment_pids`: if the PID has no coordinates at snapshot time, still insert the row with NULL lat/lng, and pre-create its `pid_daily_status` as `GPS_DATA_UNAVAILABLE`, not NOT_VISITED. Note this in the comment; the logic itself comes in Phase 2.
- **C4:** add `CREATE INDEX idx_vehicles_device ON vehicles(gps_device_id)`. UNIQUE already gives you one, so just confirm it exists. No new index is needed if it does.
- Everything else stays as proposed (TEXT+CHECK enums, processed_at idempotency, gps_poll_runs, route_code).

#### Phase 1a tasks (backend only, `be/`)
1. **Deps:** express, helmet, cors, express-rate-limit, bcrypt, jsonwebtoken, zod (validation), pino + pino-http (logger), socket.io (install only), dotenv, pg. Dev: vitest, supertest, nodemon.
2. **Structure:** follow flow.txt §16 under `be/src/` (config, controllers, services, repositories, routes, middleware, jobs, utils, validators, app.js, index.js). `app.js` exports the Express app without listening, so supertest can use it. `index.js` listens.
3. **Migrations:** `be/migrations/0001_init.sql` (corrected DDL), `0002_seed_reference.sql` (roles with a permissions JSON per role, and the §8.2 settings as system_settings rows: `detection.radius_m=30`, `detection.max_gps_age_s=300`, `detection.min_speed_kmh`, `detection.max_speed_kmh`, `detection.consecutive_points=2`, `detection.duplicate_prevention=true`, `detection.enabled=true`, `app.timezone="Asia/Kolkata"`). Runner: `scripts/migrate.js` (`npm run migrate`). Also `scripts/seed-admin.js`, which creates a SUPER_ADMIN from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` env vars (add both to `.env.example`). The script must be idempotent.
4. **Standard response helpers** (`utils/responseHandler.js`), matching flow.txt §16: `{success, message, data, pagination?}`, plus error shape `{success:false, message, errors?}`. Add a centralized `errorMiddleware`, and map pg error codes: 23505 → 409, 23503 → 409/422, 23514 → 422.
5. **Auth:** `POST /api/auth/login` (rate-limited, 5/min/IP; on failure write LOGIN_FAILED to activity_logs; generic error message), `GET /api/auth/profile`, `POST /api/auth/logout` (stateless; just logs the event). Use bcrypt cost 12. JWT payload carries `{sub, role_key, zone_id, ward_id, agency_id}`.
6. **RBAC + scope middleware:** `requirePermission('vehicles:write')` and a `scope` helper. The helper turns `req.user` into SQL WHERE fragments (zone/ward/agency) that repositories apply. AGENCY_USER sees only its agency, WARD_SUPERVISOR its ward, ZONE_ADMIN its zone, DEPT/SUPER see everything.
7. **Master CRUD APIs** for zones, wards, agencies, vehicles: list (pagination `page/limit`, max limit 100, search, status filter, and zone/ward/agency filters where they apply), get, create, update, and soft-deactivate (status=INACTIVE, no hard delete). Validate every body and query with zod. Every write goes to activity_logs. Vehicles normalise `vehicle_number` (uppercase, strip spaces) and check that ward belongs to zone (the DB now enforces this too).
8. **Users API** (SUPER_ADMIN only): list, create, update, deactivate. Enforce role scope rules: ZONE_ADMIN needs zone_id, WARD_SUPERVISOR needs ward_id (+zone), AGENCY_USER needs agency_id. Never return password_hash.
9. **Tests (vitest + supertest):** use a separate Postgres **schema** so the main data is never touched. Test setup creates `test_<random>`, sets `search_path` through the pool's `options`, runs the migrations, and drops the schema after the run. At minimum, cover: login OK/fail/rate-limit, profile requires a token, RBAC 403 for an agency user creating a zone, scope filtering (an agency user lists only its vehicles), ward/zone mismatch → 422/409, duplicate vehicle_number → 409, pagination shape.
10. `npm run migrate` against the real Neon DB. Then `npm run seed:admin`, `npm test`, and smoke-test `/api/auth/login` with curl.
11. Commit locally (no push): `feat(be): phase 1a foundation - auth, rbac, master data`.

**Do not start the frontend yet.** Phase 1b (fe scaffold + login + master pages) comes after I review 1a.

Report back as `### WORKER → GUIDE #2` with: file tree of `be/src`, list of endpoints, migration output, **full `npm test` summary**, the curl smoke-test result (redact the token), and any deviations.
