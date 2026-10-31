# Optional roster fields: prototype

A prototype of the first fields on a draft shortlist of values Ed-Fi consumers ask for in the core
roster calls so they don't need a follow-up Ed-Fi API call. Branch `feature/roster-fields`, on top
of `feature/assessment-rostering`. Provisional: the field names and shape are open questions for
the field-partner review and the OneRoster project group.

## What it adds

Optional keys in `metadata`, next to `metadata.edfi`, named as in ClassLink's Roster Server
metadata list so vendors that already read those can use them unchanged. A key is left out when
Ed-Fi has no value.

| Resource | Key | Ed-Fi source |
| --- | --- | --- |
| orgs | `NCESId` | EducationOrganizationIdentificationCode, system `NCES` |
| orgs | `orgStateId` | EducationOrganizationIdentificationCode, system `SEA` |
| orgs | `address1`, `address2`, `city`, `state`, `postalCode` | EducationOrganizationAddress, type `Physical` (street, apartment/suite, city, state abbreviation, postal code) |
| orgs | `phone` | EducationOrganizationInstitutionTelephone, type `Main` |
| courses | `courseStateId` | CourseIdentificationCode, system `State course code` |

Where Ed-Fi holds several values (two physical addresses, two NCES codes), the lowest by code
point wins, the same on every engine. On DMS the ed-org collections are per resource
(`SchoolIdentificationCode`, `LocalEducationAgencyAddress`, ...), so the view unions them.

## Covered and not covered

- Covered: ODS and DMS on PostgreSQL, Data Standard 5.2 (`standard/5.2.0/artifacts/{pgsql,dms-pgsql}/core/orgs.sql`, `courses.sql`).
- Not yet: SQL Server (both platforms), Data Standard 6.1 and 4.0, the class-level state ID
  (`classStateId`, inherited from the course), the synthetic fixture (Grand Bend data only), and
  the end-user docs.
- Open questions (shortlist): ClassLink's names or `metadata.edfi`; a typed list of all org
  identification codes instead of named fields; which address and phone types count.

## Checks (2026-10-31)

| Check | Result |
| --- | --- |
| Unit | `roster-fields-artifacts.test.js`; full suite passes. |
| Grand Bend, ODS and DMS PostgreSQL | 4 Grand Bend orgs get `orgStateId`, address and phone; course `ALG-1` gets `courseStateId`; the TPDM schools (ODS only) get addresses. Same values on both platforms. |
| DB parity | 0 differences across 11 views (orgs 4 matched, courses 84 matched, all identical). |
| API parity | `compare-api.js ods-vs-dms --assessment-rostering`: 304 requests, 13 known differences, 0 unexplained. |

The responses change for every org and course (new keys, and `metadata` built as `jsonb`, which
orders keys differently), so a byte comparison with the main branch differs by design.
