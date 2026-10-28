# OneRoster on Ed-Fi API v8 (DMS): parity report

**Run:** 2026-10-28. **Tool:** `tests/compare-dms-database.sh` (`tests/compare-dms-database.js` in a
container on both stacks' Docker networks).

| Side | Platform | Data | Projections |
| --- | --- | --- | --- |
| ODS | ODS/API 7.3.2, PostgreSQL, DS 5.2 | Grand Bend sandbox, plus the TPDM UT Austin sample | `standard/5.2.0/artifacts/pgsql`, OneRoster `main` @ `db379e0` |
| DMS | `dms-pre-8.1.0-beta2.3` (`897c008`), PostgreSQL, DS 5.2 + TPDM 1.1 | Populated template (Grand Bend) through the API, OneRoster descriptors and mappings through `standard/seed-descriptors.js` | `standard/5.2.0/artifacts/dms-pgsql`, deployed with `standard/deploy-dms.js` |

Rows are matched on `sourcedId` and compared column by column, strictly (a number and a string with
the same digits differ). Column types are compared too. Ignored by design: `dateLastModified`
(different load times; its type is still compared) and the platform person keys
(`participantUSI`/`studentUSI` on the ODS, `participantDocumentId`/`studentDocumentId` on DMS).

**Excluded (ODS side only):** education organizations 5, 6 and 7, the TPDM UT Austin schools,
which the DMS Populated template doesn't load: 3 orgs, 999 users, 999 demographics. They own no
sessions, courses, sections or enrollments.

## Result: 0 unexplained differences

| View | ODS rows | Excluded | DMS rows | Matched | Identical | Only ODS | Only DMS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| orgs | 7 | 3 | 4 | 4 | 4 | 0 | 0 |
| academicsessions | 7 | 0 | 7 | 7 | 7 | 0 | 0 |
| courses | 84 | 0 | 84 | 84 | 84 | 0 | 0 |
| classes | 532 | 0 | 532 | 532 | 532 | 0 | 0 |
| users | 3,900 | 999 | 2,901 | 2,901 | 2,901 | 0 | 0 |
| enrollments | 13,968 | 0 | 13,968 | 13,968 | 13,968 | 0 | 0 |
| demographics | 1,959 | 999 | 960 | 960 | 960 | 0 | 0 |

`sourcedId` sets match exactly after the exclusion. Every compared column has the same type on both
sides, including `dateLastModified` (`timestamp without time zone`, UTC).

### Differences, by cause

| Cause | Rows | Explanation |
| --- | ---: | --- |
| Array order only | 1 (`orgs.children` of LEA 255901) | `json_agg` without `ORDER BY` on both platforms, so the ODS order isn't defined either. Same elements. |
| Staff primary-org ranking (decision 9: `"DocumentId" desc` where the ODS uses `createdate desc`) | 0 | No staff member has more than one StaffSchoolAssociation on either side (56 have one, 12 have none), so there is only ever one candidate. |

## What Grand Bend does not exercise

Parity on this dataset doesn't test these branches. The DMS SQL is a direct translation of the ODS
logic for each, but no data reaches them:

- **users:** people at more than one school (role ordering, primary-org ranking, role dedup);
  e-mails with `doNotPublishIndicator` (suppression, #158); contact e-mails; an unmapped staff
  classification at a school (→ `teacher`); student identification codes at school level (all SEOAs
  are at the LEA, so the hash-named codes table never reaches `userIds`; that CTE was checked
  separately and matches); ranking ties.
- **enrollments / demographics:** non-`Teacher of Record` positions (all 528 staff rows are
  Teacher of Record); more than one mapped race; more than one SEOA or school per student; birth
  country, state and city (all null); birth sex is set for only 3 students. A read-only fixture run
  of the DMS view bodies with inline test rows (not committed) gave the results for teacher
  `primary`, the `STA-` key, multi-school demographics, race union, ethnicity and sex mapping.
- **courses / academicsessions / classes:** LEA- and state-owned courses (#157); offerings in
  more than one school year; more than one calendar; classes with several periods (only 1).

A synthetic fixture loaded on both platforms would close this gap; it's listed as follow-up work.

## Inherited from the ODS artifacts (kept for parity)

- The "refresh concurrently" index on `sourcedId` is not unique, so `REFRESH MATERIALIZED VIEW
  CONCURRENTLY` would fail on both platforms; the service refreshes non-concurrently.
- Enrollment `sourcedId`s hash `BeginDate::varchar`, which depends on the session `DateStyle`
  (ISO on both stacks).

## Refresh times (DMS, Grand Bend)

| View | Cold refresh | Warm refresh | ODS warm |
| --- | ---: | ---: | ---: |
| users | 215 ms | 110 ms | 111 ms |
| enrollments | 604 ms | 480 ms | 245 ms |

Full deploy of all seven views: about 0.5 s.

## API level (phase 3)

`node tests/compare-api.js ods-vs-dms`: the ODS-backed service (`main`, behind nginx) against the
DMS-backed service from this branch (`stack/dms`), with an LEA and a School client on each side.
Every collection paged at 500, three single items per collection, and six error responses
(no token, malformed token, bad `limit`, unknown id, unknown path, a filter on an unknown field),
plus the roster-core-only client on `/demographics` (403 on both). 270 requests.

| Client | Collections | Result |
| --- | --- | --- |
| School 255901107 | all 12 | identical, same order |
| LEA 255901 | 11 of 12 | identical, same order (`orgs`: LEA `children` order only, as above) |
| LEA 255901 | `users` | ODS 2,888, DMS 2,901: the 2,888 are identical; 13 only on DMS |

**The 13 LEA users only DMS returns** are 12 staff with no school association and one contact with
no school; their `educationOrganizationId` is null, and the rows are the same in both databases.
The relationship filter drops rows with a null `educationOrganizationId`, but the #133 full-access
short-circuit skips the filter when the caller reaches every served org. On DMS the LEA reaches all
4 orgs, so the short-circuit applies. On the ODS the TPDM schools 5/6/7 are served too and the LEA
can't reach them, so the filter runs. With the short-circuit disabled, DMS returns exactly 2,888
(checked by running the DMS filter directly). Both platforms run the same logic; the difference
comes from the TPDM sample data and from an upstream inconsistency in #133.

Bruno: the main collection passes against DMS (54 requests, 199/199; one more page than on the ODS
because of the 13 users), and `tests/bruno/tests-dms` passes 20/20 (no token, malformed token,
tampered signature, unmapped claim set, roster-core on `/demographics`, School token outside its
ed-org).
