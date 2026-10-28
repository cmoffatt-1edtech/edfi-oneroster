# DMS sample payloads (phase 0 spike)

Captured 2026-10-28 from a local Ed-Fi API v8 stack: Data Management Service and Configuration Service at
tag `dms-pre-8.1.0-beta2.3` (`897c008`), DS 5.2 + TPDM 1.1, PostgreSQL, self-contained identity
provider. They show the real shapes the DMS port has to handle. Client identifiers, `jti` and the
encrypted connection string are redacted, token signatures are dropped, and the JWKS modulus is truncated.

| File | What |
| --- | --- |
| `token-lea.payload.json`, `token-school.payload.json` | Vendor tokens for applications on claim set `OneRoster-ReadOnly`, ed-orgs 255901 and 255901107 |
| `token-cms-ro.payload.json` | Configuration Service read-only token (`edfi_admin_api/authMetadata_readonly_access`) |
| `cms-v3-dataStores.json` | `GET /v3/dataStores` |
| `cms-v3-apiClients-lea.json` | `GET /v3/apiClients/{key}`, including the per-client ed-org scope added in DMS-1625 |
| `cms-openid-configuration.json`, `cms-jwks.json` | OIDC metadata and JWKS |
| `dms-discovery.json` | Ed-Fi API discovery root |

Things to note:
- `iat` and `exp` are JSON strings, not numbers.
- The JWKS key has an empty `key_ops` array.

Neither works with `jose.jwtVerify` / `createRemoteJWKSet` as is; `src/platform/token-verifier.js` works around both.
