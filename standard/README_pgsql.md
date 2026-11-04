
# OneRoster 1.2 PostgreSQL Implementation

## 1. Configure Environment

Copy the example environment file and fill in your PostgreSQL connection details:

```bash
cp standard/.env.deploy.example standard/.env.deploy
```

Edit `standard/.env.deploy` and uncomment/fill in the PostgreSQL variables:

```ini
DB_HOST=localhost
DB_PORT=5432
DB_NAME=EdFi_Ods
DB_USER=postgres
DB_PASS=<your_db_password>
DB_SSL=false
PG_STATEMENT_TIMEOUT=120000
```

## 2. Deploy the Solution

### Option A: Automated Node.js Deployment (Recommended)

```bash
node standard/deploy-pgsql.js        # Deploy DS5 (default)
node standard/deploy-pgsql.js ds5    # Deploy DS5 explicitly
node standard/deploy-pgsql.js ds4    # Deploy DS4
```

> [!NOTE]
> SQL artifacts are organized under `standard/{version}/artifacts/pgsql/core/`.
> The deploy script executes files in numeric-prefix order automatically.

### Option B: Manual psql Execution

```bash
# DS5 (default)
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/00_setup.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/01_descriptors.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/02_descriptorMappings.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/academic_sessions.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/classes.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/courses.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/demographics.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/enrollments.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/orgs.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/users.sql
# Assessment rostering: Data Standard 5.2 and later only (leave these out on 5.0 and 5.1)
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/assessments.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/assessment_offerings.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/assessment_enrollments.sql
psql -U <username> -d <dbname> -f standard/5.2.0/artifacts/pgsql/core/assessment_auth_orgs.sql
```

Or concatenate and run as a single script (on Data Standard 5.0 and 5.1, leave out `assessment*.sql`):

```bash
cat standard/5.2.0/artifacts/pgsql/core/*.sql > oneroster12.sql
psql -U <username> -d <dbname> -f oneroster12.sql
```

`deploy-pgsql.js` leaves the assessment rostering files out by itself when the ODS has no Assessment
Registration tables (Data Standard before 5.2).

## 3. SQL Artifacts

This directory contains SQL that creates OneRoster 1.2 materialized views on Ed-Fi ODS tables.

* `00_setup.sql` — creates the `oneroster12` schema
* `01_descriptors.sql` — inserts OneRoster-namespaced descriptor values for Ed-Fi descriptors used in OneRoster data
* `02_descriptorMappings.sql` — inserts descriptor mappings from Ed-Fi default values to OneRoster-namespaced values
* `academic_sessions.sql` — builds `academicSessions` from Ed-Fi `sessions`, `schools`, and `schoolCalendars`
* `classes.sql` — builds `classes` from Ed-Fi `sections`, `courseOfferings`, and `schools`
* `courses.sql` — builds `courses` from Ed-Fi `courses`, `courseOfferings`, and `schools`
* `demographics.sql` — builds `demographics` from Ed-Fi `students` and `studentEdOrgAssn`
* `enrollments.sql` — builds `enrollments` from Ed-Fi `staffSectionAssn`, `studentSectionAssn`, and `sections`
* `orgs.sql` — builds `orgs` from Ed-Fi `schools`, `localEducationAgencies`, and `stateEducationAgencies`
* `users.sql` — builds `users` from Ed-Fi `staffs`, `schools`, `staffSectionAssociations`, `staffSchoolAssociations`, `students`, `studentSchoolAssociations`, and `studentEducationOrganizationAssociations`
* `assessments.sql`, `assessment_offerings.sql`, `assessment_enrollments.sql`, `assessment_auth_orgs.sql` — assessment rostering (provisional, `ASSESSMENT_ROSTERING_ENABLED`), from the Ed-Fi Assessment Registration domain (Data Standard 5.2 and later); see `docs/design/assessment-rostering-mappings.md`

This OneRoster 1.2 PostgreSQL implementation is based on the [OneRoster 1.1 Snowflake implementation](https://github.com/edanalytics/edu_ext_oneroster/tree/main/models/oneroster_1_1) in [EDU](https://enabledataunion.org/).
