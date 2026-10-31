# Assessment rostering: how the Ed-Fi data maps

A first draft of a OneRoster assessment rostering service over Ed-Fi assessment registration data
(Data Standard 5.2 and later). The 1EdTech service has no published name or version yet, so the
base path and the resource shapes are provisional. This page is what an engineer needs to work on the code.

## Switching it on

- `ASSESSMENT_ROSTERING_ENABLED=true` mounts the routes, adds the service to `/swagger.json`
  (`config/swagger-assessment-rostering.yml`) and to discovery (`urls.assessmentRosteringApi`), and
  adds the views to the PostgreSQL refresh jobs. Off by default; off, the service is unchanged.
- Base path: `/ims/oneroster/assessmentRostering/v1p0/`, one constant in
  `src/config/assessment-rostering.js`.
- Scopes: `roster.readonly` or `roster-core.readonly`, as for core rostering.
- A data store without the views (Data Standard 4.0, or not deployed) answers 404 "Assessment
  rostering is not available for this data store." on these endpoints only.

## Resources

| OneRoster | Ed-Fi | Endpoints |
| --- | --- | --- |
| `assessments` | Assessment | `/assessments`, `/assessments/{id}`, `/assessments/{id}/assessmentOfferings` |
| `assessmentOfferings` | AssessmentAdministration (one offering per administration, offered by the assigning organization) | `/assessmentOfferings`, `/assessmentOfferings/{id}`, `/assessmentOfferings/{id}/assessmentEnrollments` |
| `assessmentEnrollments` | StudentAssessmentRegistration (students only) | `/assessmentEnrollments`, `/assessmentEnrollments/{id}` |

A sub-collection answers 404 when its parent doesn't exist or isn't visible to the caller.

## Source tables

| Purpose | ODS/API (PostgreSQL lower case; SQL Server PascalCase) | DMS (DS 5.2) |
| --- | --- | --- |
| Assessment | `edfi.assessment` | `edfi."Assessment"` |
| Subjects | `edfi.assessmentacademicsubject` | `edfi."AssessmentAcademicSubject"` (collection of Assessment) |
| Grades | `edfi.assessmentassessedgradelevel` | `edfi."AssessmentAssessedGradeLevel"` (collection) |
| Administration | `edfi.assessmentadministration` | `edfi."AssessmentAdministration"` |
| Testing windows | `edfi.assessmentadministrationperiod` | `edfi."AssessmentAdministrationPeriod"` (collection) |
| Participating orgs | `edfi.assessmentadministrationparticipation` | `edfi."AssessmentAdministrationParticipation"` (own document) |
| Registration | `edfi.studentassessmentregistration` | `edfi."StudentAssessmentRegistration"` |
| Descriptors | `edfi.descriptor` | `dms."Descriptor"` |
| Published orgs | `edfi.school`, `localeducationagency`, `stateeducationagency` | the same three, PascalCase |

Platform notes:
- DMS registrations carry the school (`StudentSchoolAssociation_SchoolId`) and the student unique id,
  but not the student's `DocumentId`, which the authorization views return: the view joins the
  registration's `StudentSchoolAssociation` for it. The ODS registration has `studentusi` and
  `schoolid` on the row.
- None of the tables is hash-named on DMS, so the artifacts need no name-map entries. The
  point-of-contact and accommodation tables are hash-named; they are out of scope.
- Data Standard 6.1: the assessment has a single `academicSubjectDescriptor` (subjects is an array of
  0 or 1), the registration references a StudentDemographic instead of a
  StudentEducationOrganizationAssociation (same key columns), and assessment identifiers are up to
  120 characters.

## Views

Each data store gets three views plus a helper, in every artifact set that has assessment data
(`standard/<ds>/artifacts/{pgsql,mssql,dms-pgsql,dms-mssql}/core/assessment*.sql`):

| View | Hidden columns (not selectable or filterable) |
| --- | --- |
| `oneroster12.assessments` | `definingEducationOrganizationId` |
| `oneroster12.assessmentofferings` | `assessmentSourcedId` (sub-collection) |
| `oneroster12.assessmentenrollments` | `educationOrganizationId` (the registration's school), `participantUSI` / `participantDocumentId`, `assessmentOfferingSourcedId` (sub-collection) |
| `oneroster12.assessmentauthorgs` | the helper: one row per (assessment, offering, organization, role), role `defining`, `assigning`, `participating` or `registration`; `sourcedId` is a row key for the parity tools |

Rules every artifact set follows:
- No view reads another, so the drop-and-recreate deploy and the refresh order don't matter.
- `subjects`, `grades` and `testingWindows` are always arrays, `[]` when empty, in a fixed order
  (code value; start date, then end date with nulls last). A testing window is `{startDate, endDate}`,
  with `endDate` null when open-ended. Windows are never merged.
- An org reference (`assessment.org`, `assessmentOffering.org`, the participating, testing and
  reporting orgs in metadata) is a GUIDRef only when the organization is a school, district or state,
  the ones the orgs endpoint publishes. Otherwise the reference is left out and the Ed-Fi id stays in
  metadata.
- `metadata.edfi` holds `resource`, the Ed-Fi `naturalKey`, and the Ed-Fi values with no OneRoster
  field (null values left out).
- `dateLastModified` of an offering is the later of the administration and its participation rows;
  periods restamp the administration on both platforms.
- `role` is always `student`. Ed-Fi registrations have no dates, so `beginDate` and `endDate` are
  absent. `class` and `academicSession` on offerings and `course` on assessments are absent: Ed-Fi has
  no source (open questions Q4 and Q5).
- `href`s use the existing relative form: `/assessments/<id>`, `/assessmentOfferings/<id>`, and for
  rostering resources `/users/<id>`, `/orgs/<id>`, which resolve against the rostering base path.

## sourcedIds

New resources: `md5` of the natural-key parts joined with `|`, each string part lower-cased and then
escaped (`\` to `\\`, `|` to `\|`), so that no two keys produce the same input. Numbers are written as
they are. Both engines hash the UTF-8 bytes, so a non-ASCII key gets the same id on PostgreSQL and SQL
Server (the rostering views on SQL Server hash `VARCHAR`, which differs for non-ASCII keys).

| Resource | Key | Grand Bend example |
| --- | --- | --- |
| assessment | namespace, assessmentIdentifier | `942f89174d3829db3412893c78f6b4e0` |
| assessmentOffering | + assigningEducationOrganizationId, administrationIdentifier | `50f7682c5b6ac5078efa3fb97df56acb` |
| assessmentEnrollment | + educationOrganizationId, studentUniqueId | `9d8dbd5010a90daca58f4e3e3bf31173` |

References to users and orgs keep the existing formulas: `md5('STU-' + studentUniqueId + '-' +
schoolId)` and `md5(educationOrganizationId)`. Lower-casing means two keys that differ only in case
share an id; the parity tools check ids are unique per view.

## Authorization

Same mechanism as the rostering endpoints (`AuthorizationQueryService`): the caller's ed-org claims,
the Ed-Fi `auth` hierarchy, and the hidden columns. The three endpoints are in `AUTH_ENDPOINTS`, so a
caller who reaches every served organization skips filtering and an endpoint without a filter fails
closed.

For claimed ed-orgs C: Down(C) is C and everything below it; Up(C) everything above it (the courses
rule); Reach(C) = Down(C) ∪ Up(C).

| Resource | Visible when |
| --- | --- |
| assessmentEnrollments | The registration's school is in Down(C) and the student is related to C. Testing and reporting organizations never widen access. |
| assessmentOfferings | Any of its organizations (assigning, participating, registration schools) is in Reach(C). |
| assessments | No defining organization (Ed-Fi authorizes assessment metadata by namespace, not ed-org), or any of its organizations (defining, or any organization of any of its offerings) is in Reach(C). |

So a school sees the sitting its district assigned, and every enrollment a caller sees points at an
offering, user and school it can also read (an org above the caller is the one exception, as for
`courses.org`).

## Refresh

- PostgreSQL: materialized views; the pg-boss jobs refresh them when the flag is on and skip a data
  store without them. On DMS, change tracking skips a view whose sources haven't changed: a
  registration change refreshes `assessmentenrollments` and the helper; a participation change
  `assessmentofferings` and the helper.
- SQL Server: tables filled by `oneroster12.sp_refresh_<view>`, run by `sp_refresh_all` (the Agent
  job) after the rostering tables.

## Tests

- Unit: `tests/unit-tests/assessment-rostering-*.test.js`, `swagger-document*.test.js`.
- Synthetic data: `tests/dms-parity-fixture.js` (assessment data, a second district, a service
  center outside `orgs`), checked by `tests/compare-dms-fixture.sh` on both platforms and by
  `tests/assessment-auth-matrix.sh`, which runs the query service per caller against
  `ASSESSMENT_VISIBILITY` in a rolled-back transaction.
- Parity: `compare-dms-database.sh` and `compare-dms-engines.js` include the views;
  `compare-api.js ods-vs-dms | dms-record --assessment-rostering`.
- Bruno: `tests/bruno/tests-assessment` with `environments/assessment-ods.bru` or
  `assessment-dms.bru` (needs a client for school 255901001).

## End-user docs to update (Ed-Fi docs repo, not edited here)

Under `docs/reference/11-oneroster/` in `Ed-Fi-Alliance-OSS/ed-fi-alliance-oss.github.io` (the
repository's CLAUDE.md still names the old `3-oneroster` folder):

- `configuration/environment-variables.md`: `ASSESSMENT_ROSTERING_ENABLED`.
- `configuration/oauth-and-jwt.md`: the assessment endpoints take `roster.readonly` or
  `roster-core.readonly`.
- `data-model/endpoint-source-mapping.md`: the three resources and their Ed-Fi sources.
- `data-model/organization-mapping.md`: org references left out for organizations the orgs endpoint
  doesn't publish, with the Ed-Fi id in metadata.
- `conformance.md`: the service is provisional and not part of OneRoster 1.2 conformance.
- `getting-started/deploy-postgres.md`, `deploy-mssql.md`: the new artifacts deploy with the rest
  on Data Standard 5.2 and 6.1; Data Standard 4.0 has none.

## Out of scope in this draft

Teacher and proctor enrollments (no core Ed-Fi source), battery parts, accommodations and
customizations, the participating organization's point of contact, and class or academic session
links. Each is a later addition that doesn't change any published id.
