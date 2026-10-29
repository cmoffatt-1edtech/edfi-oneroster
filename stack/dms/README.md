# OneRoster on Ed-Fi API v8 (DMS): local stack

Runs the OneRoster service from this checkout against a local Ed-Fi API v8 stack: the Data
Management Service (DMS) and its Configuration Service (CMS), started from the Ed-Fi
[Data-Management-Service](https://github.com/Ed-Fi-Alliance-OSS/Data-Management-Service)
repository. **For development and demos only, not production.**

Supported here: PostgreSQL or SQL Server, Data Standard 5.2 or 6.1, single tenant or
[multi-tenant](#multi-tenant-dms), the CMS self-contained identity provider, and the Populated
(Grand Bend) sample data. The service also supports route qualifiers (see `.env.example`), but
these scripts don't set them up. PostgreSQL, DS 5.2 and a single tenant are the defaults; see
[SQL Server](#sql-server) and [Data Standard 6.1](#data-standard-61).

## Prerequisites

- Docker with Docker Compose, and PowerShell 7.4+ (`pwsh`).
- A checkout of Data-Management-Service. Tested with tag `v8.1.0`; built against
  `dms-pre-8.1.0-beta2.3`, which works the same with these scripts.
- What the DMS bootstrap needs, which is the .NET 10 SDK. With the Homebrew .NET install on
  macOS, export `DOTNET_ROOT=/opt/homebrew/opt/dotnet/libexec` first.
- Node.js 22+ and `npm ci`, only to run the tests from the host.

## Start from nothing

```powershell
# 1. DMS, from the Data-Management-Service checkout: provisions DS 5.2 and loads Grand Bend through
#    the API (about 2.5 minutes with cached images, longer the first time)
cd <Data-Management-Service>/eng/docker-compose
pwsh ./bootstrap-local-dms.ps1 -LoadSeedData -SeedTemplate Populated -EnableSwaggerUI

# 2. OneRoster clients in CMS, and the env files, from this repository's stack/ folder
cd <edfi-oneroster>/stack
pwsh ./setup-dms-clients.ps1 -DmsComposeDir <Data-Management-Service>/eng/docker-compose

# 3. Descriptors, projections and the service
pwsh ./start-dms-services.ps1 -Rebuild
```

The service answers at `http://localhost:3200`, with the OneRoster API under
`/ims/oneroster/rostering/v1p2/`. Check it with `curl -s localhost:3200/health-check`. To get a
token and call it, see [Calling the service](#calling-the-service).

## The scripts

| Script | What it does |
| --- | --- |
| `setup-dms-clients.ps1` | Creates the OneRoster claim sets, vendor and applications in CMS (table below). Writes `dms/.env.dms-clients` (credentials and URLs) and `dms/.env.dms` (service settings), both git-ignored and readable only by you. Restarts the DMS container after creating a claim set, because DMS caches claim sets for 10 minutes. Idempotent: it keeps existing objects and credentials, puts back an application's claim set or ed-org if it changed, and stops before writing anything if an application is on another data store. `-Tenant` works in one tenant of a [multi-tenant](#multi-tenant-dms) stack. |
| `start-dms-services.ps1` | Builds the image if needed (`-Rebuild` forces it). Seeds the OneRoster descriptors and descriptor mappings through the Ed-Fi API (`standard/seed-descriptors.js`), deploys the `oneroster12` projections into every data store CMS lists, and creates the pg-boss database (`standard/deploy-dms.js --from-cms --jobs-database`). Then starts the service and waits for its health check. Every step runs in a container on the DMS network. `-SkipSeed` and `-SkipDeploy` start the service only. Given one clients file per tenant, it seeds and deploys each tenant. |
| `stop-dms-services.ps1` | Stops and removes the service container. `-Purge` also removes the image. DMS keeps running. Fails if Docker does, so a wipe doesn't follow a stop that didn't happen. |

What `setup-dms-clients.ps1` creates:

| Object | Details |
| --- | --- |
| Claim set `OneRoster-ReadOnly` | No Ed-Fi resource grants. `ONEROSTER_CLAIMSET_SCOPES` maps it to `roster.readonly` and `roster-demographics.readonly`. |
| Claim set `OneRoster-Core` | No Ed-Fi resource grants. Mapped to `roster-core.readonly`. |
| Vendor `1EdTech OneRoster (local)` | Namespace prefixes `uri://ed-fi.org,uri://1edtech.org`. |
| `OneRoster LEA` | Ed-org 255901, `OneRoster-ReadOnly` → `DMS_LEA_KEY` / `DMS_LEA_SECRET` |
| `OneRoster School` | Ed-org 255901107, `OneRoster-ReadOnly` → `DMS_SCHOOL_KEY` / `DMS_SCHOOL_SECRET` |
| `OneRoster LEA Core` | Ed-org 255901, `OneRoster-Core` → `DMS_CORE_KEY` / `DMS_CORE_SECRET` |
| `OneRoster Seeder` | Ed-org 255901, built-in `SeedLoader` claim set: posts the OneRoster descriptors → `DMS_SEEDER_KEY` / `DMS_SEEDER_SECRET`. Its claim set isn't in `ONEROSTER_CLAIMSET_SCOPES`, so the OneRoster API refuses it (403); the Bruno DMS checks use it for that. |

The service reads data stores with the CMS read-only client `CMSAuthMetadataReadOnlyAccess`, which
the DMS stack scripts create. Its secret is the DMS stack default, read from the DMS repository's
`setup-openiddict.ps1`; pass `-CmsReadOnlyClientSecret` if you changed it. Other inputs, such as
the CMS admin client, the connection-string encryption key and the PostgreSQL password, come from
the DMS stack's `eng/docker-compose/.env`.

## Files

| File | |
| --- | --- |
| `docker-compose.yml` | The service on the external `dms` network (`DMS_NETWORK` overrides it), published on `127.0.0.1:3200` (`ONEROSTER_DMS_PORT`). The image is `edfi-oneroster:dms-local`, built from this checkout (`ONEROSTER_IMAGE` overrides it). |
| `.env.dms.5.2.0.example` | Service settings for DS 5.2, single tenant, with placeholders for the three secrets. |
| `.env.dms.5.2.0.mssql.example` | The same for a DMS stack on SQL Server: `DB_TYPE=mssql`, no pg-boss. `setup-dms-clients.ps1 -DatabaseEngine mssql` uses it. The service settings don't depend on the data standard, so it serves DS 6.1 as well. |
| `.env.dms` | Written by `setup-dms-clients.ps1` from the example; kept on later runs unless `-Force`. |
| `.env.dms-clients` | Written by `setup-dms-clients.ps1`: client credentials and the DMS, CMS and OneRoster URLs. |
| `.env.dms.multitenant`, `.env.dms-clients.<tenant>` | The [multi-tenant](#multi-tenant-dms) equivalents: one service env file, one clients file per tenant. Any names work; these are the ones the examples use. |

Inside the DMS network, CMS answers as `http://config:8081`, but the tokens it issues carry
`iss` = `http://ed-fi-api-config:8081`. That host name only resolves inside the DMS container, so
`.env.dms` checks the issuer by name (`OAUTH2_ISSUER`) and fetches the keys through the alias
(`OAUTH2_JWKS_URL`).

## Reprovisioning

A DMS data store is provisioned per effective schema: the data standard, the extensions, and the
DMS version that generates the tables. Provisioning is create-only and refuses a database
provisioned for another effective schema, so changing any of these means dropping the database
(here, wiping the volume) and provisioning a new one. That removes the `oneroster12` schema and the
OneRoster descriptors. The order is:

1. `ddl provision` (the DMS bootstrap does this), then restart DMS.
2. Seed the OneRoster descriptors and mappings through the Ed-Fi API.
3. Deploy the projections (`deploy-dms.js` checks that every table it needs exists and refuses an
   unknown effective schema).
4. Start the OneRoster service.

After any reprovision, such as a wipe, a data standard change or an extension change, rerun
`start-dms-services.ps1`, which does steps 2 to 4.

## Stop, restart, wipe

```powershell
# Stop OneRoster; DMS keeps running
pwsh ./stop-dms-services.ps1

# Start OneRoster again on an unchanged data store
pwsh ./start-dms-services.ps1 -SkipSeed -SkipDeploy

# Wipe and rebuild everything. Stop OneRoster first: the wipe removes the dms network.
pwsh ./stop-dms-services.ps1
cd <Data-Management-Service>/eng/docker-compose
pwsh ./bootstrap-local-dms.ps1 -d -v -EnableSwaggerUI
# ...then "Start from nothing" again. CMS issues new credentials, and setup-dms-clients.ps1
# replaces the old ones in .env.dms-clients.
```

To restart DMS with its data kept, use `start-local-dms.ps1 -EnableSwaggerUI`, not
`bootstrap-local-dms.ps1`; see the troubleshooting table.

## SQL Server

The DMS stack's `-DatabaseEngine mssql` puts the data store, CMS and the identity stores on SQL
Server (container `dms-mssql`, host port 1435). The two engines' stacks use the same container
names, so run one at a time: stop the other with `bootstrap-local-dms.ps1 -d` (keeps its volume)
first. Both compose files also name the database service `db`, so starting `mssql.compose.yml` (`mssql.yml` before 8.1.0) alone under
the `dms-local` project while the PostgreSQL stack runs replaces the `dms-postgresql` container
(its volume survives; bring it back with the stack's compose files and `up -d --no-deps db`). On SQL Server the `oneroster12` projections are tables filled by `sp_refresh_*` procedures,
refreshed by a SQL Server Agent job (`OneRoster 1.2 Refresh (<database>)`, daily at 02:00 as on the
ODS), so there is no pg-boss database.

```powershell
# 1. DMS on SQL Server (about 14 minutes on Apple silicon, where the SQL Server image runs emulated)
cd <Data-Management-Service>/eng/docker-compose
pwsh ./bootstrap-local-dms.ps1 -DatabaseEngine mssql -LoadSeedData -SeedTemplate Populated -EnableSwaggerUI

# 2. SQL Server Agent: the DMS compose file doesn't enable it
docker exec dms-mssql /opt/mssql/bin/mssql-conf set sqlagent.enabled true
docker restart dms-mssql

# 3. Clients and env files, kept apart from the PostgreSQL stack's
cd <edfi-oneroster>/stack
pwsh ./setup-dms-clients.ps1 -DmsComposeDir <Data-Management-Service>/eng/docker-compose `
  -DatabaseEngine mssql -ClientsFile dms/.env.dms-clients.mssql -EnvFile dms/.env.dms.mssql

# 4. Descriptors, projections, service
pwsh ./start-dms-services.ps1 -Rebuild -EnvFile dms/.env.dms.mssql -ClientsFile dms/.env.dms-clients.mssql
```

`deploy-dms.js` reads `DB_TYPE=mssql` from the service environment and creates the tables,
procedures and the Agent job in one transaction, then fills the tables (`sp_refresh_all`). It warns
when SQL Server Agent isn't running. To refresh by hand: `exec oneroster12.sp_refresh_all
@ForceRefresh = 1`. Ed-Fi API v8 writes SQL Server connection strings as `Server=host,port`, which
the service parses.

To compare the SQL Server projections with PostgreSQL ones loaded with the same data and data
standard, save the PostgreSQL side while that stack runs, then compare once SQL Server runs:

```bash
DMS_PG="host=localhost;port=5435;username=postgres;password=...;database=edfi_datamanagementservice" \
  node tests/compare-dms-engines.js --save-pg tests/.dms-compare/pg-ds52
DMS_MSSQL="Server=localhost,1435;Database=edfi_datamanagementservice;User Id=sa;Password=...;TrustServerCertificate=true" \
  node tests/compare-dms-engines.js --pg-snapshot tests/.dms-compare/pg-ds52
```

It exits 0 when every row and column matches (load times and DocumentIds aside). For the API, record
the PostgreSQL service with `compare-api.js dms-record` and replay against SQL Server with
`dms-vs-recording`.

## Data Standard 6.1

`bootstrap-local-dms.ps1 -DataStandardVersion 6.1` provisions DS 6.1 (core only; TPDM is part of
core in 6.1). `deploy-dms.js` picks `standard/6.1.0/artifacts/dms-pgsql` or `dms-mssql` from the
data store's `dms."SchemaComponent"`. A different data standard means a different effective schema,
so the data store is reprovisioned: wipe the stack (`-d -v`) before switching, then rerun the steps
above. The DS 6.1 Populated seed loads through the API (about 168,000 records; 4 minutes on
PostgreSQL, 10 on emulated SQL Server). On 8.1.0 with PostgreSQL, one load stopped with 429s from
DMS's own rate limit (`DMS_RATE_LIMIT_PERMIT_LIMIT`, 20,000 requests per 10 seconds in the DMS
stack's `.env`) with about 1,350 `ProfessionalDevelopmentEventAttendance` records not loaded, and
the bootstrap exited 1. The stack was usable, and no OneRoster view reads that resource; the DMS
`.env` suggests a higher limit for large loads. The wipe gives CMS new credentials, so pass
`-ClientsFile` / `-EnvFile` to keep each stack's files apart if you switch back and forth. The DS
6.1 projections follow the ODS 6.1 ones
([data-standard-6.1-support.md](../../docs/design/data-standard-6.1-support.md)), and the sample
holds the TPDM schools on both platforms, so parity runs need no excluded education organizations
(`--exclude-edorgs ''`).

## Multi-tenant DMS

With `DMS_MULTI_TENANCY` and `CONFIGURATION_SERVICE_MULTI_TENANCY` set to `true`, DMS takes the
tenant as the first path segment (`/{tenant}/data/ed-fi/...`), and so does the service:
`/{tenant}/ims/oneroster/rostering/v1p2/`. Each tenant has its own data stores, vendors and
applications in CMS. Tested on PostgreSQL with two tenants, each with its own database.

The DMS scripts read the tenant from `DMS_CONFIGURATION_SERVICE_TENANT`, so make one env file per
tenant: a copy of the stack's `eng/docker-compose/.env` with the two multi-tenancy settings set to
`true` and `DMS_CONFIGURATION_SERVICE_TENANT` set to the tenant name.

```powershell
# 1. DMS and the first tenant. On a fresh stack the bootstrap's claims check sends the Tenant
#    header before its configure step creates the tenant, and fails with 400 "Tenant not found".
#    CMS is up by then: create the tenant (POST http://localhost:8081/v3/tenants {"name":"DistrictA"}
#    with a token for the CMS admin client), then run the same command again. The rerun is safe
#    because no data store exists yet.
cd <Data-Management-Service>/eng/docker-compose
pwsh ./bootstrap-local-dms.ps1 -EnvironmentFile <.env.districta> -LoadSeedData -SeedTemplate Populated -EnableSwaggerUI

# 2. Each further tenant, in its own database (configure creates the tenant)
pwsh ./configure-local-data-store.ps1 -EnvironmentFile <.env.districtb> -DataStoreDatabaseName edfi_dms_districtb
pwsh ./provision-dms-schema.ps1 -EnvironmentFile <.env.districtb>
docker restart ed-fi-api
pwsh ./load-dms-seed-data.ps1 -EnvironmentFile <.env.districtb> -SeedTemplate Minimal

# 3. OneRoster clients, once per tenant, all writing the same service env file
cd <edfi-oneroster>/stack
pwsh ./setup-dms-clients.ps1 -DmsComposeDir <Data-Management-Service>/eng/docker-compose `
  -DmsEnvironmentFile <.env.districta> -Tenant DistrictA `
  -ClientsFile dms/.env.dms-clients.districta -EnvFile dms/.env.dms.multitenant
pwsh ./setup-dms-clients.ps1 -DmsComposeDir <Data-Management-Service>/eng/docker-compose `
  -DmsEnvironmentFile <.env.districtb> -Tenant DistrictB `
  -ClientsFile dms/.env.dms-clients.districtb -EnvFile dms/.env.dms.multitenant

# 4. Descriptors and projections in each tenant, then the service
pwsh ./start-dms-services.ps1 -Rebuild -EnvFile dms/.env.dms.multitenant `
  -ClientsFile dms/.env.dms-clients.districta,dms/.env.dms-clients.districtb
```

What changes with tenants:

- **CMS client.** The service checks the route tenant against `/v3/tenants`, which the
  `authMetadata_readonly_access` scope can't read. With `-Tenant`, `setup-dms-clients.ps1` writes
  `MULTITENANCY_ENABLED=true` and the DMS stack's own CMS client (`CMSReadOnlyAccess`, scope
  `edfi_admin_api/readonly_access`) into the service env file. The service warns at startup if a
  multi-tenant configuration keeps the default scope.
- **Routing.** An unknown tenant is 404. The tenant matches without regard to case, as in DMS.
  A client whose application belongs to another tenant gets 401, as on the ODS. DMS itself
  answers 404 to that request, because the client's data store isn't one of that tenant's.
- **Clients files.** Each one has `DMS_TENANT` and the tenant-prefixed `DMS_ONEROSTER_URL` and
  `DMS_TOKEN_URL`, so the tests run against a tenant as they are:
  `pwsh tests/bruno/run-bruno-dms.ps1 -ClientsFile stack/dms/.env.dms-clients.districta -ServiceEnvFile stack/dms/.env.dms.multitenant`.
- **Claim sets.** CMS keeps claim set names unique across tenants, but a tenant lists only its
  own claim sets and the system-reserved ones. `setup-dms-clients.ps1` creates `OneRoster-ReadOnly`
  and `OneRoster-Core` in the first tenant. Later tenants' applications use them by name, with a
  warning: CMS doesn't check an application's claim set name, and the token carries the name,
  which is all the service maps. For a real deployment, register the two as system-reserved claim
  sets, which every tenant shares (a claims fragment; see the DMS repository's
  `docs/CLAIMS-LOADING-GUIDE.md`). That route hasn't been tried here.
- **Refresh.** One pg-boss database and one schedule serve every tenant. Each data store's views
  refresh only when its own sources changed.
- **Discovery and Swagger.** Discovery URLs carry a `{tenantIdentifier}` placeholder, and the
  Swagger document's server has a tenant variable listing the CMS tenants.

## Calling the service

Tokens come from DMS (`http://localhost:8080/oauth/token`, which forwards to CMS) with the
client's claim set as the scope:

```sh
set -a; . stack/dms/.env.dms-clients; set +a
TOKEN=$(curl -s "$DMS_TOKEN_URL" --data-urlencode grant_type=client_credentials \
  --data-urlencode "client_id=$DMS_LEA_KEY" --data-urlencode "client_secret=$DMS_LEA_SECRET" \
  --data-urlencode scope=OneRoster-ReadOnly | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
curl -s -H "Authorization: Bearer $TOKEN" "$DMS_ONEROSTER_URL/ims/oneroster/rostering/v1p2/orgs"
```

The CMS self-contained identity provider allows 15 active tokens per client, each valid for 30
minutes, and answers 429 beyond that. Reuse a token until it expires rather than requesting one
per call.

Tests (Bruno, API parity with the ODS stack, database parity) are in
[tests/README.md](../../tests/README.md#testing-against-ed-fi-api-v8-dms).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Docker network 'dms' not found` | The DMS stack isn't running. Start it first. |
| DMS answers 500 "Security Configuration Error" for a token on a new claim set | DMS caches claim sets for 10 minutes. `setup-dms-clients.ps1` restarts DMS after creating one; otherwise `docker restart ed-fi-api`. |
| `Application '…' is on data store(s) …, not …` | The application was created for another data store. Pass that one with `-DataStoreId`, or delete the application in CMS and rerun. |
| `Application '…' exists, but its credentials are not in …` | `.env.dms-clients` was deleted or comes from another stack. Rerun with `-ResetMissingCredentials` to rotate those applications' secrets. |
| 429 from the token endpoint | The 15-active-token limit. Wait for tokens to expire (30 minutes). |
| Every request gets 401, and `docker logs oneroster-dms` shows `Issuer claim mismatch` | `OAUTH2_ISSUER` must equal the `iss` claim exactly (`http://ed-fi-api-config:8081` on this stack). |
| `bootstrap-local-dms.ps1` on a stopped stack fails with 400 "A data store with this name already exists" | The bootstrap isn't rerunnable on kept volumes. Use `start-local-dms.ps1 -EnableSwaggerUI`. |
| Multi-tenant `bootstrap-local-dms.ps1` fails at the claims check with 400 "Tenant not found" | The check sends the Tenant header before the tenant exists. Create the tenant in CMS, then rerun; see [Multi-tenant DMS](#multi-tenant-dms). |
| `-RestoreTemplate Populated` fails | The package feed has no template attestation packages. Use `-LoadSeedData -SeedTemplate Populated`. |
| `api-schema-tools … You must install .NET` during the DMS bootstrap | Homebrew .NET on macOS: `export DOTNET_ROOT=/opt/homebrew/opt/dotnet/libexec`. |
