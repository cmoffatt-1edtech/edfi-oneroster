-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional) on DMS. Same output as
-- standard/6.1.0/artifacts/pgsql/core/assessment_auth_orgs.sql: the organizations each assessment
-- and offering is tied to, one row per (assessment, offering, organization, role). Not an endpoint:
-- the assessments and assessmentOfferings authorization filters read it.
drop index if exists oneroster12.assessmentauthorgs_sourcedid;
drop index if exists oneroster12.assessmentauthorgs_educationorganizationid;
drop materialized view if exists oneroster12.assessmentauthorgs;
--
create materialized view if not exists oneroster12.assessmentauthorgs as
with organizations as (
    -- defining: the assessment's own organization (no offering)
    select a."Namespace" as namespace, a."AssessmentIdentifier" as assessmentidentifier,
        null::bigint as assigningeducationorganizationid, null::varchar as administrationidentifier,
        a."EducationOrganization_EducationOrganizationId" as educationorganizationid, 'defining' as orgrole
    from edfi."Assessment" a
    where a."EducationOrganization_EducationOrganizationId" is not null
    union all
    -- assigning: the organization an offering belongs to
    select aa."Assessment_Namespace", aa."Assessment_AssessmentIdentifier", aa."AssigningEducationOrganization_EducationOrganizationId",
        aa."AdministrationIdentifier", aa."AssigningEducationOrganization_EducationOrganizationId", 'assigning'
    from edfi."AssessmentAdministration" aa
    union all
    -- participating: schools and districts taking part
    select p."AssessmentAdministration_Namespace", p."AssessmentAdministration_AssessmentIdentifier",
        p."AssessmentAdministration_AssigningEducationOrganizationId", p."AssessmentAdministration_AdministrationIdentifier",
        p."ParticipatingEducationOrganization_EducationOrganizationId", 'participating'
    from edfi."AssessmentAdministrationParticipation" p
    union all
    -- registration: schools with a student registered, so every visible enrollment's offering is visible
    select distinct r."AssessmentAdministration_Namespace", r."AssessmentAdministration_AssessmentIdentifier",
        r."AssessmentAdministration_AssigningEducationOrganizationId", r."AssessmentAdministration_AdministrationIdentifier",
        r."StudentSchoolAssociation_SchoolId", 'registration'
    from edfi."StudentAssessmentRegistration" r
),
rows as (
    select
        md5(concat(
            replace(replace(lower(o.namespace), '\', '\\'), '|', '\|'),
            '|', replace(replace(lower(o.assessmentidentifier), '\', '\\'), '|', '\|')
        )) as assessment_sourcedid,
        case when o.administrationidentifier is not null then md5(concat(
            replace(replace(lower(o.namespace), '\', '\\'), '|', '\|'),
            '|', replace(replace(lower(o.assessmentidentifier), '\', '\\'), '|', '\|'),
            '|', o.assigningeducationorganizationid::text,
            '|', replace(replace(lower(o.administrationidentifier), '\', '\\'), '|', '\|')
        )) end as offering_sourcedid,
        o.educationorganizationid::bigint as educationorganizationid,
        o.orgrole
    from organizations o
)
select
    -- A row key for the parity tools, not a OneRoster id
    md5(concat(assessment_sourcedid, '|', coalesce(offering_sourcedid, ''), '|', educationorganizationid::text, '|', orgrole)) as "sourcedId",
    assessment_sourcedid as "assessmentSourcedId",
    offering_sourcedid as "assessmentOfferingSourcedId",
    educationorganizationid as "educationOrganizationId",
    orgrole as "orgRole"
from rows;

create index if not exists assessmentauthorgs_sourcedid on oneroster12.assessmentauthorgs ("sourcedId");

-- Authorization filters: org id lookups
create index if not exists assessmentauthorgs_educationorganizationid on oneroster12.assessmentauthorgs ("educationOrganizationId");
