# Assessment rostering endpoints: run notes

Notes from each phase of the first draft of the OneRoster assessment rostering service
(`assessments`, `assessmentOfferings`, `assessmentEnrollments`). The branch starts from
`feature/dms-v8-port` @ `37f099f`. The mapping and the authorization rules are in
`assessment-rostering-mappings.md`.

Decisions (2026-10-30), referred to below by number:

- D1: the provisional base path `/ims/oneroster/assessmentRostering/v1p0/`, in one constant, since the
  service has no published name yet.
- D2: the resources `assessments`, `assessmentOfferings` and `assessmentEnrollments`.
- D3: two sub-collections, `/assessmentOfferings/{id}/assessmentEnrollments` and
  `/assessments/{id}/assessmentOfferings`.
- D4: the existing `roster.readonly` and `roster-core.readonly` scopes; no new scope until the spec
  defines one.
- D5: `ASSESSMENT_ROSTERING_ENABLED` (default off). With it on, a data store without the assessment
  views (Data Standard 4.0, or not deployed) answers 404 "Assessment rostering is not available for
  this data store."
- D6: the authorization rules in `assessment-rostering-mappings.md`. An assessment with no defining
  organization is visible to every caller.
- D7: an organization outside `orgs` gets a null GUIDRef, with its Ed-Fi id in `metadata`.

After the phase 6 review (2026-10-31): going up, an offering's assigning organization counts only
when no organization is listed as taking part (review P3-5); sourcedIds keep lower-casing (P3-4).

| Phase | Status | Commit |
| --- | --- | --- |
| 0. Setup | done | no code changes |
| 1. Shared plumbing | done | `cf0d664` |
| 2. ODS PostgreSQL, DS 5.2 | done | `bb3900e` |
| 3. DMS PostgreSQL, DS 5.2 | done | `9aae6fe` |
| 4. SQL Server, DS 5.2 | done: ODS/API and DMS on SQL Server | `ad13f32` |
| 5. DS 6.1 | done: all four 6.1 sets; DS 4.0 check; DS 5.2 restored | `335bb75` |
| 6. Docs and review | done: independent review, fixes, the two decisions | `905b7c2`; follow-ups `bae5159`, `6314364`, `614087a` |

## Phase 0: setup (2026-10-30)

### Environment

| What | State |
| --- | --- |
| Branch and worktree | `feature/assessment-rostering` from `37f099f`, in its own worktree. The git-ignored `stack/dms/.env.dms*` files were copied from the port worktree (mode 600). |
| ODS stack | Ed-Fi ODS/API 7.3.2, DS 5.2, PostgreSQL, single tenant, started with `start-services.ps1` from the main checkout. OneRoster `main` container; its CRON jobs started on the first try. |
| DMS stack | `dms-pre-8.1.0-beta2.3`, DS 5.2, PostgreSQL, single tenant, started with `start-local-dms.ps1`. OneRoster on DMS from the existing `edfi-oneroster:dms-local` image (built 2026-10-29 from `37f099f`), `start-dms-services.ps1 -SkipSeed -SkipDeploy`. |

### Checks

| Check | Result |
| --- | --- |
| ODS table names | All confirmed in `EdFi_Ods`: `edfi.assessment`, `assessmentacademicsubject`, `assessmentassessedgradelevel`, `assessmentadministration`, `assessmentadministrationperiod`, `assessmentadministrationparticipation`, `studentassessmentregistration`, `descriptor`, `assessmentsection`. |
| ODS registration columns | `schoolid`, `studentusi` and `entrydate` (the StudentSchoolAssociation reference) and `educationorganizationid` are on the row, so the ODS needs no join for the school or the student key. `testingeducationorganizationid`, `reportingeducationorganizationid`, `platformtypedescriptorid`, `assessmentgradeleveldescriptorid` also present. |
| ODS period rows | `assessmentadministrationperiod` has `createdate` only, no `lastmodifieddate`, like other ODS collection tables. The parent administration's `lastmodifieddate` covers it. |
| Counts, both databases | Identical: 24 assessments, 30 subject rows, 27 grade rows, 1 administration, 1 period, 1 participation, 40 registrations. |
| Grand Bend values | `uri://ed-fi.org/Assessment` / `ACT-ABW` / "Central Texas Assessment Institute (CTAI)", assigned by and participating LEA 255901, window 2021-12-01 to 2021-12-01. All 40 registrations at school 255901001 (ODS `schoolid`; DMS through `StudentSchoolAssociation`), ed-org, testing and reporting org all 255901. None of the 24 assessments has a defining org. |
| sourcedId vectors | Assessment `942f89174d3829db3412893c78f6b4e0` and offering `50f7682c5b6ac5078efa3fb97df56acb` reproduced in SQL on the ODS. |
| ODS ed-org hierarchy | Trigger-maintained: `insertauthtuples`, `updateauthtuples` and `deleteauthtuples` on every ed-org table write `auth.educationorganizationidtoeducationorganizationid`. Fixture ed-orgs inserted inside a transaction reach the auth mapping on both platforms. |
| Helper view name | `deploy-dms.js` finds projections with `create materialized view oneroster12.<name>` (PostgreSQL) and `create table oneroster12.<name>` (SQL Server), any name, so `assessmentauthorgs` is picked up. Refresh only covers names in `REFRESH_ORDER`, which phase 3 extends. |
| Full-access path for LEA 255901 | ODS: not full access. `oneroster12.orgs` has 7 orgs, and the TPDM schools 5, 6 and 7 are outside the LEA, so the LEA token goes through the endpoint filters. DMS: full access (4 orgs, all reachable), so the LEA token skips the filters. The school 255901001 client is the only Grand Bend caller that exercises the new filters with data on both platforms. |

### Gates

| Gate | Result |
| --- | --- |
| Unit tests | `npm ci`, then `npm test`: 47 suites pass, 1 skipped; 973 tests pass, 4 skipped. |
| ODS Bruno against the `main` container | 53 requests, 194/194 (`ci.bru`, keys from the ODS stack env file). |
| DMS Bruno | `run-bruno-dms.ps1`: 54 requests 199/199; 14 requests 20/20. |

### School 255901001 clients

The ODS and DMS School clients are both ed-org 255901107, which has no registrations, so phase 0
adds a client for school 255901001 on each stack. `tests/bruno/create-assessment-clients.py`
creates them and writes the credentials to an env file (mode 600, single-quoted so it can be
sourced).

- ODS: API client "School 255901001 Test Api Client" in a new application "Assessment Test
  Application" (Test Vendor, Ed-Fi Sandbox). Not in "Test Application": `stack/settings/bootstrap.sh`
  deletes and re-adds every ed-org link on that application when rerun.
- DMS: application "OneRoster School 255901001" (OneRoster-ReadOnly, data store 1). Not by
  rerunning `setup-dms-clients.ps1 -SchoolId`, which would repoint the "OneRoster School" app the
  DMS Bruno suite uses.

Check: each token sees one org (255901001), 320 students and the same enrollments on both platforms.

## Phase 1: shared plumbing (2026-10-30)

**Scope.** The shared code: flag, routes, controller configs, authorization builders, the D5 404,
the OpenAPI fragment and discovery; not the SQL artifacts or the SQL Server and DMS refresh lists.

### What changed

| Area | Where | What |
| --- | --- | --- |
| Configuration | `src/config/assessment-rostering.js` | `ASSESSMENT_ROSTERING_ENABLED` (default off), the provisional base path `/assessmentRostering/v1p0` under `/ims/oneroster` (D1), the endpoint and view names. `envValidator` rejects anything but `true`/`false`. |
| Routes | `src/routes/assessmentRostering.js`, `src/app.js` | Collection, single-record and the two D3 sub-collections. Mounted ahead of the rostering router in the same chain (limiter, `jwtCheck`, data-store resolution), only when the flag is on. No catch-all: unknown paths fall through to the rostering router's 404. |
| Controller | `oneRosterController.js` | Three configs; hidden columns are neither selectable nor filterable. Wrapper and collection names (`assessmentOffering`, `assessmentEnrollments`, ...). Sub-collections check the parent with the caller's authorization first (404 when unknown or invisible), then filter on the hidden parent column through the existing bound-object `extraWhere`. |
| D5 404 | `oneRosterController.js` | On the three assessment endpoints only, PostgreSQL `42P01` or SQL Server 208 answers 404 "Assessment rostering is not available for this data store." (`imsx_codeMinor` `unknownobject`). Other errors keep the generic 500, and a missing view on a rostering endpoint is still a 500. |
| Authorization | `AuthorizationQueryService.js` | The three endpoints in `AUTH_ENDPOINTS`, so the full-access short circuit covers them and nothing reaches a pass-through. `buildAncestorOrgIdsQuery` (Up), now also used by courses and academic sessions (same SQL), and `buildReachableOrgIdsQuery` (Down ∪ Up). Builders per the rules in the mapping doc: enrollments by the registration school in Down plus the student mapping; offerings and assessments through `oneroster12.assessmentauthorgs` over Reach; assessments with no defining org visible to all. |
| Scopes | none | `authorizeEndpoint` already accepts `roster.readonly` or `roster-core.readonly` for every non-demographics endpoint (D4). |
| OpenAPI | `config/swagger-assessment-rostering.yml`, `src/config/swagger-document.js` | A fragment with the tag, eight paths and three schemas, merged into the served document only when the flag is on; a path or schema defined twice throws. The integrity test now runs on both documents. Phase 6 finishes the descriptions. |
| Discovery | `discoveryController.js` | `urls.assessmentRosteringApi`, after `dataManagementApi`, when the flag is on (ODS and DMS). |
| Refresh (PostgreSQL) | `cronService.js`, `viewRefresh.js` | The four views join the refresh jobs when the flag is on. A view missing from a data store (`pg_matviews`) is skipped with a debug message instead of failing the job. |

### Gates

| Gate | Result |
| --- | --- |
| Unit tests | 51 suites (50 run, 1 skipped); 1,039 pass, 4 skipped. Phase 0: 973. 63 new: compiled auth SQL for ODS and DMS names on both engines, routes over HTTP with the flag on and off, the D5 mapping, sub-collections (parent 404, bound parent id), scopes, the OpenAPI loader and merge, discovery, `envValidator`, `matviewExists`. `npm run build` passes. |
| Flag off, byte comparison | Branch image beside the stack, called directly with the `main` container's environment, against two baselines run the same way: `37f099f` (this branch's base) and the `main` image. 224 request pairs each, 0 differences: every collection page for the LEA, School 255901107 and School 255901001 clients, three single records per collection, filter, field selection with sort, six error paths, the five assessment paths (rostering 404), anonymous and bad-token calls, `/`, `/swagger.json`, `/docs`, `/oauth/token`. Scratch tool, not committed. |
| Flag off, ODS Bruno | 53 requests, 194/194 against the branch container (`--env-var oneRosterUrl=http://localhost:3100`; a closed port fails, so the override takes effect). |
| Flag on, no views | Branch container with `ASSESSMENT_ROSTERING_ENABLED=true` against the flag-off one: 17 differences, all expected (5 assessment paths x 3 clients now the D5 404, plus `/` with `assessmentRosteringApi` and `/swagger.json` with 32 paths); the other 207 pairs identical. All eight assessment paths give the D5 404 for the school 255901001 token. The refresh jobs skip the four missing views and still refresh the seven rostering views. |

### Observations

- `KnexFactory` logs every failed query at error level with its SQL, so each D5 404 also writes one
  error line beside the controller's warning. Left as it is: the listener is shared, and a D5 404
  means the flag is on for a data store without the views, which an operator should see. The
  client gets only the `imsx_*` envelope.
- Sorting on a JSON column (`sort=subjects`) fails the way it does on the existing views
  (`sort=grades` on classes): `selectableFields` allows it. Not changed here.
- GUIDRef `href`s will follow the existing relative form (`/users/<id>`, `/orgs/<id>`), and
  `/assessmentOfferings/<id>`, `/assessments/<id>` for the new resources. A reference from an
  assessment resource to a user or org therefore resolves against the rostering base. Recorded in
  the mapping doc.

## Phase 2: ODS PostgreSQL, Data Standard 5.2 (2026-10-30)

### What changed

| Area | Where | What |
| --- | --- | --- |
| Projections | `standard/5.2.0/artifacts/pgsql/core/assessments.sql`, `assessment_offerings.sql`, `assessment_enrollments.sql`, `assessment_auth_orgs.sql` | Three materialized views plus the `assessmentauthorgs` helper, as in the mapping doc. No view reads another; the "org is published" test reads `edfi.school`, `localeducationagency` and `stateeducationagency` directly. |
| sourcedIds | same | `md5` of the key parts joined with `\|`, each lower-cased with `\\` and `\|` escaped. User, school and org references keep the existing formulas. |
| Arrays | same | `subjects`, `grades` (code values, sorted) and `testingWindows` (by start date, end date nulls last) are `[]` when empty. An open-ended window has `"endDate": null`. |
| Metadata | same | `metadata.edfi` = `resource`, `naturalKey`, then the extras with nulls stripped: assessment family, form, revision date, adaptive flag and defining `educationOrganizationId`; offering `participatingEducationOrganizations` (`{educationOrganizationId, org?}`, `org` only when published); enrollment `assessmentGradeLevel`, `platformType`, `testingEducationOrganization`, `reportingEducationOrganization` (same shape). |
| `dateLastModified` | `assessment_offerings.sql` | The later of the administration and its participation rows (periods restamp the administration). |
| Helper view | `assessment_auth_orgs.sql` | One row per (assessment, offering, organization, role): defining, assigning, participating, and one row per registration school. A `sourcedId` row key (md5 of the four columns) lets the parity tools key and de-duplicate it; it isn't a OneRoster id. |
| Fixture | `tests/dms-parity-fixture.js` | Assessment registration data on both platforms' writers: a second district B (`990003`, school `990003001`) under the SEA, a testing service center (`990800`) that `orgs` doesn't publish, students FX-STU-6 (district B) and FX-STU-7 (one school in each district), six assessments (no defining org, defined outside `orgs`, defined by B, the hyphen-collision pair, and one with `\\`, `\|`, `-`, mixed case and `Ñ`), four offerings (assigned by the SEA, A, the service center and B; three windows with one open-ended; none), five registrations. `EXPECTED_COUNTS` and 31 new expectations; the new students add 3 users and 3 demographics rows. `hierarchyPairs` and the ODS/DMS hierarchy writers for the matrix. SSA and SEOA DocumentIds are now keyed so registrations can reference them (same allocation order). |
| Fixture runner | `tests/compare-dms-fixture.js` | `--platforms ods` (or `dms`) checks one platform's expectations without the comparison. Loader, `PLATFORMS` and the sequence/definition readers exported for the matrix. |
| Auth matrix | `tests/assessment-auth-matrix.js`, `.sh` | In one rolled-back transaction per platform: the fixture plus hierarchy rows, every `oneroster12` view recreated as a plain view in the scratch schema `oneroster12_authmatrix`, then the service's `OneRosterQueryService` and `AuthorizationQueryService` per caller: collections, every single record, and every sub-collection, against `ASSESSMENT_VISIBILITY`. Offerings and enrollments must include nothing outside the fixture. Checks afterwards that sequences, fixture students and the scratch schema are gone. |
| Bruno | `tests/bruno/tests-assessment/`, `environments/assessment-{ods,dms}.bru` | 31 requests, 57 tests, outside the main collection (CI runs that with the service off): shapes and vectors, sub-collections, filter/fields/sort, pagination, hidden fields rejected, the Grand Bend callers, out-of-reach 404, core scope, no-roster-scope 403. Needs `ASSESSMENT_SCHOOL_KEY`/`SECRET` for school 255901001. |

### Gates

| Gate | Result |
| --- | --- |
| Counts | ODS database and API: 24 assessments, 1 offering, 40 enrollments; helper rows assigning 1, participating 1, registration 1. |
| sourcedId vectors | Assessment `942f8917...`, offering `50f7682c...`, enrollment `9d8dbd50...` with user `078cacf2...` and school `5643e68d...`; sourcedIds unique in every view. |
| Grand Bend callers, through the API | LEA 24/1/40, school 255901001 24/1/40, school 255901107 24/1/0; sub-collections the same; the out-of-reach single enrollment is 404 for 255901107. LEA here takes the filtered path (TPDM schools). |
| Bruno `tests-assessment` (ODS, flag on) | 31 requests, 57/57. |
| Fixture, ODS | `compare-dms-fixture.sh --platforms ods`: 83/83 expectations (11 counts, 72 records); 0 existing projection rows changed; no sequence moved; rolled back. Both platforms on the existing seven views: identical (orgs 8, users 22, demographics 11 fixture rows each), so the new fixture data keeps DMS parity. |
| Auth matrix, ODS | 6 callers (SEA, both districts, three schools), 180/180 checks. Negative control: expecting O3 for district A (its testing org) fails 3 checks (collection, single record, sub-collection). |
| References resolve for their caller | Through the API for the three Grand Bend callers: 43/43, 1/1, 43/43 (users, offerings, schools, assessments). |
| Refresh jobs | The flag-on container's 15-minute job skipped the views before they were deployed and refreshed all four after. |
| Query cost | School-token filters on Grand Bend: sub-millisecond; the reach set is built once and hash-joined to the helper view. A state-sized hierarchy isn't available locally. |
| Unit tests | 1,039 pass, 4 skipped; build check passes. |

### Observations

- The first expected-visibility table was missing O4 for schools A1 and B1, which the offering rule
  makes visible (A takes part; B assigned it). The fixture's `ASSESSMENT_VISIBILITY` is the reference.
- The fixture loads with triggers off, so the hierarchy rows come from `hierarchyPairs`, not the
  triggers that would normally write them.
- The ODS/API caps tokens per client in a short period (`TooManyTokensException`, HTTP 429). Many
  check runs in one session hit it; wait for tokens to expire (30 minutes) between heavy runs.
- Both PostgreSQL databases lower-case `Ñ` and hash UTF-8, matching JavaScript. SQL Server is phase 4.

## Phase 3: DMS PostgreSQL, Data Standard 5.2 (2026-10-30)

### What changed

| Area | Where | What |
| --- | --- | --- |
| Projections | `standard/5.2.0/artifacts/dms-pgsql/core/assessments.sql`, `assessment_offerings.sql`, `assessment_enrollments.sql`, `assessment_auth_orgs.sql` | The same output as the ODS views from the DMS tables. None of them is hash-named, so no name-map entries. The registration carries the school (`StudentSchoolAssociation_SchoolId`) and the student unique id; the student's `DocumentId` for authorization comes from its `StudentSchoolAssociation`. Periods, subjects and grades are collections of their documents; participations are documents. |
| Refresh | `standard/deploy-dms.js` | The four views join `REFRESH_ORDER`. Change tracking needed nothing else: subjects and grades resolve to `edfi."Assessment"` and periods to `edfi."AssessmentAdministration"`, asserted in `deploy-dms.test.js`, which now also expects the four views in the DS 5.2 PostgreSQL set only. |
| DB parity | `tests/compare-dms-database.js` | The four views are compared by default when both data stores have them, skipped when neither does, and a difference when only one does. |
| API parity | `tests/compare-api-ods-dms.js` | `--assessment-rostering` adds the three collections and their single records for both clients (paths from the service root). A collection only one side returned is now a difference instead of being ignored; `dms-vs-recording` compares the assessment collections when the recording has them. |
| DMS service env | `stack/dms/.env.dms` (git-ignored) | `ASSESSMENT_ROSTERING_ENABLED=true` for this run. `start-dms-services.ps1 -Rebuild -SkipSeed` rebuilt the shared `edfi-oneroster:dms-local` tag from this branch. |

### Gates

| Gate | Result |
| --- | --- |
| Deploy | 11 views; assessments 24, offerings 1, enrollments 40, helper 3 rows. |
| DB parity | `compare-dms-database.sh`: 0 row/type differences across 11 views (assessments 24, offerings 1, enrollments 40, helper 3 identical). Again after the change checks: 0. |
| Fixture parity | `compare-dms-fixture.sh`, both platforms: 0 problems across 11 views, `dateLastModified` included; 83/83 expectations on each. |
| Auth matrix | `assessment-auth-matrix.sh`: ODS 180/180, DMS 180/180. |
| API parity | `compare-api.js ods-vs-dms --assessment-rostering` (ODS side the flag-on branch container): 304 requests, 13 differences, all 13 known (the #133 short-circuit item), 0 unexplained. LEA 24/1/40 and School 24/1/0 identical, single records included. |
| DMS Bruno | Main collection 54 requests 199/199, `tests-dms` 14 requests 20/20 (flag on), `tests-assessment` 31 requests 57/57 (`assessment-dms.bru`, school 255901001 client). |
| Change tracking (DMS) | Service stopped; a temporary EdFiSandbox application (deleted after) wrote through the DMS API, and `refreshView` ran over all 11 views after each step. Registration create, update (platform type) and delete: exactly `assessmentenrollments` and `assessmentauthorgs` refreshed each time; the row appeared (41), changed, and went (40). Participation create (school 255901001): `assessmentofferings` and the helper refreshed, the offering's `dateLastModified` moved to the participation's timestamp and the school joined `participatingEducationOrganizations`; delete: the offering back byte for byte. A pass with no change refreshed nothing. |
| ODS writes | LEA client through the ODS/API: registration create, update, delete with a refresh after each: 40 -> 41 (Paper-based) -> 41 (Computer-based) -> 40; no registration left. |
| Flag-off regression | ODS Bruno against the flag-off branch container 194/194; byte comparison with `37f099f`: 224 pairs, 0 differences. |
| Unit tests | 1,040 pass, 4 skipped; build check passes. |

### Commands

```sh
# DB, fixture and matrix (ODS_PG / DMS_PG as in the port run notes; superuser logins)
tests/compare-dms-database.sh
tests/compare-dms-fixture.sh            # --platforms ods|dms for one side
tests/assessment-auth-matrix.sh         # --platforms ods|dms for one side
ODS_MSSQL="server=...;..." DMS_MSSQL="server=...;..." \
  node tests/assessment-auth-matrix.js --engine mssql   # copies of the databases, not live ones

# API parity, ODS side a flag-on service
ODS_ONEROSTER_URL=http://127.0.0.1:3103 node tests/compare-api.js ods-vs-dms \
  --ods-env <ODS checkout>/stack/pgsql/.env.5.2.0 --dms-env stack/dms/.env.dms-clients \
  --known tests/dms-parity-known-differences.json --assessment-rostering

# Bruno, assessment suite (ASSESSMENT_SCHOOL_KEY / SECRET: a client for school 255901001)
bru run tests-assessment -r --env-file environments/assessment-ods.bru   # or assessment-dms.bru
```

## Phase 4: SQL Server, Data Standard 5.2 (2026-10-31)

No ODS/API on SQL Server had run locally before; the port's ODS SQL Server findings came from reading the files.

### What changed

| Area | Where | What |
| --- | --- | --- |
| ODS artifacts | `standard/5.2.0/artifacts/mssql/core/assessments.sql`, `assessment_offerings.sql`, `assessment_enrollments.sql`, `assessment_auth_orgs.sql` | Tables and `sp_refresh_*` procedures (staging table, then truncate-and-insert, history and error logging), same output as PostgreSQL. String arrays with `STRING_AGG` + `STRING_ESCAPE`, `[]` when empty; objects with `FOR JSON PATH`, which leaves nulls out as `json_strip_nulls` does; testing windows with `INCLUDE_NULL_VALUES` so an open-ended window keeps `"endDate": null`. |
| DMS artifacts | `standard/5.2.0/artifacts/dms-mssql/core/` (the same four) | The DMS tables, quoted `edfi.[Name]` for the reference check; `SELECT TOP 0 * INTO` staging as the other DMS files. |
| Refresh | `standard/5.2.0/artifacts/{mssql,dms-mssql}/orchestration/master_refresh.sql` | `sp_refresh_all` runs the four after the rostering tables; the two row-count queries had `< 7` hard-coded for seven tables, now `< 11`. The DS 4.0 and 6.1 files are unchanged (phase 5 does 6.1). |
| sourcedIds on SQL Server | the eight files | The new ids hash `CAST(<key> COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))`, the UTF-8 bytes, as PostgreSQL does. The rostering tables hash `VARCHAR` in code page 1252, which gives a different id on each engine for a non-ASCII key; the user and org references keep that formula, so they still match the users and orgs tables. |
| Tools | `tests/compare-dms-engines.js` | The four views by default, as in `compare-dms-database.js`: skipped when neither engine has them (an older snapshot has no file for them), a difference when only one does. |
| Tests | `tests/unit-tests/assessment-rostering-artifacts.test.js`, `deploy-dms.test.js` | Every 5.2 set defines the four objects and escapes its key parts; the SQL Server sets hash as UTF-8 and list the tables in `sp_refresh_all`; DS 4.0 has none. |

### ODS/API on SQL Server

Stood up from the stack's SQL Server compose file (Ed-Fi ODS/API 7.3.2 packages, DS 5.2 Populated
with TPDM 1.1.0, OneRoster from this branch with the flag on), with the PostgreSQL ODS stack stopped
(volumes kept, tar backups first). Problems found on the way, in the upstream stack:

- **The SQL Server compose file names its volumes `vol-db-ods` and `vol-db-admin`, the same as the
  PostgreSQL stack's.** Started as documented, it would mount the PostgreSQL databases' volumes into
  SQL Server. Run here with a compose override giving the volumes their own names
  (now `stack/mssql/single-tenant/docker-compose-mssql.own-volumes.yml`) and `docker compose -p oneroster-ods-mssql`
  directly, because `start-services.ps1` can't take an extra compose file. Same class as the earlier
  volume-name fix branch.
- `mssql/.env.5.2.0.example`: the admin connection names `server=db-admin`, but the container is
  `ed-fi-db-admin`; the package versions read `5.2.0` where the Ed-Fi feed has `7.3.x` builds (used:
  WebApi 7.3.20404, Populated 7.3.20065, Minimal 7.3.20062, TPDM 7.3.20044 / 7.3.20166, Admin
  7.3.20023, Security 7.3.20026); `API_VERSION` and `SWAGGER_TAG_7X` aren't in it; `EXTENSION_VERSION`
  is a placeholder (`1.1.0` for DS 5.2).
- A worktree has no `stack/ssl` certificate (generated, git-ignored): nginx won't start until
  `server.crt`, `server.key` and `dhparam.pem` are copied in.
- The SQL Server EdFi_Admin link column is
  `ApiClientApplicationEducationOrganizations.ApplicationEducationOrganization_ApplicationEducationOrganizationId`
  (PostgreSQL: `applicationedorg_applicationedorgid`).
- The ODS/API caches a failed client lookup: a token request made before a client existed kept
  answering `invalid_client` after it was created, until the API container restarted.

| Check | Result |
| --- | --- |
| Deploy (`setup-oneroster-data.psm1`, all 14 core files and the orchestration) and `sp_refresh_all` | 11 tables, all `Success`, no `refresh_errors`. Rostering counts as on PostgreSQL (orgs 7, users 3,900, enrollments 13,968, demographics 1,959); assessments 24, offerings 1, enrollments 40, helper 3. |
| sourcedId vectors | Assessment, offering and enrollment ids, user and school references: all match. |
| Grand Bend callers through the API | LEA 24/1/40, school 255901001 24/1/40, school 255901107 24/1/0; sub-collections the same. |
| Bruno | Main collection 53 requests 194/194; `tests-assessment` 31 requests 57/57 (`assessment-ods.bru`, a school 255901001 client added to the SQL Server EdFi_Admin). |
| Same values as PostgreSQL | The assessment collections for LEA and School compared with the DMS PostgreSQL recording (which phase 3 showed equal to the ODS on PostgreSQL), `dateLastModified` aside: 90 items identical, same order. `version` stays a string; JSON columns parse to arrays and objects. |
| Non-ASCII key | The fixture's `Esc\Back\|Pipe-Ñu` assessment key: SQL Server `faea9e684aa4f482bb40646a1c614842`, the same as the fixture's JavaScript value that PostgreSQL met in phase 3. The `VARCHAR` idiom would give `150d1c8116b9e8fa6b2e9883d9f4d1d9`. |

### DMS on SQL Server

The PostgreSQL DMS stack and the OneRoster service stopped (volume kept). Before the switch, the
PostgreSQL side was saved: `compare-dms-engines.js --save-pg tests/.dms-compare/pg-ds52-assessment`
(11 views) and `compare-api.js dms-record --assessment-rostering` (152 requests, 30 collections;
replayed against PostgreSQL itself: 0 differences). Tar backups first (the PostgreSQL volume, and the SQL Server volume's DS 6.1 store), then only `dms-local_dms-mssql-2025` was removed and
`bootstrap-local-dms.ps1 -DatabaseEngine mssql -LoadSeedData -SeedTemplate Populated` provisioned DS
5.2 (schema hash `6f7cac14…`) and loaded Grand Bend: 104,735 creates, no 4xx or 5xx. SQL Server Agent
enabled; clients from `setup-dms-clients.ps1 -DatabaseEngine mssql` (`.env.dms-clients.mssql`,
`.env.dms.mssql` with the flag on); a school 255901001 application for the Bruno suite.

| Check | Result |
| --- | --- |
| Deploy (`start-dms-services.ps1 -Rebuild`) | 11 tables; `sp_refresh_all` 3.8 s; Agent job created. Counts as on PostgreSQL: assessments 24, offerings 1, enrollments 40, helper 3; users 2,901. |
| `compare-dms-engines.js --pg-snapshot` | 0 row/column differences across 11 views. |
| `compare-api.js dms-vs-recording` (SQL Server against the PostgreSQL recording) | 152 requests, 0 differences, every collection in the same order, the six assessment collections included. |
| Bruno (`run-bruno-dms.ps1 -ClientsFile stack/dms/.env.dms-clients.mssql`) | Main 54 requests 199/199; `tests-dms` 14 requests 20/20; `tests-assessment` 31 requests 57/57. |
| Non-ASCII key | SQL Server 2025 (17.0.5035.5, database collation `SQL_Latin1_General_CP1_CI_AS`): `faea9e684aa4f482bb40646a1c614842`, the same as the ODS's SQL Server 2022 and PostgreSQL. |
| Unit tests | 1,054 pass, 4 skipped; build check passes. |

At this point the synthetic fixture and the auth matrix were PostgreSQL tools, and Bruno checked the
three Grand Bend callers through the API on SQL Server. The matrix now runs on SQL Server too: see
"Follow-up: the authorization matrix on SQL Server" below.

## Phase 5: Data Standard 6.1 and the 4.0 check (2026-10-31)

Each stack was swapped onto fresh volumes after tar backups, as in
the port's phase 5; the DMS `.bootstrap/` workspace was saved
and cleared before each Data Standard or engine switch,
which `bootstrap-local-dms.ps1` requires.

### What changed

| Area | Where | What |
| --- | --- | --- |
| Artifacts | `standard/6.1.0/artifacts/{pgsql,mssql,dms-pgsql,dms-mssql}/core/assessment*.sql` | The 5.2 files with the two Data Standard 6.1 differences: an assessment has one `academicSubjectDescriptor` (`subjects` is an array of 0 or 1; no `AssessmentAcademicSubject` table), and on DMS the registration's org key is `StudentDemographic_EducationOrganizationId`. The ODS registration keeps `educationorganizationid`. Identifiers up to 120 characters fit the existing columns (`NVARCHAR(120)` on SQL Server). |
| Refresh | `standard/6.1.0/artifacts/{mssql,dms-mssql}/orchestration/master_refresh.sql` | The four tables in `sp_refresh_all` and the row counts, as for 5.2. |
| Tests | `deploy-dms.test.js`, `assessment-rostering-artifacts.test.js` | The 6.1 sets now have the assessment views; DS 4.0 still has none. |
| Bruno note | `tests/bruno/tests-assessment/folder.bru` | The suite's counts are the DS 5.2 Grand Bend sample's; 6.1 has 65 assessments. |

### Gates

| Gate | Result |
| --- | --- |
| ODS/API PostgreSQL DS 6.1 (images `7.3.2_6447-6.1.0`, `TPDM_ENABLED=false`) | Views deployed from the worktree: assessments 65 (each with one subject), offerings 1, enrollments 40, helper 3; orgs 10, users 5,377 as in the port's 6.1 run. The sourcedId vectors are unchanged on 6.1. Through a flag-on branch container: LEA 65/1/40, school 255901001 65/1/40, school 255901107 65/1/0. |
| DMS PostgreSQL DS 6.1 (schema hash `d7662d02…`, 157,432 seed records, no errors) | `compare-dms-database.sh --exclude-edorgs ''` against the ODS: 0 differences across 11 views. `compare-api.js ods-vs-dms --exclude-edorgs '' --assessment-rostering`: 334 requests, 0 differences, same order. |
| 120-character identifier | Posted through the ODS/API and through DMS (a temporary EdFiSandbox application, deleted after): `FX-Long-Identifier\|AAA…` (120 characters) comes back intact in `assessments` with sourcedId `768f1dc0ee7727470fa8114a01f80702` on both, then deleted. |
| DMS SQL Server DS 6.1 (165,852 seed records, no errors) | `compare-dms-engines.js --pg-snapshot` (the PostgreSQL 6.1 store saved first): 0 differences across 11 views. `dms-vs-recording`: 167 requests, 0 differences, same order. |
| ODS/API on SQL Server DS 6.1 (the SQL Server compose file under project `oneroster-ods-mssql61`, its own `vol-mssql61-*` volumes, `mssql/.env.6.1.0`: Data Standard 6.1, no TPDM, the same 7.3.2 package builds as 5.2) | `sp_refresh_all`: 11 tables `Success`, no errors, counts as on PostgreSQL 6.1 (assessments 65, users 5,377). The assessment collections for LEA and School compared with the DMS PostgreSQL 6.1 recording (equal to the ODS on PostgreSQL 6.1 above), `dateLastModified` aside: 172 items identical, same order. |
| DS 4.0 regression (ODS/API PostgreSQL, images `7.3.2_6447-4.0.0`, the unchanged 4.0 artifacts) | No assessment registration tables and no assessment views. A flag-on branch container: all seven assessment paths give the D5 404; the main Bruno collection 54 requests 199/199; the refresh jobs skipped the four views with a debug message, no errors. |

Problems on the way:
- The first DS 4.0 start lost its PostgreSQL connection part way through restoring the populated
  template (the DMS SQL Server seed load was running beside it), restarted, and skipped
  initialization, leaving an incomplete template. Stack stopped, volumes removed, started again with
  the SQL Server stack down: clean.
- On a fresh ODS volume the macOS `init-databases.sh` problem recurred (known; rerun it by hand).
- The DS 4.0 example env pins image digests that aren't on Docker Hub; the `7.3.2_6447-4.0.0` tags
  are.

### Restore and DS 5.2 gates again

- DMS: the PostgreSQL volume emptied and untarred from its backup
  (its compose labels kept); `.bootstrap/` restaged for DS 5.2 with `prepare-dms-schema.ps1` on a copy
  of `.env` with `.env.bootstrap.ds52` applied (hash `6f7cac14…`) and `prepare-dms-claims.ps1`;
  `start-local-dms.ps1`: Ed-Fi 5.2.0 + TPDM 1.1.0, users 2,901, assessments 24, enrollments 40. The
  OneRoster service from `.env.dms` without reseeding or redeploying. The SQL Server volume keeps the
  DS 6.1 store, as the port left it.
- ODS: both volumes emptied and untarred from the 2026-10-31 backups; started from the main checkout
  with `pgsql/.env.5.2.0`: users 3,900, orgs 7, enrollments 13,968, assessments 24, 40 registrations;
  CRON started on the first try.

| Gate (DS 5.2, after the restore) | Result |
| --- | --- |
| DB parity | 0 differences across 11 views |
| Fixture | 0 problems across 11 views; 83/83 on each platform |
| Auth matrix | 180/180 on each platform |
| ODS Bruno | Main 194/194 (the `main` container); `tests-assessment` 57/57 (flag-on branch container) |
| DMS Bruno | Main 199/199, `tests-dms` 20/20, `tests-assessment` 57/57 |
| API parity | 304 requests, 13 known differences, 0 unexplained |
| Flag off | 224 request pairs against `37f099f`, 0 differences |
| Unit tests | 1,066 pass, 4 skipped; build check passes |

## Phase 6: docs and review (2026-10-31)

An independent review read `37f099f..335bb75`. It found no P1, one P2 and eight P3s; what was
done about each is below.

### What changed

| Area | Where | What |
| --- | --- | --- |
| SQL Server deploy (P2-1, P3-1) | `standard/refresh-data-mssql.js`, `deploy-mssql.js`, the four `master_refresh.sql`, `README_mssql.md`, `deploy-postgres.sh` | The post-deploy refresh runs the assessment procedures when deployed. `sp_refresh_all` skips an assessment table whose procedure isn't there. The status counts cover the tables that exist, built with `STRING_AGG ... WITHIN GROUP`, because concatenating into a variable has no guaranteed row order. `deploy-mssql.js` leaves the assessment files out below SQL Server 2019. README manual lists and prerequisite updated. |
| Authorization (P3-2, P3-5) | `AuthorizationQueryService.js` | Assessments and offerings are always filtered; the full-access short circuit stays for enrollments. Going up, the assigning organization counts only for an offering without participating organizations (`orgRole` in the helper view, no view change). Fixture: MIDDLE no longer sees O2, B1 no longer sees O4. |
| Not available (P3-6) | `oneRosterController.js` | The D5 404 needs the database error to name a `oneroster12` assessment view; a missing `auth` table stays a 500. |
| Order (P3-7) | the eight `assessments.sql` | `subjects` and `grades` sorted by code point: `COLLATE "C"`, `Latin1_General_100_BIN2`. |
| Schedules | `cronService.js` | With the flag off, startup removes the four assessment schedules an earlier run left in pg-boss (`unschedule` is a plain delete in pg-boss 12.35). |
| Docs | `assessment-rostering-mappings.md` | P3-3 (sibling org references), P3-4 (case-only key collisions), P3-8 (`İ`), the new rules, test gaps. |
| Tests | `assessment-rostering-{auth,routes,artifacts,cron}.test.js`, `AuthorizationQueryService.test.js` | 1,076 pass, 4 skipped; build check passes. |

### Gates

| Gate | Result |
| --- | --- |
| DS 5.2 PostgreSQL, after the views were redeployed and the images rebuilt | DB parity 0 differences (11 views); fixture 83/83 on each platform; auth matrix 180/180 on each platform with the new expectations; ODS Bruno 194/194 and `tests-assessment` 57/57; DMS Bruno 199/199, `tests-dms` 20/20, `tests-assessment` 57/57; API parity 304 requests, 13 known, 0 unexplained; flag off 224 request pairs against `37f099f`, 0 differences. |
| ODS/API SQL Server DS 5.2 (`oneroster-ods-mssql`) | `node standard/deploy-mssql.js ds5`: all 14 core files and `master_refresh.sql` deploy on SQL Server 2022; `refresh-data-mssql.js`: 11/11 procedures, counts as on PostgreSQL. `sp_refresh_all`: 11 `Success`; `sp_refresh_status`: 11 counts. With the four assessment procedures and tables dropped: `sp_refresh_all` `Success` on 7, status counts 7, the API answers the D5 404 on collections, single records and sub-collections, rostering unchanged; restored by deploying again. Bruno 194/194 and `tests-assessment` 57/57. API for LEA, School and school 255901001 against ODS PostgreSQL: 155 items identical, same order. |
| ODS/API SQL Server DS 6.1 (`oneroster-ods-mssql61`) | Deploy and refresh as for 5.2 (assessments 65, users 5,377); `sp_refresh_all` 11 `Success`. API for LEA and School against the DMS PostgreSQL 6.1 recording: 172 items identical, same order (no school 255901001 client on that admin database). |
| DMS SQL Server files | Not run on DMS: the changed `dms-mssql` `assessments.sql` and `master_refresh.sql` (5.2, 6.1) compile under `SET NOEXEC ON` on SQL Server 2022 with no errors; a deliberate syntax error is reported the same way. |
| `İ` | SQL Server 2022 `LOWER(N'İ')` is `i`, md5 `865c0c0b…`, as on the local PostgreSQL databases; JavaScript gives `i̇`. |

Problems on the way, in the upstream stack:
- `deploy-mssql.js` against a SQL Server without the Agent running (the Ed-Fi container): `sql_agent.sql`
  fails, the deploy counts as failed and skips its data refresh. `refresh-data-mssql.js` run on its own
  works. Not new on this branch.
- `standard/.env.deploy` is read with dotenv, which treats an unquoted `#` as the start of a comment:
  a password with `#` has to be quoted. The example doesn't say so.
- After swapping the SQL Server stack's `nginx` for the PostgreSQL one on port 443, Docker Desktop's
  port forward reset every connection until `nginx` was restarted.
- The ODS/API token cap per client (`TooManyTokensException`, 429) outlasts the five minutes the
  flag-off diff waits after a full gate run; run it on its own, or later.

### Follow-up: Data Standard 5.0 and 5.1 (found drafting the end-user docs)

The published docs say Data Standard 5.0 and 5.1 deploy the 5.2.0 artifacts, but the Assessment
Registration domain is new in 5.2. On such an ODS the assessment files fail, and the stack bootstrap
(`setup-oneroster-data.psm1`, `ON_ERROR_STOP`, files in name order) would stop before `classes.sql`,
leaving most rostering views undeployed even with the flag off.

| Area | Where | What |
| --- | --- | --- |
| Deploy | `standard/assessment-artifacts.js` (new), `deploy-pgsql.js`, `deploy-mssql.js`, `deploy-postgres.sh`, `stack/setup-oneroster-data.psm1` | Each checks for `edfi.AssessmentAdministration` and leaves the `assessment*` files out without it, with a message; `deploy-mssql.js` keeps its SQL Server 2019 rule through the same function. |
| Docs | `README_pgsql.md`, `README_mssql.md`, `.env.example`, the Swagger fragment, `tests/README.md`, `docs/local-development-guide.md` | Manual steps list the assessment files (5.2 and later); the flag in `.env.example`; Swagger no longer cites internal open questions or a parent resource on top-level collections; fixture count 83/83 on 11 views; DMS on SQL Server and 6.1. |

| Check | Result |
| --- | --- |
| Unit | 1,080 pass, 4 skipped; `selectArtifactFiles` tests; build check passes. |
| Pre-5.2 PostgreSQL | Scratch copy of the DS 5.2 minimal template with `edfi.assessmentadministration` dropped: `deploy-pgsql.js` skips the four files, deploys the other 10, all seven rostering views created. An unchanged copy: 14 files, 11 views. Both scratch databases dropped. |
| Bootstrap check | `Test-OdsHasAssessmentRegistration`: false on the pre-5.2 copy and SQL Server `master`, true on both `EdFi_Ods` databases (PostgreSQL and SQL Server 2022). |
| SQL Server DS 5.2 | `deploy-mssql.js ds5` still deploys the assessment files (15 of 16 files; `sql_agent.sql` fails without the Agent, as before). |
| Not run | `deploy-postgres.sh` (it targets a container name the local stack doesn't use); checked with `bash -n`. |

### Follow-up: test gaps from the review

| Area | Where | What |
| --- | --- | --- |
| Fixture | `tests/dms-parity-fixture.js` | An assessment with local subject codes `ab`, `Re-test`, `Ac` (expected in code-point order: `Ac`, `Re-test`, `ab`); an assessment and sitting (O5) defined and assigned only by the service center. `ASSESSMENT_FIXTURE_IDS`, `ASSESSMENT_CLAIM_PAIRS`, `ASSESSMENT_FULL_ACCESS_VISIBILITY`. |
| Auth matrix | `tests/assessment-auth-matrix.js` | Callers: the six single organizations, two pairs (union of what each sees), and one claiming every published organization (checked to take the full-access path; offerings and enrollments outside the fixture allowed for it only). Single-record checks cover every fixture row, hidden ones included. New check: every visible enrollment's offering and every visible offering's assessment is visible to the same caller. |
| href check | `tests/href-integrity.js` | The six assessment links, skipped where the views aren't deployed. Target ids are now looked up directly: the old capped sample (2,000 ids) made links into a larger table look broken, `enrollments.user` included. |

| Check | Result |
| --- | --- |
| Fixture parity | 0 problems across 11 views; 87/87 expectations on ODS and on DMS. |
| Auth matrix | 9 callers, 341/341 checks on ODS and on DMS; rolled back. |
| href check | 17 passed, 1 skipped (no Grand Bend assessment has a defining organization), 0 failed, on ODS and DMS PostgreSQL. Before the lookup fix, `enrollments.user` and `assessmentenrollments.user` reported 10 false failures each; a direct query shows 0 unresolved user links in both views. |

### Follow-up: the authorization matrix on SQL Server

| Area | Where | What |
| --- | --- | --- |
| Loader | `tests/mssql-fixture-loader.js` | Loads the synthetic fixture into a SQL Server ODS or DMS data store inside the caller's transaction. Each table it writes gets its foreign keys and triggers disabled (`NOCHECK`, `DISABLE TRIGGER`; the rollback restores them). Identity columns and columns defaulting to `NEXT VALUE FOR` get explicit negative values, since SQL Server doesn't roll identities or sequences back and a value below the current identity leaves it alone. The fixture's PostgreSQL names (lower case, hash-truncated) match SQL Server's without regard to case; DMS placeholders resolve through the `dms-mssql` name map. |
| Matrix | `tests/assessment-auth-matrix.js --engine mssql` | `ODS_MSSQL` / `DMS_MSSQL`. The same callers and checks as PostgreSQL (now one shared function). The projections are tables, so the fixture goes in and the refresh runs inside the transaction (first `sp_refresh_all @ForceRefresh = 1`; since upstream #168 made `sp_refresh_all` refuse an open transaction, the `sp_refresh_<table>` procedures in its order); the run fails if a table doesn't refresh or a refresh ends the transaction. Afterwards: identities (except the refresh history's), sequences, disabled foreign keys and triggers, fixture students and fixture rows in the assessment tables all as before. Readers of `oneroster12` wait while it runs, so it is for copies. |
| Tests | `tests/unit-tests/mssql-fixture-loader.test.js` | 12 tests: name matching (case, truncation, name map), explicit ids, `IDENTITY_INSERT` in the insert's own batch (a parameterized statement is its own batch, so a separate `SET` doesn't reach it), timestamps, foreign keys and triggers disabled once per table, descriptor lookup on both platforms. |

Run on the local SQL Server 2022 (`ed-fi-db-ods`, port 1445), against scratch databases, dropped after:

- ODS: `EdFi_Ods_AuthMatrix`, restored from the DS 5.2 populated template, with the branch's
  `mssql` core files and `master_refresh.sql` (not `sql_agent.sql`, which would have re-pointed the
  server's Agent job) and one refresh.
- DMS: `Dms_AuthMatrix`, provisioned from the DS 5.2 SQL Server DDL emitted in the port
  (`api-schema-tools ddl emit`, schema hash `6f7cac14…`, 677 tables), then
  `deploy-dms.js --db-type mssql`. The DMS SQL Server volume holds a DS 6.1 store and was left
  alone, so this store is empty apart from the fixture and runs on SQL Server 2022, not the
  stack's 2025. With no Grand Bend rows, the checks that nothing outside the fixture leaks pass
  trivially there; the ODS run covers them.

| Check | Result |
| --- | --- |
| Auth matrix, ODS on SQL Server | 9 callers, 341/341 checks; rolled back, nothing left (identities, sequences, foreign keys, triggers, rows). About 5 s including the refresh. |
| Auth matrix, DMS on SQL Server | 9 callers, 341/341 checks; rolled back, nothing left. |
| Negative control, both | `assessment_auth_orgs.sql` redeployed with the participating organizations left out (`WHERE 1 = 0`): 16 problems on each, in offerings collections, single records and sub-collections. The original redeployed: 341/341 again. |
| PostgreSQL, after the refactor | `assessment-auth-matrix.sh`: ODS 341/341, DMS 341/341. |
| After merging upstream #168 (2026-11-03) | `sp_refresh_all` inside a transaction now fails with "cannot run inside an open transaction", so the matrix runs the per-table procedures. Fresh scratch databases with the merged files: ODS 341/341, DMS 341/341; rolled back. |
| Unit tests | 1,155 pass, 4 skipped; build check passes. |

## Re-test on DMS 8.1.0 (2026-11-09)

With DMS `v8.1.0` and no code change. The stacks, the schema check and the rostering results are in
the DMS port run notes (`docs/design/dms-port-run-notes.md`, "Re-test on DMS 8.1.0"). The 8.1.0
DDL changes nothing the assessment views read.

| Check | Result |
| --- | --- |
| Deploy | Same row counts as beta2.3 on every stack: DS 5.2 assessments 24, offerings 1, enrollments 40, helper 3; DS 6.1 assessments 65, offerings 1, enrollments 40, helper 3. |
| `tests-assessment` (DMS environment, school 255901001 client) | PostgreSQL DS 5.2: 31 requests, 57/57. SQL Server DS 5.2: 57/57. |
| Fixture parity | 0 problems; 87/87 on each platform. |
| Auth matrix, PostgreSQL | ODS 341/341, DMS 341/341. |
| Auth matrix, DMS on SQL Server | Scratch database built from 8.1.0's DS 5.2 SQL Server DDL (676 tables) on SQL Server 2022, then `deploy-dms.js --db-type mssql` and `assessment-auth-matrix.js --engine mssql --platforms dms`: 9 callers, 341/341, rolled back. Database and Agent job removed afterwards. |
| Database and API parity with the ODS | 0 differences across 11 views; `compare-api.js ods-vs-dms --assessment-rostering` 304 requests, 0 unexplained. |
| DS 6.1, both engines | The assessment collections are part of `dms-vs-recording` against beta2.3 DS 6.1: 0 differences. |
| Multi-tenant | DistrictA 24 assessments, DistrictB none; database and API parity through `/DistrictA` include the assessment views. |

With this re-test, `stack/dms/.env.dms.5.2.0.example` and `.env.dms.5.2.0.mssql.example` list
`ASSESSMENT_ROSTERING_ENABLED` (off), since `setup-dms-clients.ps1` writes the service env from them,
and `tests/bruno/create-assessment-clients.py` parses its options (`--help`, `--dms-compose-dir`) and
reports a missing DMS `.env` or clients file plainly.
