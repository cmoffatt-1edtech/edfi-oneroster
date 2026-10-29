# OneRoster on Ed-Fi API v8 (DMS): local stack

Runs the OneRoster service from this checkout against a local Ed-Fi API v8 stack: the Data
Management Service (DMS) and its Configuration Service (CMS), started from the Ed-Fi
[Data-Management-Service](https://github.com/Ed-Fi-Alliance-OSS/Data-Management-Service)
repository. **For development and demos only, not production.**

Supported here: PostgreSQL, Data Standard 5.2, single tenant, the CMS self-contained identity
provider, and the Populated (Grand Bend) sample data. The service also supports route qualifiers
and multi-tenant DMS (see `.env.example`), but these scripts don't set them up.

## Prerequisites

- Docker with Docker Compose, and PowerShell 7.4+ (`pwsh`).
- A checkout of Data-Management-Service. Tested with tag `dms-pre-8.1.0-beta2.3`.
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
| `setup-dms-clients.ps1` | Creates the OneRoster claim sets, vendor and applications in CMS (table below). Writes `dms/.env.dms-clients` (credentials and URLs) and `dms/.env.dms` (service settings), both git-ignored and readable only by you. Restarts the DMS container after creating a claim set, because DMS caches claim sets for 10 minutes. Idempotent: it keeps existing objects and credentials. |
| `start-dms-services.ps1` | Builds the image if needed (`-Rebuild` forces it). Seeds the OneRoster descriptors and descriptor mappings through the Ed-Fi API (`standard/seed-descriptors.js`), deploys the `oneroster12` projections into every data store CMS lists, and creates the pg-boss database (`standard/deploy-dms.js --from-cms --jobs-database`). Then starts the service and waits for its health check. Every step runs in a container on the DMS network. `-SkipSeed` and `-SkipDeploy` start the service only. |
| `stop-dms-services.ps1` | Stops and removes the service container. `-Purge` also removes the image. DMS keeps running. |

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
| `.env.dms` | Written by `setup-dms-clients.ps1` from the example; kept on later runs unless `-Force`. |
| `.env.dms-clients` | Written by `setup-dms-clients.ps1`: client credentials and the DMS, CMS and OneRoster URLs. |

Inside the DMS network, CMS answers as `http://config:8081`, but the tokens it issues carry
`iss` = `http://ed-fi-api-config:8081`. That host name only resolves inside the DMS container, so
`.env.dms` checks the issuer by name (`OAUTH2_ISSUER`) and fetches the keys through the alias
(`OAUTH2_JWKS_URL`).

## Reprovisioning

A DMS data store is provisioned per effective schema: the data standard, the extensions, and the
DMS version that generates the tables. Provisioning drops and recreates the database, which removes
the `oneroster12` schema and the OneRoster descriptors. The order is:

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
| `Application '…' exists, but its credentials are not in …` | `.env.dms-clients` was deleted or comes from another stack. Rerun with `-ResetMissingCredentials` to rotate those applications' secrets. |
| 429 from the token endpoint | The 15-active-token limit. Wait for tokens to expire (30 minutes). |
| Every request gets 401, and `docker logs oneroster-dms` shows `Issuer claim mismatch` | `OAUTH2_ISSUER` must equal the `iss` claim exactly (`http://ed-fi-api-config:8081` on this stack). |
| `bootstrap-local-dms.ps1` on a stopped stack fails with 400 "A data store with this name already exists" | The bootstrap isn't rerunnable on kept volumes. Use `start-local-dms.ps1 -EnableSwaggerUI`. |
| `-RestoreTemplate Populated` fails | The package feed has no template attestation packages. Use `-LoadSeedData -SeedTemplate Populated`. |
| `api-schema-tools … You must install .NET` during the DMS bootstrap | Homebrew .NET on macOS: `export DOTNET_ROOT=/opt/homebrew/opt/dotnet/libexec`. |
