# Ed-Fi API v8 (DMS) port: run notes

Notes from each phase of the port of this service to Ed-Fi API v8 (the Data Management
Service). Phase 0 artifacts are in `docs/design/dms-samples/` and `tests/dms-spike/`.

Decisions taken before phase 1 (2026-10-28): the projections live inside each DMS data-store
database; PostgreSQL + DS 5.2 first;
the `ONEROSTER_CLAIMSET_SCOPES` map; a dedicated `oneroster_jobs` pg-boss database; DMS pinned to
`dms-pre-8.1.0-beta2.3` (`897c008`); TPDM ed-orgs 5/6/7
excluded from parity; a custom verifier for self-contained CMS tokens; staff primary-org ranking
by `"DocumentId" desc, schoolId`.

| Phase | Status | Commit |
| --- | --- | --- |
| 0. DMS spike | done | `9dd9477` |
| 1. Platform abstraction | done | `2f20c46` |
| 2. DS 5.2 PostgreSQL artifacts | done | `7f11eb1` |
| 3. Auth and routing on DMS | done; live multi-tenant run done 2026-10-29 | `dca17ce`; multi-tenant run: see [Live multi-tenant run](#live-multi-tenant-run-2026-10-29) |
| 4. Stack, bootstrap, docs | done; clean-machine gate passed | `d1b4bf2` |
| Independent review of 1–4 | 8 findings fixed; synthetic fixture committed, parity on all 7 views | `df724f0`; fixture `91eb3a9` |
| 5. SQL Server and DS 6.1 | done: parity on all four engine and data standard combinations | SQL Server `be8ab8a`; DS 6.1 `5a5129d` |
| 6. Hardening and upstream | done; CI job file unverified (can't run locally) | `be89c08` |

## Phase 1: platform abstraction (2026-10-28)

**Scope.** Add `PLATFORM`; extract `TokenVerifier`, `ClaimsProfile`, `DataStoreProvider`
and the auth column map; let the route builder take the ODS template or DMS qualifier segments;
validate the environment per platform; no behavior change on the ODS/API.

### What changed

| Seam | Where | ODS/API | DMS |
| --- | --- | --- | --- |
| Platform switch | `src/config/platform.js` | `PLATFORM` unset or `ods` | `PLATFORM=dms` |
| Claims profile | `src/platform/claims-profile.js` | Existing parsing, moved: `scope`, `educationOrganizationId`, `tenantId`, `odsInstanceId`/`odsInstances` | `educationOrganizationIds` and `dataStoreIds` as CSV, claim-set name from `scope`, no tenant. `getScopes` throws (see below) |
| Token verifier | `src/platform/token-verifier.js`, `src/middleware/jwtCheck.js` (was `jwtVerifyWithPem.js`) | PEM verifier, same checks; the bearer handling and 401 envelopes stay in `jwtCheck` | Throws "not implemented" |
| Auth object map | `src/platform/auth-object-map.js`, used by `AuthorizationQueryService` | Same lower-case names, written inline in the coverage query as before | `auth."EducationOrganizationIdTo…DocumentId"` views, `participantDocumentId` / `studentDocumentId` projection columns; names quoted through `??` bindings |
| Data-store provider | `src/platform/data-store-provider.js`, used by `DatabaseServiceFactory` and `server.js` shutdown | `edfiAdmin`: wraps `OdsInstanceService` (external config first, then `EdFi_Admin`) | Throws "not implemented" |
| Route context | `src/config/route-context-config.js`; `buildRoutePattern` takes `parameterNames` | `ODS_CONTEXT_ROUTE_TEMPLATE`, one segment | `ROUTE_QUALIFIER_SEGMENTS`, parsed like DMS (split, trim, drop empty, reject case-insensitive duplicates) plus names that can't be Express parameters or clash with `tenantId`/`id` |
| Environment validation | `src/utils/envValidator.js` | Same checks and messages; `ROUTE_QUALIFIER_SEGMENTS` is now rejected | `CONNECTION_CONFIG`, `TENANTS_CONNECTION_CONFIG`, `ODS_INSTANCES`, `OAUTH2_PUBLIC_KEY_PEM` not required; `ODS_CONTEXT_ROUTE_TEMPLATE` rejected; startup refused until phase 3 |

`.env.example` documents `PLATFORM` and `ROUTE_QUALIFIER_SEGMENTS`.

### Left for later phases, and why

- **DMS scopes** (`dmsClaimsProfile.getScopes`): depends on the claim-set → OneRoster
  scope map (`ONEROSTER_CLAIMSET_SCOPES`). Phase 3.
- **DMS token verifier**: depends on the decision to verify self-contained CMS tokens with a custom verifier. Stock `jose` rejects
  self-contained CMS tokens (string `iat`/`exp`, empty JWKS `key_ops`), and the published
  `jwks_uri` uses the Docker-internal host. Phase 3.
- **DMS data-store provider** (CMS `/v3/dataStores`, envelope decryption, contexts,
  derivatives) and the static `DATA_STORES` override: phase 3. The decryption PoC is
  `tests/dms-spike/decrypt-connection-string.js`.
- **DMS request flow**: `extractTenantMiddleware` and `validateOdsInstanceFlow` stay ODS-only.
  The DMS flow (tenant from route + CMS binding check, data store from `dataStoreIds` and
  qualifiers) replaces both in `app.js` in phase 3. The controller and factory still use
  `req.odsInstanceId` / `req.odsCacheKey`; phase 3 can either set those or rename them.
- **Still ODS-only, adapt in phase 3/4**: health check (probes `EdFi_Admin`), discovery routes
  and Swagger server/security builders (context values from `dbo.odsinstancecontexts`, single
  context segment), the `/oauth/token` redirect.
- **Docs repo** (`ed-fi-alliance-oss.github.io`, not edited): `configuration/environment-variables.md`
  needs `PLATFORM` and `ROUTE_QUALIFIER_SEGMENTS` once DMS is usable (phase 4).

### Decisions made inside the phase

- **Gate run beside the stack, not in it.** The usual gate rebuilds the ODS stack's `edfi-oneroster`
  container from the branch. Instead the branch image ran as a second container
  (`edfi-oneroster-phase1`, `127.0.0.1:3100`) on `edfioneroster-network` with the `main`
  container's environment, so the `main` build stayed up as the parity baseline and could be
  diffed against. Container, image and env file were removed afterwards.
- **DMS variables tied to open decisions are not added yet.** `ONEROSTER_CLAIMSET_SCOPES`
  and `OAUTH2_TOKEN_PROFILE` / `OAUTH2_JWKS_URL` wait for
  those decisions. The other new DMS variables (`CONFIG_SERVICE_*`, `DATA_STORE_CACHE_SECONDS`,
  `DATA_STORES`, `USE_READ_REPLICA`, `OAUTH2_TOKEN_URL`, `OAUTH2_METADATA_URL`) arrive with the
  phase 3 code that reads them, so nothing validates a setting that does nothing.
- **No separate `static` provider yet.** Today's `ODS_INSTANCES` / tenant `OdsInstances`
  lookup stays inside the `edfiAdmin` provider (it falls back to `EdFi_Admin` per instance, and
  splitting it would change that). `DATA_STORES` for DMS comes in phase 3 with the routing that
  selects a data store.
- **`PLATFORM=dms` is refused at startup** until the DMS verifier and provider exist, rather
  than starting and failing per request.
- **`ROUTE_QUALIFIER_SEGMENTS` is rejected under `ods`** (and `ODS_CONTEXT_ROUTE_TEMPLATE` under
  `dms`). It's a new variable, so no existing ODS deployment sets it.
- **Qualifier names** follow DMS (comma split, trim, case-insensitive duplicates rejected) and
  must also be valid Express parameter names other than `tenantId` and `id`.
- **A single contact mapping is used without a `hasTable` probe** (DMS has only
  `EducationOrganizationIdToContactDocumentId`). The ODS still probes contact, then parent.

### Gate commands

Run from the worktree unless noted. Bruno and the API diff read `BASE_URL`,
`ODS_API_VIRTUAL_NAME`, `ONEROSTER_API_VIRTUAL_NAME` and the LEA/School keys from the ODS stack
env file (`edfi-oneroster/stack/pgsql/.env.5.2.0`) inside the command, never echoed.

```sh
npm ci && npm test && npm run build

# Branch image beside the main container (env copied from it; PEM newlines escaped as \n)
docker build -t edfi-oneroster:dms-v8-port-phase1 .
docker run -d --name edfi-oneroster-phase1 --network edfioneroster-network \
  --env-file <600-mode copy of the edfi-oneroster container env> -p 127.0.0.1:3100:3000 \
  edfi-oneroster:dms-v8-port-phase1

# Bruno, from tests/bruno: ci.bru for main, and ci.bru with oneRosterUrl=http://localhost:3100.
# The local stack's nginx uses a self-signed certificate; like tests/bruno/run-bruno-e2e.ps1,
# this disables TLS verification for the local test run only.
NODE_TLS_REJECT_UNAUTHORIZED=0 npx -y -p @usebruno/cli@3.2.0 bru run tests -r --env-file environments/ci.bru
```

The API diff was a scratch script (not committed): with one LEA and one School token from
the ODS/API, it paged every collection at `limit=500` on both services, fetched three items per
collection by id, ran a filter, a field selection with sort and nine error cases, and compared
status and body byte for byte, retrying after the advertised reset on 429. Phase 3's
`compare-api.js ods-vs-dms` mode replaces it.

### Gates

| Gate | Result |
| --- | --- |
| Unit tests | 28 suites, 769 tests pass: the 669 existing tests unchanged plus 100 new. Baseline before the change: 22 suites, 669 tests. |
| Bruno, ODS stack (PostgreSQL, DS 5.2, single tenant) | 53 requests, 194/194 tests pass against an image built from this branch, run beside the `main` container on the stack network. The same run against `main`: 53 requests, 194/194. |
| Byte-level API comparison, `main` vs this branch on the same ODS | 141 request pairs, 0 differences: every collection page for the LEA and School clients, three single-record lookups per collection, filter, field selection and sort, and the 400/401/403/404 paths. |
| DMS auth objects, live | The DMS-mapped auth queries built by `AuthorizationQueryService` run against the local DMS data store. Reach equals the ODS: LEA 255901 → 5 ed-orgs, 960 students, 68 staff, 1,872 contacts; school 255901107 → 1, 400, 30, 765. |
| `PLATFORM=dms` startup | Refused by `envValidator` with a clear message; `app.js` throws "Token verification for PLATFORM=dms is not implemented yet" if loaded directly. |

### Observations for later phases

- The DMS staff view (`auth."EducationOrganizationIdToStaffDocumentId"`) is a `UNION ALL` of
  assignment and employment associations, so it repeats staff (137 rows for 68 staff under the
  LEA). Harmless for `IN` filters; watch the plan cost in phase 2.
- Both platforms store self rows in the ed-org hierarchy table (9 of 19 on Grand Bend), so the
  DMS rule that an ed-org in the claim is authorized even without a hierarchy row
  only matters for an ed-org with no hierarchy row at all. Decide in phase 3 whether to
  add the direct-claim `OR`.
- `jwtVerifyWithPem` read `OAUTH2_TOKENSIGNINGALG` into a variable it never used; the PEM
  verifier drops it. Key import is still fixed to RS256, which `envValidator` enforces.
- Log component names changed for moved code: `JwtVerifyWithPem` → `JwtCheck`; the
  `odsInstances` parse warning now logs as `ClaimsProfile`; the EdFi_Admin resolution debug line
  as `DataStoreProvider`.

## Phase 2: DS 5.2 PostgreSQL artifacts on DMS (2026-10-28)

**What changed**

- `standard/5.2.0/artifacts/dms-pgsql/core/`: `00_setup.sql` and the seven projections as
  materialized views in `oneroster12`, same columns, types, `sourcedId` formulas, JSON shapes and
  indexes as `standard/5.2.0/artifacts/pgsql`, with `participantDocumentId` / `studentDocumentId`
  in place of the USIs. `orgs` came from the phase 0 spike; `users`, `enrollments` +
  `demographics`, and `academic_sessions` + `classes` + `courses` were written in parallel,
  each iterated against the parity tool until its views matched.
- `standard/dms/build-name-map.js` and `name-map.6f7cac1476c6.json`: hash-shortened tables are
  written as `{{table:Ed-Fi/<Resource>/<JSON path>}}`; the map (one entry: the SEOA
  student identification codes table) is built from the relational-model manifest.
- `standard/deploy-dms.js`: picks the artifact set from `dms."SchemaComponent"` and the name map
  from `dms."EffectiveSchema"` (refuses on no match), resolves placeholders, checks every
  referenced edfi/dms/auth object exists, applies everything in one transaction and primes the
  views; `--check` does the same and rolls back; `--only`; `--jobs-database` creates the pg-boss
  database. Uses `pg` through `db-connection.js` / `db-timeouts.js` (no timeout unless
  `DB_REQUEST_TIMEOUT` is set).
- `standard/seed-descriptors.js`: posts the six OneRoster descriptor families and the mappings
  from `seedData/*.jsonl` through the Ed-Fi API (data and token URLs from discovery; works on DMS
  and the ODS/API); one token per run; 200/201/204/409 count as success.
- `seedData/`: `raceDescriptors.jsonl` shortDescriptions shortened to the SQL seed's text (three
  were over the 75-character limit, so the API rejected them); `descriptorMappings.jsonl`
  regenerated from `02_descriptorMappings.sql` (it had been stale since the initial commit: 12
  staff classifications mapped to `"?"`, trimesters mapped to `term`, `Quarter` missing). The ODS
  is unaffected: it seeds from the SQL files.
- `tests/compare-dms-database.js` + `.sh`: database-level parity (see the report).
- `docs/design/dms-parity-report.md`.

**Gates**

| Gate | Result |
| --- | --- |
| Parity | `PARITY: 0 row/type difference(s) across 7 view(s)`; `sourcedId` sets equal after excluding ed-orgs 5/6/7. One order-only difference (LEA `children`), explained in the report. |
| `deploy-dms.js` twice, then `--check` | Clean both times (about 0.5 s); check passed. |
| DescriptorMapping vs ODS | 64 rows, identical to the ODS `edfi.descriptormapping`; 25 OneRoster descriptors on both. |
| From-scratch rebuild (wipe, reseed, seed-descriptors, deploy) | Passed. `bootstrap-local-dms.ps1 -d -v`, then the Populated reload: 151 s with cached images. Then `setup-dms-clients.sh` with fresh credentials, `docker restart ed-fi-api`, `seed-descriptors.js` (89 records, all 201), `deploy-dms.js --jobs-database oneroster_jobs` and `--check`, and the service on `stack/dms`: 43 s. Afterwards: DB parity 0 differences on all 7 views, Bruno 199/199 and `tests-dms` 20/20, `compare-api.js ods-vs-dms` the same 13 explained LEA users and nothing else. |
| `npm test`, ODS Bruno | Phase 2 adds no `src/` changes; both are rerun at the end of phase 3. |

**Decisions made inside the phase**

- `dateLastModified` on DMS is `("ContentLastModifiedAt" at time zone 'UTC')`, a
  `timestamp without time zone` like the ODS column, rather than ISO text, so
  filters and serialization behave the same on both platforms.
- Column-level validation is done by applying the artifacts in a transaction (PostgreSQL checks
  every column; a failure changes nothing) rather than by parsing SQL for column names.
- Stale mappings already posted to DMS (12 `"?"` rows and 4 trimester → `term` rows) were removed
  through a temporary `EdFiSandbox` application, then the application was deleted: `SeedLoader`
  can create mappings but not read or delete them. On DMS a mapping's identity includes
  `MappedValue`, so changing a mapping's target through the API adds a row instead of replacing it.

**Open problems**

- The from-scratch rebuild gate (above).
- `seed-descriptors.js` never deletes mappings that were dropped from `seedData/`; operators
  changing a mapping must delete the old one.
- Grand Bend doesn't exercise several branches of the views (listed in the parity report); a synthetic
  fixture on both platforms would.

## Phase 3: auth and routing on DMS (2026-10-28)

**What changed**

- Token verification (`src/platform/token-verifier.js`): `cms-self-contained` (default for DMS:
  key by `kid` with empty `key_ops`/`oth`/`x5c` dropped, `compactVerify`, exact `iss`, `aud`,
  `exp`/`nbf`/`iat` coerced with `Number()` and 60 s skew, JWKS cached and refetched on expiry or
  once on an unknown `kid`), and `standard` (`jose.jwtVerify` + `createRemoteJWKSet`, for
  Keycloak). JWKS from `OAUTH2_JWKS_URL` or the metadata's `jwks_uri`.
- Scopes: `ONEROSTER_CLAIMSET_SCOPES` (`src/config/dms-config.js`); short names expand to the
  OneRoster scope URIs; an unmapped claim set has no scopes and gets the existing 403.
- Data stores (`src/platform/dms/`): `ConfigurationServiceClient` (one cached read-only token,
  shared by concurrent callers, retry on 401), `connection-string-crypto.js` (envelope and legacy,
  tested against vectors made with .NET by `tests/unit-tests/fixtures/make-dms-connection-string-vectors.ps1`),
  a Configuration Service provider (per-tenant cache, `DATA_STORE_CACHE_SECONDS`, reload on miss,
  `USE_READ_REPLICA`) and the static `DATA_STORES` provider.
- Request flow (`src/middleware/dmsDataStoreMiddleware.js`), in place of the ODS tenant and
  instance middleware on DMS, mirroring DMS: unknown tenant 404, client not bound to the tenant
  401, no `dataStoreIds` 403, route qualifiers matched like DMS's `RouteContextMatcher`, no match
  404 after one reload, ambiguous 400, CMS failure 503 with no details.
- Auth filter: the DMS map adds the ed-orgs named in the claim to the reachable set,
  and the #133 coverage check counts them; the ODS SQL is unchanged.
- `app.js` (token URL and `/oauth/token` redirect from `OAUTH2_TOKEN_URL` on DMS), health check
  (probes the Configuration Service on DMS), `envValidator` (the DMS settings replace the phase 1
  startup refusal; `OAUTH2_ISSUERBASEURL` and `OAUTH2_TOKENSIGNINGALG` are ODS-only now).
- `standard/deploy-dms.js --from-cms` (deploys to the data stores CMS lists).
- `stack/dms/` (minimal compose on the DMS network, `.env.dms.5.2.0.example`), Bruno
  `environments/dms.bru` and `tests-dms/`, `tests/compare-api.js ods-vs-dms`
  (`tests/compare-api-ods-dms.js`).

**Tests:** 669 at baseline → 769 after phase 1 → 833 now.

**Gates**

| Gate | Result |
| --- | --- |
| Bruno against DMS, LEA and School | Main collection 54 requests, 199/199; `tests-dms` 14 requests, 20/20 (no token, malformed, tampered signature, unmapped claim set, OneRoster-Core on `/demographics`, School outside its ed-org) |
| Wrong `aud`, expired | Unit tests with real signatures (`token-verifier.test.js`); minting them live needs the CMS private key |
| `compare-api.js ods-vs-dms` | 270 requests; all differences explained (parity report: 13 LEA users from the #133 short-circuit and the TPDM coverage; one order-only array) |
| Unit tests, qualifier routing and multi-tenant with a mocked CMS | `dmsDataStoreMiddleware.test.js`, `dms-data-store-providers.test.js`, `configuration-service-client.test.js` |
| ODS: `npm test`, build, Bruno, `main`-vs-branch diff | 833 pass; build passes; Bruno 53 requests, 194/194, as on `main`; 141 request pairs, 0 differences |
| Optional live qualifier run | Done on the rebuilt stack: a temporary `schoolYear=2026` context on data store 1 (CMS `POST /v3/dataStoreContexts`) and a second instance with `ROUTE_QUALIFIER_SEGMENTS=schoolYear`: `/2026/...` 200 (4 orgs), `/2027/...` 404, unqualified 404. The context and the instance were removed afterwards. |
| Optional live multi-tenant run | Not run in phase 3: it needs CMS and DMS in multi-tenant mode with tenant-scoped data stores (`.env.multitenancy`), a larger reconfiguration. Covered by unit tests with a mocked CMS. *Run on 2026-10-29: see [Live multi-tenant run](#live-multi-tenant-run-2026-10-29).* |

**Decisions made inside the phase**

- The DMS service reaches CMS as `http://config:8081` (its network alias) and checks `iss` against
  `http://ed-fi-api-config:8081`; that host only exists in the DMS container's `extra_hosts`.
- Multi-tenant tenant validation reads `/v3/tenants`, which needs a CMS client scope that covers it
  (`edfi_admin_api/readonly_access`); set `CONFIG_SERVICE_SCOPE` accordingly.
  Untested live in phase 3; confirmed by the 2026-10-29 multi-tenant run.
- The 13-user API difference is left as is, because both platforms
  implement the same #133 logic.

**Open problems**

- Discovery and the Swagger servers list don't show DMS route qualifiers or CMS tenants yet (phase 4).
- No live multi-tenant run yet. *(Done 2026-10-29.)*
- The data-store list is cached for `DATA_STORE_CACHE_SECONDS` (600 s, as in DMS): a context added in CMS reaches a running service only on expiry or on a cache miss.

## Phase 4: stack, bootstrap, docs (2026-10-28)

### What changed

- `stack/setup-dms-clients.ps1` (replaces earlier local helper scripts): creates the `OneRoster-ReadOnly` and `OneRoster-Core` claim sets
  (no resource grants), the vendor (namespaces `uri://ed-fi.org,uri://1edtech.org`), and the
  `OneRoster LEA`, `OneRoster School`, `OneRoster LEA Core` and `OneRoster Seeder` (`SeedLoader`)
  applications on the stack's data store. It writes `stack/dms/.env.dms-clients` (credentials and
  URLs as `DMS_*` variables) and `stack/dms/.env.dms` (from the example, with the CMS read-only
  secret, the encryption key and the PostgreSQL password filled in), both owner-only. It restarts
  `ed-fi-api` after creating a claim set (DMS claim-set cache). Idempotent; `-ResetMissingCredentials`
  rotates an existing application whose credentials are missing; `-Force` rewrites `.env.dms`.
- `stack/start-dms-services.ps1`: builds the image if needed, then seeds the descriptors
  (`seed-descriptors.js --api-url http://dms:8080`, as the Seeder app), deploys the projections and
  the pg-boss database (`deploy-dms.js --from-cms --jobs-database <name from
  PG_BOSS_CONNECTION_CONFIG>`), and starts the service and waits for it to be healthy. Each step runs
  in a `docker compose run` container on the DMS network, so the host needs only Docker and pwsh.
  `-SkipSeed` and `-SkipDeploy`. `stack/stop-dms-services.ps1` (`-Purge` removes the image).
- `stack/dms/docker-compose.yml`: project name `oneroster-dms`, `ONEROSTER_IMAGE` /
  `ONEROSTER_DMS_ENV_FILE` overrides, and the hardening the stack README recommends (`appuser`,
  `cap_drop: ALL`, `no-new-privileges`). `.env.dms.5.2.0.example`: `PG_BOSS_CONNECTION_CONFIG` in
  single quotes so a `$` in the password stays literal.
- `tests/bruno/run-bruno-dms.ps1`: runs `tests` and `tests-dms` with `environments/dms.bru`, reading
  the credentials from `.env.dms-clients`. `dms.bru`'s unmapped-claim-set client is now
  `DMS_SEEDER_KEY` (the Seeder app's `SeedLoader` claim set isn't in `ONEROSTER_CLAIMSET_SCOPES`).
- `tests/compare-api.js ods-vs-dms`: `--ods-env` and `--dms-env` read the two stacks' env files
  (exported variables still win); `--known tests/dms-parity-known-differences.json` lists the 13
  explained LEA users with the reason, and the exit code is 0 when nothing is unexplained.
  `NODE_EXTRA_CA_CERTS` pointed at the ODS stack's self-signed certificate replaces
  `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- Docs: `stack/dms/README.md` (new), `stack/README.md`, `tests/README.md` ("Testing against Ed-Fi
  API v8 (DMS)"), `docs/local-development-guide.md` ("Running against Ed-Fi API v8 (DMS)"),
  `.env.example` (the stale "startup rejects dms" note replaced; every DMS variable documented,
  commented out).
- End-user docs drafts for the Ed-Fi docs site (not in this repository): `getting-started/deploy-dms.md`,
  the DMS section of `configuration/oauth-and-jwt.md` (including the token-reuse guidance for the
  15-token limit) and the DMS section of `configuration/environment-variables.md`. Linted with the
  docs repo's markdownlint config; the docs repo itself is unchanged.

**Tests:** 833 → 840 (`compare-api-ods-dms.test.js`: env-file mapping, known-difference matching).

### Pre-gate run on the existing stack

Before the wipe, the scripts ran against the stack left by phase 3, with the existing applications'
credentials copied into the new clients file: `setup-dms-clients.ps1 -Force` kept all four
applications and wrote a `.env.dms` with the same 18 settings as the phase 3 file;
`start-dms-services.ps1 -Rebuild` built, seeded 89 records, deployed 7 views and came up healthy in
46 s; `run-bruno-dms.ps1` 54 requests 199/199 and 14 requests 20/20; `compare-api.js ods-vs-dms`
with the env-file options 270 requests, the 13 known LEA users and nothing else.
One bug found and fixed: `Invoke-RestMethod` emits a JSON array as one pipeline object, so the
vendor lookup matched both vendors until the result was assigned before returning.

### Decisions made inside the phase

- **`oneroster_jobs` is created by `start-dms-services.ps1`, not `setup-dms-clients.ps1`**.
  Setup talks only to CMS; the deploy step already holds the data-store
  connection and `deploy-dms.js --jobs-database` was idempotent from phase 2. The name comes from
  `PG_BOSS_CONNECTION_CONFIG`, so the two can't drift.
- **A sibling `start-dms-services.ps1`, not `start-services.ps1 -Platform Dms`.** The ODS script is
  built around the ODS compose files, PEM keys and `EdFi_Admin` bootstrap; the DMS flow shares none
  of it, and a separate script leaves the ODS path untouched.
- **Steps run in containers, not on the host.** Seeding and deploying through `docker compose run`
  on the DMS network means the CMS connection strings (host `dms-postgresql`) and DMS discovery
  (`http://dms:8080`) work as is, and a clean machine needs no Node for the stack.
- **The CMS read-only secret is not committed.** It's the DMS stack default, so the script reads it
  from the DMS checkout's `setup-openiddict.ps1` (or `-CmsReadOnlyClientSecret`) and proves it by
  requesting one token. A dedicated OneRoster read-only client wasn't attempted: the DMS scripts
  create the read-only client by inserting it into the identity database (`setup-openiddict.ps1
  -InsertData`), and their `/connect/register` helper (`Add-CmsClient`) sets no scope.
- **Known differences live in a file, not in the comparison code.** `--known` makes "zero
  unexplained differences" a mechanical exit code, and the reason is printed with each.
- **Discovery and the Swagger servers list still don't list DMS route qualifiers or tenants.**
  Single-tenant, unqualified DMS (the documented local stack) is unaffected; moved to phase 6.
  *Wrong, found by the independent review:* discovery answered 500 on every DMS configuration,
  because it built the token URL from `OAUTH2_ISSUERBASEURL`, which DMS doesn't set. Fixed, with
  qualifiers and tenants; see "Independent review" below. The Swagger servers list is still open.

### Clean-machine gate

Run 2026-10-28 on a wiped DMS stack.

**Teardown.** `stop-dms-services.ps1 -Purge` (service and image removed), then
`bootstrap-local-dms.ps1 -d -v -EnableSwaggerUI`, which removed the four DMS containers, the
`dms-local_dms-postgresql` volume and the `.bootstrap/` workspace. Stale local client files
and cached tokens were deleted. The external `dms` network survives a
wipe; on a first run `start-local-dms.ps1` creates it.

**Run.** From a fresh clone of `d1b4bf2` (no env files, no `node_modules`), following only
`stack/dms/README.md` "Start from nothing" and `tests/README.md` "Testing against Ed-Fi API v8
(DMS)". The ODS stack runs from another checkout, so `--ods-env` and `NODE_EXTRA_CA_CERTS` point
there, as `tests/README.md` describes. The database-parity connection strings were filled from the
two stacks' env files.

| Step | Time | Result |
| --- | --- | --- |
| 1. `bootstrap-local-dms.ps1 -LoadSeedData -SeedTemplate Populated -EnableSwaggerUI` | 157 s | Exit 0; Grand Bend loaded, 104,735 records created, none rejected |
| 2. `setup-dms-clients.ps1 -DmsComposeDir …` | 16 s | Created both claim sets, the vendor and the four applications; wrote both env files (mode 600, git-ignored); restarted `ed-fi-api` |
| 3. `start-dms-services.ps1 -Rebuild` | 64 s | Image built; 89 records seeded (64 mappings); 7 views deployed (academicsessions 7, classes 532, courses 84, demographics 960, enrollments 13,968, orgs 4, users 2,901); `oneroster_jobs` created; healthy |
| 4. `npm ci` | 9 s | Done |
| 5. `run-bruno-dms.ps1` | 11 s | 54 requests, 199/199; 14 requests, 20/20 |
| 6. `compare-dms-database.sh` | 17 s | `PARITY: 0 row/type difference(s) across 7 view(s)` |
| 7. `compare-api.js ods-vs-dms --ods-env … --dms-env … --known …` | 65 s, after a 45 s pause for the rate limit | 270 requests; 13 differences, 13 known, 0 unexplained; exit 0 |

**Elapsed:** 4 min 17 s from the start of the DMS bootstrap to green Bruno; 6 min 24 s to the end
of the API comparison, pause included. The teardown isn't counted. Docker already had the DMS images
and the build cache for the OneRoster image, and npm had its package cache, so a first run on a new
machine also pays the image pulls and builds.

**Afterwards.** The worktree's `stack/dms/.env.dms-clients` was replaced with the new credentials.
Its `.env.dms` was byte-identical to the clone's, because the read-only secret, the encryption key
and the PostgreSQL password survive a wipe. The service was restarted from the worktree, and a
cached LEA token read `/orgs` (200).

No step needed anything the docs don't say, and no new DMS issues turned up.


## Independent review of phases 1–4 (2026-10-28)

An independent review covered `db379e0..d1b4bf2`, so it
predates the clean-machine gate. Each finding was checked against the code and, where
it cites them, the pinned DMS and CMS sources before it was fixed. All eight were real.

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| 1 | With `USE_READ_REPLICA`, the materialized-view refresh ran on the replica, which can't refresh | The DMS provider gains `resolveRefreshConnectionString` (the primary when queries use a replica). `DatabaseServiceFactory` registers the replica pool as query-only and a separate primary pool for the refresh (`knexManager.createOdsInstance(..., { refresh: false })`) | `database-service-factory.test.js`, `knex-factory-ods-instances.test.js`, provider tests |
| 2 | Discovery answered 500 on DMS (`OAUTH2_ISSUERBASEURL` undefined) | DMS discovery uses `getDmsTokenUrl()` (shared with `app.js`) and the DMS route shape: `/`, `/{tenant}`, then each leading run of `ROUTE_QUALIFIER_SEGMENTS`, values from the request or `{placeholders}`, unknown tenant 404, CMS failure 503. The ODS discovery code is unchanged | `discovery-dms-http.test.js`: the real router over HTTP with `stack/dms/.env.dms.5.2.0.example`; 8 of its 11 tests fail on the old controller. Live: `GET /` 200 |
| 3 | Multi-tenant health check read `/v3/dataStores` without a `Tenant` header (CMS 400, so 503) | Multi-tenant health reads `/v3/tenants` (tenant-agnostic in `TenantResolutionMiddleware`, and needed for tenant validation anyway); a CMS without `/v3/tenants` fails it | provider tests |
| 4 | Each late 401 for an old CMS token discarded the replacement (20 concurrent requests cost 21 tokens) | `invalidateToken(token)` drops the token only while it is still the cached one | `configuration-service-client.test.js`: 2 tokens; 21 on the old client |
| 5 | A connection changed in CMS never reached a service already built | Each data store carries a `connectionVersion` (SHA-256 prefix of its stored connection strings). The middleware passes it on; the factory replaces a service built from another version and retires its pools (out of the cache and the refresh list at once, destroyed after 30 s so requests holding them finish) | factory and Knex tests, middleware test |
| 6 | Both parity tools hid repeated `sourcedId`s; the database tool also passed one-sided columns | `compareCollection` (API) reports `duplicate on ODS/DMS`. `compareRows` takes the columns from the catalog (so empty views are checked), and `unexplainedCount` counts duplicates and one-sided columns | `compare-api-ods-dms.test.js` (including the whole runner with fake services: duplicate → exit 1), new `compare-dms-database.test.js` |
| 7 | Rerunning setup kept applications whose claim set, ed-org or data store had drifted | Claim set and ed-org are put back with `PUT /v3/applications/{id}`, and the change is printed. A data-store mismatch stops the script before it creates, updates or writes anything (CMS binds data stores per API client, which the script doesn't manage) | Live: a plain rerun kept all four and left both env files byte-identical. `OneRoster LEA Core` moved to `OneRoster-ReadOnly` / 255901107 in CMS was put back. With a temporary second data store, `-DataStoreId 2` stopped on the first application and wrote nothing; that data store was deleted |
| 8 | `stop-dms-services.ps1` reported success when Docker failed | Checks `$LASTEXITCODE` and throws. The audit found one more unchecked call, `docker restart` in setup, now checked too | Live: a `docker` stub exiting 42 makes the script exit 1 with the reason; the real container was untouched |

**Recommendations**

- *Clean phase 4 rebuild from the published instructions:* done before the review arrived. Since then setup only gained checks on applications that already exist, which a
  clean stack doesn't have, and stop gained an exit-code check. Both were rerun on the live stack
  (above) instead of wiping again.
- *13 extra LEA users:* now stated in the parity report as an explicit decision about
  authorization semantics.
- *`deploy-dms --check`:* its help and the docs draft now say what it does: the full
  deployment in a transaction that is rolled back, with deploy privileges, and with readers of
  existing views waiting until it finishes.
- *Committed synthetic SQL fixtures:* done on 2026-10-29; see "Synthetic fixture" below.
- *Network timeouts, secrets provider, CI, SQL Server, DS 6.1:* phases 5 and 6, as the review
  says. The Swagger servers list still shows only the base URL on DMS with qualifiers or tenants
  (phase 6).
- *ODS path:* unchanged. `DatabaseServiceFactory` and the controller pass no connection version on
  the ODS, so the ODS still never rebuilds a service when `EdFi_Admin` changes. That's the existing
  ODS behavior, left as it is.

**Gates**

| Gate | Result |
| --- | --- |
| Unit tests | 37 suites, 882 tests (840 before) |
| Build check | 49 files |
| DMS, rebuilt image | `GET /` 200 with `oauth` = `OAUTH2_TOKEN_URL`; health 200; Bruno 54 requests 199/199 and 14 requests 20/20; database parity 0 differences on 7 views, with the duplicate and catalog-column rules; `compare-api.js ods-vs-dms` 270 requests, 13 known, 0 unexplained, 0 duplicates |
| ODS, branch image beside `main` | Bruno 53 requests 194/194 (as on `main`); byte-level comparison 141 request pairs, 0 differences; discovery and `/swagger.json` byte-identical to `main` when requested with nginx's forwarded headers |

### Synthetic fixture (2026-10-29)

**Decision.** Three options were considered: (A) load the fixture into both live databases
inside rolled-back transactions and compare; (B) DMS only, against values worked out by hand from
the ODS SQL; (C) post it through both APIs and keep it. A was chosen. It writes to the ODS
database, but only for the length of a transaction.

**What was added**

- `tests/dms-parity-fixture.js`: the data, described once by natural key; `toOdsRows` and
  `toDmsRows` write it to each platform's tables; `EXPECTATIONS` and `EXPECTED_COUNTS`, written
  from the ODS SQL.
- `tests/compare-dms-fixture.js` and `.sh`: one REPEATABLE READ transaction per database, rolled
  back, with `session_replication_role = replica`. It runs each projection's definition before and
  after the load, then compares the added rows ODS against DMS with `compareRows`, including
  `dateLastModified`, and checks the expectations on both. It fails if a load changes an existing
  projection row, if a sequence moves, or if fixture rows remain. The `.sh` wrapper reuses
  `compare-dms-database.sh` through a new `COMPARE_SCRIPT` variable.
- `compareRows` takes an `ignored` column set (default unchanged), and `connect` and
  `PERSON_KEY_COLUMNS` are exported.
- Tests: `dms-parity-fixture.test.js` checks that the writers fill the same tables and that every
  DMS `*_DocumentId` names a row of the referenced resource. It also checks that staff school
  associations get the same order on both platforms, and that every descriptor is listed.
  `compare-dms-fixture.test.js` covers the delta, the expectations, table resolution and the
  sequence check. One more `compare-dms-database` test covers the `ignored` option.

**Why the views' SQL and not a refresh.** Running `pg_get_viewdef` inside the transaction sees the
uncommitted rows without refreshing or locking `oneroster12`. So the running ODS service never
waits, and the deployed definitions are exactly what gets tested. The ODS transaction holds
row-exclusive locks on the fixture tables for about a second.

**Results**

| Check | Result |
| --- | --- |
| Fixture parity | 7 views, 60 rows on each side, all identical (order-only: one `children`, six `roles`) |
| Expectations | 56/56 on the ODS, 56/56 on DMS |
| Existing rows changed by the load | 0 on each |
| Sequences moved | none on either |
| Fixture rows after rollback | 0 on each; ODS `users` 3,900 and `orgs` 7, DMS 2,901 and 4, as before |
| Deliberate breaks (DMS-only e-mail, ODS-only timestamp, assignment removed on both, school under the Grand Bend LEA) | each detected; exit 1 |
| Unit tests | 39 suites, 900 tests |
| Build check | 49 files |

Every `uri://ed-fi.org` descriptor the fixture uses already exists on both platforms. The run adds
the fixture's 5 unmapped-namespace descriptors inside the transaction. The DMS rows met DMS's
all-or-none reference checks on the first run.

**Not covered.** Ties in staff primary-org ranking (the platforms rank by different keys, decision
9); how each API would store the same resources (the rows bypass both APIs); SQL Server and DS 6.1
(phase 5).

The ODS stack's service env sets `API_BASE_PATH=''` literally. Behind nginx it never shows,
because `X-Forwarded-Prefix` wins; a direct request to a container with that env gets `/''/` in
its discovery URLs. That comes from the ODS stack's env, not from this branch.

## Phase 5: SQL Server and DS 6.1 (2026-10-29)

**Scope.** `dms-mssql`
artifacts for DS 5.2 with the `Server=host,port` parser extension; DMS on SQL Server, compared with
DMS on PostgreSQL through `compare-api.js`; then DS 6.1 on both engines.

**DMS version.** The intent was to re-baseline on the 8.1.0 GA tag before phase 5. There is no GA
tag yet (`git ls-remote` shows `dms-pre-8.1.0-beta2.4` and `beta2.5` after the pinned `beta2.3`),
so the pin stays.

**Setup.** For DS 6.1, with tar backups first: reprovisioning the DMS volumes
(PostgreSQL DS 5.2 volume backed up, DS 6.1 run on both engines, DS 5.2 restored after) and
replacing the ODS volumes for an ODS DS 6.1 stack (both volumes and the 5.2 env file backed up,
ODS 5.2 restored after). The DMS PostgreSQL volume was backed up while it was stopped (48 MB).

### SQL Server, DS 5.2

**What changed**

- `standard/5.2.0/artifacts/dms-mssql/`: the seven projections as tables filled by
  `oneroster12.sp_refresh_<table>` (staging table, then truncate-and-insert), the ODS master
  procedure `sp_refresh_all`, and a SQL Server Agent job. Same columns and JSON shapes as
  `standard/5.2.0/artifacts/mssql`, the logic of `dms-pgsql`. DMS names are bracketed
  (`edfi.[School]`), ids are BIGINT, person keys are `participantDocumentId` / `studentDocumentId`.
  `name-map.6f7cac1476c6.json` maps the one placeholder to its SQL Server name, which isn't
  shortened (`StudentEducationOrganizationAssociationStudentIdentificationCode`).
- `standard/deploy-dms.js`: `--db-type mssql` (or `DB_TYPE`). The engine decides the artifact
  directory, the quoting of resolved placeholders and the reference check. On SQL Server it splits
  files on `GO`, runs everything in one transaction with `sp_refresh_all @ForceRefresh = 1` (or the
  single `sp_refresh_<table>` with `--only`), counts the rows, then commits or, with `--check`,
  rolls back. It warns when SQL Server Agent isn't running. The PostgreSQL path is unchanged,
  except that its two parameterized catalog queries now inline values checked first (a 64-hex
  hash and an escaped database name).
- `parseConnectionString` reads the port from `Server=[tcp:]host,port`, the form Ed-Fi API v8
  writes (`Server=dms-mssql,1433`); an explicit `port=` wins. Without it the deploy can't connect.
- `setup-dms-clients.ps1` takes `-DatabaseEngine mssql` (service env from the new
  `.env.dms.5.2.0.mssql.example`: `DB_TYPE=mssql`, no pg-boss, no database password) and
  `-ClientsFile` / `-EnvFile`, so each engine's stack keeps its own files.
  `start-dms-services.ps1` skips the pg-boss database when `DB_TYPE=mssql`.
- `tests/compare-api.js` gains `dms-record` and `dms-vs-recording`. The two DMS stacks share
  container names, so they can't run together: the PostgreSQL side is recorded (every response
  the comparison uses, no credentials, mode 600), then the SQL Server side is compared with the
  recording. `compare-api-ods-dms.js` now collects each side's responses and compares them
  afterwards; `ods-vs-dms` gives the same result as before (270 requests, the same 13 known
  differences, 0 unexplained).
- Tests: `deploy-dms.test.js` (placeholder quoting, reference and projection patterns, `GO`
  splitting, and for each committed artifact set: seven projections, a name map for its engine
  covering every placeholder, DMS names only in quoted form); record/replay and
  `compareResponses` tests; `Server=host,port` parser tests.

**How the projections were written.** As in phase 2: `orgs` by hand as the worked example, then
the rest in three parallel streams (academic sessions, courses and classes; users; enrollments and demographics),
each iterating against a comparison of its SQL Server table with a JSON dump of the DMS PostgreSQL
view taken before the switch. That comparison was a scratch tool (it ignores `dateLastModified`
and person keys, like `compare-dms-database.js`); the API comparison below is the gate.

**Deliberate differences from the ODS SQL Server files**

- `courses`: the DS 5.2 ODS file hashes `CAST(CourseCode AS VARCHAR(50))`, but CourseCode is 60
  characters, so codes of 51–60 characters get a different sourcedId from PostgreSQL. Hashed
  uncut here (DS 6.1 fixes the ODS file the same way).
- `academicsessions`: the DS 5.2 ODS file picks the modal first and last school day with
  `ORDER BY COUNT(*) DESC` and no tie-break, so the result depends on the query plan. Ties go to the
  earliest day here, as PostgreSQL `mode()` does (DS 6.1 fixes the ODS file the same way).
- `users`: where the ODS SQL Server file's logic differs from the ODS PostgreSQL file, the port
  follows PostgreSQL (see below). Hand-built JSON text is escaped with `STRING_ESCAPE`.
- `00_setup.sql` keeps the refresh logs across deployments (the ODS script drops them) and allows
  `'Partial Success'`, which `sp_refresh_all` writes (the DS 5.2 ODS constraint leaves it out).
- The Agent job is named after the database (`OneRoster 1.2 Refresh (<database>)`), so data stores
  on one server keep one job each, and the deploy doesn't start it.

**Gate results**

| Gate | Result |
| --- | --- |
| DMS on SQL Server, Grand Bend | `bootstrap-local-dms.ps1 -DatabaseEngine mssql -LoadSeedData -SeedTemplate Populated -EnableSwaggerUI`: 14 min 8 s (the SQL Server image runs under amd64 emulation on this arm64 Mac), 104,736 records created, no errors |
| Clients, descriptors | `setup-dms-clients.ps1 -DatabaseEngine mssql` with separate files; `seed-descriptors.js` 89 records, all 201 |
| Full deploy through CMS (`start-dms-services.ps1`, in a container on the DMS network) | 7 tables, `sp_refresh_all` 3.1 s, Agent job created; CMS holds `Server=dms-mssql,1433`, parsed to host and port |
| Tables against the DMS PostgreSQL views | 7/7 identical: orgs 4, academicsessions 7, courses 84, classes 532, users 2,901, enrollments 13,968, demographics 960 (one order-only `children` array) |
| `compare-api.js dms-vs-recording` against the PostgreSQL recording | 135 requests: 24 collections for the LEA and School clients, 3 single items each, the error cases and the roster-core case; 0 differences, every collection in the same order |
| Agent job | Scheduled daily at 02:00 in the data store's database; started by hand, it ran and succeeded (it skipped the refresh, because `sp_refresh_all` skips one within 10 minutes of the last) |
| Bruno (`run-bruno-dms.ps1 -ClientsFile stack/dms/.env.dms-clients.mssql`) | Main collection 54 requests, 199/199; `tests-dms` 14 requests, 20/20, as on PostgreSQL. (A rerun straight after the first hit the service's 100-requests-per-minute limit; the run after a minute's pause passed.) |
| Recording replayed against PostgreSQL itself, before the switch | 0 differences |

**What the ODS SQL Server files do differently from the ODS PostgreSQL files** (found while
porting; Grand Bend reaches none of it, and the ODS PostgreSQL/SQL Server parity check can't see
it). For the bug drafts:

- `users.sql`:
  - a student's primary school is the flagged or most recent enrollment, not PrimarySchool, then
    entry date, then school id;
  - staff roles carry one classification per person, not each school's own;
  - duplicate descriptor mappings collapse to the lowest value instead of fanning out;
  - staff contact-association e-mail addresses are left out;
  - a student with no enrollment gets `grades` NULL where PostgreSQL gives `[null]`;
  - JSON is built by concatenation without escaping, so a `"` or `\` in a value breaks it.
- `academic_sessions.sql`: schools with no LEA get NULL start and end dates (the mode subquery
  matches on a NULL LEA id); PostgreSQL computes them. Class period names aren't escaped in
  `classes.periods`.
- The md5 idiom hashes `VARCHAR` (code page 1252) where PostgreSQL hashes UTF-8, so any non-ASCII
  natural key gets a different sourcedId on each engine. Kept here for parity with the ODS.
- `demographics`: `countryOfBirthCode` and `stateOfBirthAbbreviation` are NVARCHAR(8) and `sex`
  NVARCHAR(32), but descriptor values can be 50 characters; a longer custom value fails the whole
  refresh. Kept here.
- On SQL Server the DMS text keys use a case-insensitive collation, so descriptor-mapping joins and
  the `'Work'` / `'Home/Personal'` checks ignore case, where PostgreSQL doesn't. The ODS pair
  behaves the same.

Two PostgreSQL-side oddities the users port surfaced, in both the ODS and DMS files: a student with
no enrollment gets `grades: [null]`, and a staff member who teaches but has no mapped
classification gets `role: "teacher"` while their school's entry in `roles` has `"role": null`
(DS 6.1 fixes the second).

**DMS issue.** The SQL Server database DMS's own bootstrap creates has `READ_COMMITTED_SNAPSHOT`
off, and DMS's provisioning warns that it "strongly recommends" enabling it.


### DS 6.1

**What changed**

- `standard/6.1.0/artifacts/dms-pgsql` and `dms-mssql`: the DS 5.2 DMS sets with the changes the
  ODS DS 6.1 files make (`docs/design/data-standard-6.1-support.md`), in DMS names:
  - `demographics`: ethnicity and race from `StudentDemographic` / `StudentDemographicRace`
    (DS 6.1 moved them off `StudentEducationOrganizationAssociation`).
  - `users`: student identification codes from the `StudentIdentificationCode` resource;
    student and staff e-mail from the `electronicMails` collections of `StudentDirectory` and
    `StaffDirectory`, keyed by education organization (`StaffDirectory` replaces both
    `StaffElectronicMail` and `StaffEducationOrganizationContactAssociation`); staff identifiers
    and e-mail resolved per school with a person-level fallback; one staff role per school,
    preferring a mapped classification; ordered roles arrays.
  - `orgs`: ordered `children`. `courses` (SQL Server): `courseCode` widened to 120 with
    CourseCode.
  - The other views are unchanged. No DS 6.1 table the projections read is hash-shortened, so
    both name maps (`name-map.d7662d02379c.json`) are empty.
- DS 6.1 DDL and manifests emitted with `api-schema-tools ddl emit` from
  `EdFi.DataStandard61.ApiSchema` 1.0.335 (the package the bootstrap stages), into a
  local directory. Before any store existed, every table and column the
  PostgreSQL set names was checked against that DDL.

**Runs.** With the backups above: the DMS PostgreSQL DS 5.2 volume (backed up) and the SQL
Server volume were wiped in turn; the ODS stack was stopped, both its volumes and the 5.2 env file
backed up, the volumes removed (`-Purge` would also have removed the images), and the ODS DS 6.1
stack started from `pgsql/.env.6.1.0` (the 5.2 env file with the 6.1 example's image tags,
`TPDM_ENABLED=false` and `ONEROSTER_ARTIFACT_VERSION=6.1.0`). The macOS `init-databases.sh`
problem recurred on the fresh volume (`docker exec db-ods bash
/docker-entrypoint-initdb.d/z-init-databases.sh`, then `-InitializeOneRosterViews`), and so did the
OneRoster cron failing on a cold start (`docker restart edfi-oneroster`). Both are known ODS
stack issues. The DMS DS 6.1 stacks used separate client and env files (`.env.dms-clients.ds61`,
`.env.dms.ds61`), so the DS 5.2 ones stay valid for the restore.

**Gate results (PostgreSQL)**

| Gate | Result |
| --- | --- |
| DS 6.1 Populated seed through the API | Loads: 168,038 records created, no errors; bootstrap about 4 minutes |
| Deploy through CMS (`start-dms-services.ps1`) | 7 views, 30 referenced objects checked, `oneroster_jobs` created |
| `compare-dms-database.sh --exclude-edorgs ''` against ODS DS 6.1 | 0 differences on 7 views (orgs 10, academicsessions 13, courses 400, classes 1,954, users 5,377, enrollments 16,446, demographics 2,958); no order-only arrays |
| `compare-api.js ods-vs-dms --exclude-edorgs ''` | 300 requests, 0 differences, same order everywhere, no known differences used |
| Bruno | 67 requests, 264/264; `tests-dms` 14 requests, 20/20 |

Both DS 6.1 samples hold the same education organizations, including six TPDM schools (5, 6, 7,
50, 60, 70), so nothing was excluded, and the 13 LEA users of DS 5.2 (bug draft 9) don't appear:
the LEA reaches every served org on neither platform. The DMS PostgreSQL DS 6.1 views and API
were recorded for the SQL Server run.

**Gate results (SQL Server)**

The SQL Server `users` file was written from the DS 5.2 SQL Server file with the same changes as
the PostgreSQL one; the other files needed only the documented ones. The set deployed and matched on
its first run.

| Gate | Result |
| --- | --- |
| DMS on SQL Server, DS 6.1 Populated seed | `bootstrap-local-dms.ps1 -DatabaseEngine mssql -DataStandardVersion 6.1 -LoadSeedData -SeedTemplate Populated`: about 10 minutes, 168,058 created responses, no errors (20 more 201s logged than on PostgreSQL; the stores' row counts and contents match) |
| Deploy through CMS | 7 tables, `sp_refresh_all` 4.8 s, Agent job created and Agent running. The first attempt stopped with "No name map for effective schema d7662d02379c…" because the image predated the map; `-Rebuild` fixed it, and the refusal is the intended behavior |
| Tables against the DMS PostgreSQL DS 6.1 views | 7/7 identical, same counts as above, no order-only arrays |
| `compare-api.js ods-vs-dms --exclude-edorgs ''` against ODS DS 6.1 (both stacks live) | 300 requests, 0 differences, same order everywhere |
| `compare-api.js dms-vs-recording` against the PostgreSQL DS 6.1 recording | 150 requests, 0 differences |
| Bruno | 67 requests, 264/264; `tests-dms` 14 requests, 20/20 |

**Combinations.** All four were run: PostgreSQL and SQL Server, each on DS 5.2 and DS 6.1. On
DS 5.2, SQL Server was compared with DMS PostgreSQL, which was compared with the ODS in phases 2–4.
On DS 6.1, both engines were compared with the ODS directly. Not run: the synthetic fixture on
SQL Server or on DS 6.1 (its loader writes the DS 5.2 PostgreSQL tables); the ODS on SQL Server;
multi-tenant DMS on SQL Server.

### Restore to DS 5.2

Both DS 5.2 stacks were put back from the backups, and the DS 5.2 gates were run again.

- **DMS.** The SQL Server stack was stopped; its volume, now holding the DS 6.1 store, is kept. The
  `.bootstrap/` workspace (DS 6.1 after the last run) was replaced by restaging DS 5.2 with the
  DMS repo's own scripts: `prepare-dms-schema.ps1 -EnvironmentFile <.env plus .env.bootstrap.ds52>`
  and `prepare-dms-claims.ps1`. The staged manifest came out byte-identical to the one saved before
  the switch: effective schema `6f7cac14…`, the same workspace and claims fingerprints. The saved
  `.env.derived` was put back. The PostgreSQL volume was recreated with its compose labels and
  untarred from the backup, and `start-local-dms.ps1 -EnableSwaggerUI` started DMS on it: Ed-Fi
  5.2.0 + TPDM 1.1.0, 2,901 users, 4 orgs and 13,968 enrollments, as before. The DS 5.2 client
  files were unchanged, and their credentials work again because CMS came back with the volume.
  `start-dms-services.ps1 -Rebuild -SkipSeed` redeployed through the new `deploy-dms.js`, which
  exercised its PostgreSQL path on DS 5.2.
- **ODS.** The DS 6.1 stack was stopped, the two volumes were recreated with their compose labels
  and untarred, and `start-services.ps1 -EnvFile pgsql/.env.5.2.0` (env file unchanged) started
  it: 3,900 users, 7 orgs, 13,968 enrollments and the TPDM schema, as before; no cron failure. The
  DS 6.1 env file `pgsql/.env.6.1.0` stays in the ODS checkout (git-ignored, mode 600).

| Gate, after the restore | Result |
| --- | --- |
| `compare-dms-database.sh` | 0 differences on 7 views, the same counts and exclusions as phase 4 |
| `compare-dms-fixture.sh` | 56/56 expectations on each platform; no existing row changed, no sequence moved, no fixture rows left |
| `compare-api.js ods-vs-dms --known …` | 270 requests; the same 13 known LEA users, 0 unexplained, every collection in the same order |
| Bruno | 54 requests, 199/199; `tests-dms` 14 requests, 20/20 |

## Phase 6: hardening and upstream (2026-10-29)

**Scope.** Refresh skip-when-unchanged, a security pass on the CMS credentials and key, vendor
token guidance and CI, plus what earlier phases deferred to it: network timeouts and the Swagger servers
list for DMS qualifiers and tenants.

### Refresh only when the sources changed (PostgreSQL)

- `deploy-dms.js` generates, alongside the views, `oneroster12.source_version(view)` and
  `oneroster12.refresh_state`. A view's sources are the resource tables it reads. A collection table
  counts as its resource: the longest versioned table it starts with whose `<Resource>_DocumentId`
  it carries, because DMS restamps the resource when a collection row changes. The version is the
  highest `"ContentVersion"` (inserts, updates) and `tracked_changes_<schema>.<resource>."ChangeVersion"`
  (deletes), all from `dms."ChangeVersionSequence"`, and every one of those columns is indexed.
  Redeployed views lose their state, so the next run rebuilds them.
- `src/services/viewRefresh.js` (used by the pg-boss job): on DMS with tracking, reads the version
  and refreshes in one REPEATABLE READ transaction and records the version. If any write was in
  flight (`txid_snapshot_xip`), the state is marked incomplete and the next run refreshes regardless,
  because a sequence value taken by an open transaction can commit below the recorded one. So
  skipping never misses a change; under constant writes it degrades to refreshing every time, as
  before. On the ODS/API, or without tracking, it is the old plain `REFRESH`.
- SQL Server is unchanged: the Agent job refreshes daily and `sp_refresh_all` already skips a
  refresh within 10 minutes of the last.

| Check (DMS PostgreSQL, DS 5.2, service stopped so its cron couldn't interfere) | Result |
| --- | --- |
| Deploy | 7 views, 21 source resources tracked |
| First pass of `refreshView` over the 7 views | 7 refreshed (no state yet), each complete |
| Second pass | 7 skipped; 3–37 ms each, against 11–290 ms for a refresh |
| Descriptor created through the API (OneRoster Seeder) | the 4 views that read `dms."Descriptor"` refreshed (academicsessions, users, enrollments, demographics); orgs, courses, classes skipped |
| The same descriptor deleted through the API (short-lived EdFiSandbox application, deleted after) | the same 4 refreshed, through `tracked_changes_edfi."Descriptor"`; the descriptor and the application are gone |
| Service restarted, first request (its immediate refresh of all 7 through pg-boss) | 7 jobs completed, `refresh_state` unchanged: all skipped |
| Database parity afterwards | 0 differences |

### Security pass: Configuration Service credentials and key

Reviewed: `configuration-service-client.js`, `connection-string-crypto.js`, the data-store
providers, the token verifiers, `deploy-dms.js --from-cms` and the setup scripts. Neither secret is
logged, errors carry status codes and never credentials or connection strings, the client caches
one token, and setup writes the secrets to mode-600 files. Changes:

- **Secrets plugin on DMS.** `APP_SECRETS_MODULE` required the two ODS secrets, so it was unusable
  with `PLATFORM=dms`. With `PLATFORM=dms` it now sets any of `CONFIG_SERVICE_CLIENT_SECRET`,
  `CONFIG_SERVICE_ENCRYPTION_KEY`, `DATA_STORES` and `PG_BOSS_CONNECTION_CONFIG` (at least one), and
  logs the names it set, never the values; startup validation then checks the combination. The ODS
  contract is unchanged. The example file plugin and `docs/app-secrets-plugin.md` cover both.
- **Static `DATA_STORES` needs no key.** Confirmed: plain connection strings are used as they are,
  and the validator asks for `CONFIG_SERVICE_ENCRYPTION_KEY` only when an entry is encrypted. Now
  tested on the provider side too.
- **Network timeouts** (from the review). No outbound call had one, so a hung Configuration
  Service held every request waiting on a data-store lookup. `DMS_HTTP_TIMEOUT_MS` (default
  10,000) now bounds each CMS request (a timeout is a `ConfigurationServiceError` 504, which the
  middleware answers as 503) and the OIDC metadata and JWKS requests (a timeout fails the token
  check; the standard profile passes it to `jose` as `timeoutDuration`).
- **Plain-http warnings.** Startup warns when `CONFIG_SERVICE_URL` (unless `DATA_STORES` is used),
  `OAUTH2_JWKS_URL` or `OAUTH2_METADATA_URL` is http to a host other than localhost: the client
  secret and connection strings, or the signing keys, would cross the network in clear (a
  substituted JWKS would let anyone forge tokens). Warnings, not errors, because the local stack's
  private Docker network uses http.

### Swagger servers on DMS

`buildSwaggerServers` used the ODS context template and tenant config, so on DMS it always showed
the base URL. On DMS it now lists the route prefixes requests can use: the tenant (multi-tenant,
from `/v3/tenants`), then the `ROUTE_QUALIFIER_SEGMENTS` values of each data store whose contexts
have exactly those keys, the same rule `dmsDataStoreMiddleware` matches on. The labels are the ODS
ones ("Tenant Selection", "Context Selection", "Tenant/Context Selection"). The providers gained
`listTenants()`. Single-tenant without qualifiers, and any Configuration Service error, give the
base URL as before. Like the ODS servers list, it shows tenant names to whoever can read
`/swagger.json`.

### Vendor guidance, CI, drafts

- End-user docs drafts (not in this repository): the token-reuse section is now vendor
  guidance on the 15-active-token limit (reuse until expiry, one token per client across a
  deployment, single-flight renewal, 429 means wait, 401 means renew once, a client per integration
  and environment, no token endpoint health checks). The deploy page covers SQL Server, DS 6.1 and
  the change-tracked refresh; the variables page has `DMS_HTTP_TIMEOUT_MS`, the http warnings and
  the DMS secrets plugin fields. The docs repo's markdownlint reports only the expected MD041 on the
  two section files.
- `.github/workflows/dms-e2e.yml`: on pull requests that touch the DMS paths, and on dispatch. It
  runs a matrix of PostgreSQL and SQL Server × DS 5.2 and 6.1:
  - `bootstrap-published-dms.ps1` with the Populated seed (Data-Management-Service checked out at
    `dms-pre-8.1.0-beta2.3`, images `DMS_IMAGE_TAG`, default `pre`);
  - SQL Server Agent enabled for SQL Server;
  - `setup-dms-clients.ps1` (`-DmsContainer dms-published-dms-1`: the published compose file has no
    fixed container name), `start-dms-services.ps1 -Rebuild`, and `run-bruno-dms.ps1`;
  - teardown always runs.

  `actionlint` is clean. **Unverified: it has never run.** Open points for its first run: whether
  the `pre` images match the `beta2.3` scripts (pin `DMS_IMAGE_TAG` to a matching tag if not), and
  the run time of the SQL Server legs.
- Separately, and not in this repository: a proposal for Ed-Fi API 8.2 (OneRoster resource claims
  emitted as an `onerosterScopes` claim, because DMS reads `scope` as the claim-set name;
  standards-conforming tokens and JWKS; released manifests, a post-provision hook and change
  versions as a contract; a companion CMS scope; plugin hosting; sample data; the local stack), and
  the DMS issues found along the way, with repro steps.

### Gates

| Gate | Result |
| --- | --- |
| Unit tests | 44 suites, 956 tests (924 at the end of phase 5) |
| Build check | 50 files |
| ODS regression: image from this branch beside the ODS stack's `main` container | Bruno 53 requests, 194/194 on both; API byte diff 141 pairs, 0 differences; discovery and `/swagger.json` identical |
| DMS PostgreSQL DS 5.2, rebuilt image | Deploy with tracking; Bruno 54 requests 199/199 and 14 requests 20/20; `compare-api.js ods-vs-dms` 270 requests, the same 13 known, 0 unexplained; startup logs the two http warnings (the local stack's Docker network) and nothing else |


## Second independent review: remediation and phases 5–6 (2026-10-29)

A second independent review covered `d1b4bf2..be89c08`. It closed six of the first review's eight findings,
kept 5 and 6 partly open, and found five more. Each was checked against the code and the pinned
DMS/CMS source before it was fixed, and F1 and F2 were reproduced first. All five were real. F4 and
F5 matter less than the review's P2 rating: F4 needs a `/`, `?`, `#` or `%` in a tenant or context
value.

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| F1 | A data store whose first connection check failed kept its pool: the factory replaced pools only when a service had been built, and `knexManager` returns a cached pool whatever the connection string, so a connection corrected in CMS never took effect | `DatabaseServiceFactory` records the connection version when it creates the pools, before the check, and retires pools built from another version whether or not a service exists. The ODS path passes no version and is unchanged | `database-service-factory-recovery.test.js` with the real Knex cache: failed first connection then corrected; working, bad rotation, corrected; the separate refresh pool; a retry with the same version reuses the pool. 3 of its 4 tests fail on the old factory |
| F2 | `compare-dms-database.js` passed a view missing `dateLastModified`: the column-presence check reused the list of columns whose values are ignored | Separate `schemaIgnored` (the person keys only) from `ignored` (values) | `compare-dms-database.test.js`: missing timestamp, populated and empty; person keys allowed one-sided |
| F3 | `deploy-dms.js --from-cms` didn't load `APP_SECRETS_MODULE`, so secrets kept only in the plugin started the service but couldn't deploy | The deploy script loads the plugin before reading the CMS settings, always as `PLATFORM=dms` (`bootstrapAppSecretsIfNeeded({ dms: true })`), since an operator may run it without `PLATFORM` | `deploy-dms-cli.test.js` runs the CLI as a process with only the plugin holding the secret: it reaches the CMS call; without the fix it stops with "needs baseUrl, clientId and clientSecret" |
| F4 | Swagger server choices joined raw tenant and context values, so `/`, `?` or `#` changed the URL | Each segment is percent-encoded; Express decodes it back into the route parameter. The ODS builder has the same raw join on `main`, left alone (ODS behavior) | `swaggerServerBuilder-dms.test.js`: encoded choices, and a request through Express with `North#1` / `2026/2027` arrives as those values |
| F5 | The DMS E2E path filter missed inputs to the image and the deployment | Adds `server.js`, `config/**`, `package.json`, `package-lock.json`, `Dockerfile`, `seedData/**` | `actionlint` clean |

**Proposal and docs.** Both corrections were right, and both errors also appeared elsewhere:

- *CMS scope.* `authMetadata_readonly_access` reads `/v3/dataStores` and `/v3/apiClients`
  (`MapLimitedAccess`); `/v3/tenants` is `MapSecuredGet` (`readonly_access` or admin). Fixed in the
  8.2 proposal (it now asks for the tenant list under the auth-metadata scope) and in the two docs
  drafts (`deploy-dms.md`, the env var table). The service now warns at startup when
  `MULTITENANCY_ENABLED` uses the default scope, since health and tenant checks would get 403
  (`dmsScopeWarnings`, `dms-config.test.js`).
- *Provisioning.* `ddl provision` is create-only and refuses a database provisioned for another
  effective schema; it never drops. `oneroster12` is lost when the database is dropped and
  provisioned again for a new data standard, extension set or DMS version. Fixed in the proposal,
  `stack/dms/README.md`, the `deploy-dms.md` draft and the `deploy-dms.js` header.

**Recommendations taken.**

- *Cross-engine database comparison as a command:* `tests/compare-dms-engines.js` (parity report,
  "Cross-engine comparison as a command"). `--save-pg` records the PostgreSQL side, `--pg-snapshot`
  compares SQL Server with it; values are normalized across the drivers, and every column must exist
  on both sides. Rerun: SQL Server DS 6.1 (the kept volume) against the phase 5 PostgreSQL DS 6.1
  views, 7/7 identical; a changed value and a dropped column both failed it; `--save-pg` on the
  running DS 5.2 store matched the phase 5 capture row for row.
- *Refresh tracking under real concurrency:* `viewRefresh-postgres.test.js`, run when
  `REFRESH_TRACKING_PG` names a PostgreSQL server (skipped otherwise). It builds a throwaway
  database with a DMS-shaped schema and the tracking SQL `deploy-dms.js` generates, then checks:
  skip when unchanged; refresh after a committed insert, a collection change and a delete; and a
  write that takes a lower version and commits after a refresh recorded a higher one is still picked
  up, because that refresh recorded incomplete state. Against the DMS PostgreSQL server: 4/4, and
  the database was dropped. With the `complete` check removed from `refreshView`, the late-write
  test fails. The schema copies DMS's mechanism: the emitted DDL restamps a resource from statement
  triggers on its collection tables (`TR_SchoolGradeLevel_Stamp_ins/_upd/_del` update
  `dms."Document"` and `edfi."School"` `"ContentVersion"` from `dms."ChangeVersionSequence"`).

**Not done.** The CI matrix needs the branch pushed. A live multi-tenant run needs a DMS wipe and
reprovision (done afterwards: see [Live multi-tenant run](#live-multi-tenant-run-2026-10-29)). The local stack has no read replica. A live failed-credential rotation (breaking a data
store's connection string in CMS and restoring it) was offered, not run. The synthetic fixture
still covers PostgreSQL DS 5.2 only.

**Incident: `dms-postgresql` replaced.** To run the cross-engine check, the SQL Server database
alone was started with `docker compose -p dms-local -f mssql.yml up -d db` while the PostgreSQL
stack ran. Both compose files call the service `db`, so compose replaced the `dms-postgresql`
container with `dms-mssql`. Volumes are untouched by a recreate. After the check, `dms-mssql` was
removed (its volume kept) and `dms-postgresql` recreated from the stack's own compose files
(`--env-file .env up -d --no-deps db`), on the same volume and port. Checked afterwards: effective
schema `6f7cac1476c6`, 104,885 documents, 2,901 users, 7 tracked views; DMS, CMS and
`oneroster-dms` health 200; the live DS 5.2 views equal to the phase 5 capture; and the gates below.
The README now warns about it.

### Gates

| Gate | Result |
| --- | --- |
| Unit tests | 47 suites, 972 tests, plus `viewRefresh-postgres.test.js` (4 tests, skipped without a server; 4/4 against DMS PostgreSQL) |
| Build check | 50 files |
| ODS regression: image from this branch beside the ODS stack's `main` container | Bruno 53 requests, 194/194 on both; API byte diff 141 pairs, 0 differences; discovery and `/swagger.json` identical |
| DMS PostgreSQL DS 5.2, rebuilt image (`start-dms-services.ps1 -Rebuild`) | Deploy with tracking (7 views, 21 source resources); Bruno 54 requests 199/199 and 14 requests 20/20; `compare-api.js ods-vs-dms` 270 requests, the same 13 known, 0 unexplained; `compare-dms-database.sh` 0 differences with the stricter column check; startup logs the two http warnings and nothing else |

## Live multi-tenant run (2026-10-29)

Run on a wiped and reprovisioned DMS stack; the single-tenant DS 5.2 stack was restored
afterwards.

**Setup.** Backed up first: the DMS PostgreSQL volume, the DMS bootstrap
workspace and the service env files. Then `bootstrap-local-dms.ps1 -d -v` and a multi-tenant
stack (DS 5.2, PostgreSQL), with one DMS env file per tenant (copies of `.env` with
`DMS_MULTI_TENANCY`, `CONFIGURATION_SERVICE_MULTI_TENANCY` true and
`DMS_CONFIGURATION_SERVICE_TENANT`), kept outside the DMS repository:

| Tenant | Data store | Data |
| --- | --- | --- |
| DistrictA | 1, `edfi_datamanagementservice` | Grand Bend (Populated seed through `/DistrictA/data/...`, 104,796 documents) |
| DistrictB | 2, `edfi_dms_districtb` | Minimal seed (3,303 descriptors) plus, through `/DistrictB/data/ed-fi`, LEA 255901 and school 255901107 under other names ("District B Independent School District", "District B High School") and school 255901199. Same ed-org IDs as Grand Bend, so the same `sourcedId`s carry different names in the two tenants. |

Both databases have effective schema `6f7cac1476c6`. OneRoster: `setup-dms-clients.ps1 -Tenant`
once per tenant, then `start-dms-services.ps1` with both clients files (seeds and deploys each
tenant; the service runs with `MULTITENANCY_ENABLED=true` and the `CMSReadOnlyAccess` client,
scope `edfi_admin_api/readonly_access`).

**Results**

| Check | Result |
| --- | --- |
| Health | `/health-check` pass, mode `multi-tenant` (reads `/v3/tenants`) |
| Default CMS scope (misconfiguration) | Started once with the single-tenant client and scope (`CMSAuthMetadataReadOnlyAccess`, `authMetadata_readonly_access`) and `MULTITENANCY_ENABLED=true`: the startup warning names the scope to use; `/health-check` 503 `database unreachable`; requests 503 "unable to resolve the data store"; CMS logged 403 on `/v3/tenants`. Then restarted with the right client. |
| Own tenant | DistrictA token on `/DistrictA/...`: 4 orgs (Grand Bend), 7 sessions, 84 courses; DistrictB token on `/DistrictB/...`: its 3 orgs, every other collection empty. `sourcedId` `68d5a7b8…` is "Grand Bend ISD" on one route and "District B Independent School District" on the other. |
| Another tenant | DistrictA token on `/DistrictB/...` and the reverse: 401 |
| Unknown tenant, no token | `/NoSuchTenant/...` 404; no token 401 |
| Tenant case | `/districta` and `/DISTRICTA` answer as `/DistrictA` (DMS matches tenants without regard to case too) |
| Bruno through `/DistrictA` | 54 requests 199/199; `tests-dms` 14 requests 20/20 |
| `compare-api.js ods-vs-dms` through `/DistrictA` | 270 requests, the same 13 known differences, 0 unexplained |
| `compare-dms-database.sh` on DistrictA's database | 0 differences on all 7 views |
| Discovery, Swagger | Discovery URLs carry `{tenantIdentifier}`; the Swagger server has a tenant variable with `enum` DistrictA, DistrictB |
| Refresh, one schedule for both tenants | A school posted to DistrictB at 13:19; at the 13:30 tick DistrictB refreshed the 5 views whose sources include schools (`orgs` then listed 4 entries) and skipped `classes` and `enrollments`; DistrictA skipped all 7 (`refreshed_at` unchanged) |

**Found and fixed in the service**

| # | Finding | Fix | Regression |
| --- | --- | --- | --- |
| 1 | The connection cache key used the route tenant as typed. `/districta` registered a second instance (`tenant-districta-datastore-1`) for DistrictA's data store: another connection pool, and the cron refreshed the same views again on every tick. Any valid client could open more pools by varying the case. | `resolveTenant` in the CMS provider returns the Configuration Service's spelling, and `dmsDataStoreMiddleware` uses it for the client binding check, the data-store lookup and the cache key. Live afterwards: one instance per tenant. | `dmsDataStoreMiddleware.test.js` (a route in another case keys by the CMS spelling; the old code keyed `TENANT1` separately), `dms-data-store-providers.test.js` |
| 2 | The stack scripts were single-tenant: no `Tenant` header on CMS calls, the DMS `.env` only, one clients file, seeding and deploying without a tenant. | `setup-dms-clients.ps1 -Tenant` (and `-DmsEnvironmentFile`): `Tenant` header, `DMS_TENANT` and tenant-prefixed URLs in the clients file, `MULTITENANCY_ENABLED=true` and the `readonly_access` client in a new service env file. `start-dms-services.ps1` takes one clients file per tenant and seeds (`--api-url http://dms:8080/<tenant>`) and deploys (`--tenant`) each. | Exercised by this run |

**Found in DMS and the Configuration Service** (not yet reported upstream)

- The multi-tenant bootstrap fails on a fresh stack: its claims check sends the `Tenant` header
  before the configure step creates the tenant (400, CMS logs `Tenant not found`). Workaround:
  create the tenant in CMS once the failed run has started it, then rerun (no data store exists yet,
  so the rerun is safe). Further tenants are fine: `configure-local-data-store.ps1` creates them.
- Claim set names are unique across tenants, but a tenant lists only its own claim sets and the
  system-reserved ones, so DistrictB couldn't create `OneRoster-ReadOnly`. Yet the Configuration
  Service accepts any claim set name on an application: DistrictA's claim set, and one that exists
  nowhere (probe applications, deleted afterwards). Tokens carry the name. `setup-dms-clients.ps1`
  relies on this for later tenants and warns that it does. A real deployment should register the
  OneRoster claim sets as system-reserved (a claims fragment), which every tenant shares; not tried
  here. The 8.2 proposal now asks for OneRoster resource claims in the default claims.
- DMS answers 404, not 401, when another tenant's client calls a data route: its binding check
  (`ValidateClientTenantBindingMiddleware`) runs only on the identity routes, and data routes fail
  data-store resolution instead. The service keeps 401, as on the ODS (#107).

**Shared behavior, unchanged.** A path with no tenant segment (`/ims/oneroster/...` on a
multi-tenant service) gets Express's default HTML 404, not an `imsx` body. The routing code is
shared with the ODS path and `main` has no catch-all JSON 404, so this is left as it is.

**Not run.** Tenants plus route qualifiers together (each was tested live on its own). SQL Server
multi-tenant. The ODS regression: the change is confined to DMS-only modules (`app.js` uses
`dmsDataStoreMiddleware` only when `PLATFORM=dms`, and only it calls `resolveTenant`), so the ODS
path can't reach it.

**Restore.** The multi-tenant stack was wiped and the single-tenant DS 5.2 volume restored from the
backup, with its compose labels, and the bootstrap workspace from its copy. Afterwards: effective
schema `6f7cac1476c6`, 104,885 documents, 2,901 users, 7 tracked views, no `edfi_dms_districtb`;
the service single-tenant on the rebuilt image.

### Gates

| Gate | Result |
| --- | --- |
| Unit tests | 47 suites, 973 tests (one new), plus `viewRefresh-postgres.test.js` skipped without a server |
| Build check | 50 files |
| Multi-tenant stack | The results table above |
| Restored single-tenant DS 5.2, image with the fix | Bruno 54 requests 199/199 and 14 requests 20/20; `compare-dms-database.sh` 0 differences; `compare-api.js ods-vs-dms` 270 requests, the same 13 known, 0 unexplained; `setup-dms-clients.ps1` rerun without `-Tenant` kept everything (clients file byte-identical) |
| Leak check | The secret values of every env file the run wrote, plus the earlier list, against the diff, the run notes and README: 0 matches |
