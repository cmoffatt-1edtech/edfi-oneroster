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

Since the independent review, a `sourcedId` that appears more than once on either side and a column
on one side only also fail the run. The column lists come from the catalog, so an empty view is
checked too. `compare-api.js ods-vs-dms` also fails on a repeated `sourcedId`. Rerun on
2026-10-28 with both rules: no duplicates and no one-sided columns in any view or collection.

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
  country, state and city (all null); birth sex is set for only 3 students.
- **courses / academicsessions / classes:** LEA- and state-owned courses (#157); offerings in
  more than one school year; more than one calendar; classes with several periods (only 1).

The synthetic fixture below now covers these branches on both platforms, except staff
primary-org ties (see its limits).

## Synthetic fixture

**Run:** 2026-10-29. **Tool:** `tests/compare-dms-fixture.sh` (`tests/compare-dms-fixture.js`,
data in `tests/dms-parity-fixture.js`). Same two databases as above.

The fixture describes its data once, by natural key: a state agency, two LEAs (one without a state
agency), three schools (one without an LEA), calendars, sessions, courses, sections, 5 students,
5 staff and 4 contacts. It uses its own ed-org ids (9900, 9900xx, 9900xxxxx) and unique ids
(`FX-...`), so it doesn't touch Grand Bend rows. Two writers turn it into rows for each platform's
tables: 141 ODS rows and 135 DMS rows (the ODS also has the `educationorganization` base table).
Descriptors are looked up by URI. The 28 in the `uri://ed-fi.org` namespace exist on both
platforms; the 5 in the fixture's own namespace, which no mapping uses, are added for the run.

On each database, in one REPEATABLE READ transaction that is rolled back:

1. `session_replication_role = replica`, so triggers and foreign keys don't fire. Check, unique
   and not-null constraints still apply, including the DMS all-or-none reference checks, and the
   loader refuses generated columns.
2. Each projection's definition (`pg_get_viewdef` of the materialized view) runs before the load
   and after it. The materialized views aren't refreshed, so nothing waits on them.
3. The rows the load adds are compared, ODS against DMS, with the database tool's rules, and with
   `dateLastModified` compared too, since the fixture sets both platforms' timestamps. A
   projection row that the load changes or removes fails the run.
4. Columns with a sequence default get explicit values, and `pg_sequences` is compared before and
   after. After the rollback the run checks that no fixture student remains.

Both platforms are also checked against 56 expected values and row counts (`EXPECTATIONS` in the
fixture, written from the ODS SQL). So a fixture that stops reaching a branch fails, even when
both sides still agree.

### Result: parity, and every expectation met on both platforms

| View | Fixture rows (ODS = DMS) | Identical | Order-only |
| --- | ---: | ---: | --- |
| orgs | 6 | 6 | `children` of the fixture LEA |
| academicsessions | 8 | 8 | |
| courses | 5 | 5 | |
| classes | 5 | 5 | |
| users | 19 | 19 | `roles` of 6 people at two schools |
| enrollments | 9 | 9 | |
| demographics | 8 | 8 | |

Expectations: 56 of 56 on the ODS and 56 of 56 on DMS. No existing projection row changed, no
sequence moved and no fixture rows remained, on either database. A run takes about 2 seconds.

### What it covers

| Branch | Fixture case |
| --- | --- |
| Student at two schools | Primary by latest entry; primary flag beats a later entry; same entry date (lower `schoolId` primary, higher grade code wins); re-enrolment at one school (one row, one role, latest grade) |
| Student e-mail | Suppressed preferred address falls through to the next; only address suppressed (empty `username`); `Home/Personal` preferred over `Other`; address from an SEOA at a school the student isn't enrolled at |
| Student ids | School-level codes reach that school's row only, ordered by system; LEA-level codes never reach `userIds` |
| Staff at two schools | Latest association primary; school-level classification wins at its school and LEA-level elsewhere; role takes the lowest mapped value |
| Unmapped staff classification | Teaching staff → `teacher`, roles carry a null role; not teaching → null role |
| Staff e-mail | Suppressed `Work` falls through; `Work` from a staff contact association preferred; invalid address still used; ed-org contact only |
| Contacts | Two students at two schools (tie on latest entry → lower `schoolId`); first primary, publishable address by address; null indicators exclude an address; no students; a student with no school |
| Enrollments | Teacher of Record (`true`), Substitute Teacher (`false`), unmapped position (`false`), end dates, mixed-case keys |
| Demographics | Races across two SEOAs (two or more races), duplicate race, unmapped race, `bool_or` ethnicity with null, mapped and unmapped sex, birth country, state and city, `dateLastModified` from the latest SEOA, a student with no school |
| Courses | Owned by an LEA (offerings in two years → latest), a school, the state agency (no school year), an LEA with no offerings, a school without an LEA; same code under two orgs |
| Academic sessions | Two calendars in one school; a date with an instructional and a holiday event; modal first and last day with a tie; two school years; a year with calendar dates but no LEA; an unmapped term (no session row, but it sets the school year's `dateLastModified`) |
| Classes | Two class periods (sorted), a location, an offering without a title (`''`), mixed-case course code, section and session |

### Checks on the check

A run with four deliberate breaks failed as it should:

- a DMS-only change to one student's e-mail (2 `users` differences, DMS expectations failed);
- an ODS-only change to one session's timestamp (an `academicsessions` `dateLastModified`
  difference);
- one staff assignment removed on both platforms (parity held, expectations failed on both);
- a school added under the Grand Bend LEA (1 changed existing row reported on each platform).

### Limits

- The rows are written straight to the tables with triggers and foreign keys off, so the run tests
  the projections, not how each API stores a resource. The DMS rows do satisfy DMS's own check
  constraints and generated key columns.
- Ties in staff primary-org ranking aren't compared: the ODS ranks by `createdate` and DMS by
  `"DocumentId"` (decision 9). The fixture gives each association a distinct order on both.
- PostgreSQL and Data Standard 5.2 only. SQL Server and DS 6.1 are phase 5.

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

**Accepting these 13 is a decision about authorization semantics, not a parity result.** The
#133 short-circuit lets a caller that reaches every served org see people who have no org at all.
The port keeps that behavior on both platforms, because changing it would change what ODS clients
see, which is a separate decision. They are listed in `tests/dms-parity-known-differences.json`
so the API comparison still fails on anything else. If #133's short-circuit changes upstream, the list
becomes empty and both platforms return 2,888.

Bruno: the main collection passes against DMS (54 requests, 199/199; one more page than on the ODS
because of the 13 users), and `tests/bruno/tests-dms` passes 20/20 (no token, malformed token,
tampered signature, unmapped claim set, roster-core on `/demographics`, School token outside its
ed-org).

## SQL Server, DS 5.2 (phase 5)

**Run:** 2026-10-29. DMS on SQL Server (`bootstrap-local-dms.ps1 -DatabaseEngine mssql`, same pin,
same Populated load), projections `standard/5.2.0/artifacts/dms-mssql`, compared with DMS on
PostgreSQL. The two DMS stacks share container names, so the PostgreSQL side was captured first:
the seven views as JSON, and the API with `compare-api.js dms-record`.

| Check | Result |
| --- | --- |
| Tables against the PostgreSQL views (`dateLastModified` and person keys ignored) | 7/7 identical: orgs 4, academicsessions 7, courses 84, classes 532, users 2,901, enrollments 13,968, demographics 960 (one order-only `children` array) |
| `compare-api.js dms-vs-recording` | 135 requests (24 collections for the LEA and School clients, 3 single items each, the error cases, roster-core on `/demographics`): 0 differences, same order everywhere |
| Bruno | 54 requests, 199/199; `tests-dms` 14 requests, 20/20 |

The ODS SQL Server files, which the DMS SQL Server files follow for structure, differ from the ODS
PostgreSQL files in ways Grand Bend doesn't reach; the port follows PostgreSQL there. The list is
in the run notes (phase 5).

## Data Standard 6.1 (phase 5)

**Run:** 2026-10-29. ODS/API 7.3.2 on DS 6.1 (`stack/pgsql/.env.6.1.0`, sandbox image
`7.3.2_6447-6.1.0`, OneRoster `main` @ `db379e0` with `standard/6.1.0/artifacts/pgsql`) against
DMS on DS 6.1 (`bootstrap-local-dms.ps1 -DataStandardVersion 6.1 -LoadSeedData -SeedTemplate
Populated`, projections `standard/6.1.0/artifacts/dms-pgsql`).

**Data.** The DS 6.1 Populated seed loads through the API: 168,038 records created, no errors,
about 4 minutes. DS 6.1 has no separate TPDM extension, and both sides hold the same education
organizations, including the six TPDM schools (5, 6, 7, 50, 60, 70), so nothing is excluded.

| View | ODS rows | DMS rows | Identical |
| --- | ---: | ---: | ---: |
| orgs | 10 | 10 | 10 |
| academicsessions | 13 | 13 | 13 |
| courses | 400 | 400 | 400 |
| classes | 1,954 | 1,954 | 1,954 |
| users | 5,377 | 5,377 | 5,377 |
| enrollments | 16,446 | 16,446 | 16,446 |
| demographics | 2,958 | 2,958 | 2,958 |

`compare-dms-database.sh --exclude-edorgs ''`: 0 differences, no order-only arrays (the DS 6.1
projections order their aggregated arrays). `compare-api.js ods-vs-dms --exclude-edorgs ''`: 300
requests, 0 differences, same order everywhere, and no known differences used. The 13 LEA users of
DS 5.2 don't appear: with the TPDM schools on both sides, the LEA reaches every served org on
neither platform, so the relationship filter runs on both (see the 13 users above). Bruno against
DMS: 67 requests, 264/264; `tests-dms` 14 requests, 20/20.

**SQL Server, DS 6.1.** `standard/6.1.0/artifacts/dms-mssql` on DMS on SQL Server (DS 6.1
Populated seed): the 7 tables identical to the DMS PostgreSQL DS 6.1 views (same counts as above,
no order-only arrays); `compare-api.js ods-vs-dms` against the live ODS DS 6.1 stack, 300 requests,
0 differences; `dms-vs-recording` against the PostgreSQL DS 6.1 recording, 150 requests, 0
differences; Bruno 67 requests 264/264 and 14 requests 20/20.

