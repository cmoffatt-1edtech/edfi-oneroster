-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional) on DMS. Same output as
-- standard/6.1.0/artifacts/pgsql/core/assessment_offerings.sql: one offering per Ed-Fi
-- AssessmentAdministration, offered by its assigning organization. Periods are a collection of the
-- administration document; participations are documents of their own.
-- Mapping: docs/design/assessment-rostering-mappings.md
drop index if exists oneroster12.assessmentofferings_sourcedid;
drop index if exists oneroster12.assessmentofferings_assessmentsourcedid;
drop materialized view if exists oneroster12.assessmentofferings;
--
create materialized view if not exists oneroster12.assessmentofferings as
with administration as (
    -- Key parts for sourcedIds: lower case, then '\' and '|' escaped
    select
        aa.*,
        replace(replace(lower(aa."Assessment_Namespace"), '\', '\\'), '|', '\|') as k_namespace,
        replace(replace(lower(aa."Assessment_AssessmentIdentifier"), '\', '\\'), '|', '\|') as k_assessmentidentifier,
        replace(replace(lower(aa."AdministrationIdentifier"), '\', '\\'), '|', '\|') as k_administrationidentifier
    from edfi."AssessmentAdministration" aa
),
published_orgs as (
    -- The organizations the orgs view publishes; a reference to any other is left null
    select "SchoolId" as educationorganizationid from edfi."School"
    union
    select "LocalEducationAgencyId" from edfi."LocalEducationAgency"
    union
    select "StateEducationAgencyId" from edfi."StateEducationAgency"
),
windows as (
    -- One window per Ed-Fi period, never merged; an open-ended window keeps a null end date
    select
        p."AssessmentAdministration_DocumentId" as documentid,
        json_agg(
            json_build_object('startDate', p."AssessmentAdministrationBeginDate"::text, 'endDate', p."AssessmentAdministrationEndDate"::text)
            order by p."AssessmentAdministrationBeginDate", p."AssessmentAdministrationEndDate" nulls last
        ) as windows
    from edfi."AssessmentAdministrationPeriod" p
    group by p."AssessmentAdministration_DocumentId"
),
participation as (
    select
        p."AssessmentAdministration_DocumentId" as documentid,
        json_agg(
            json_strip_nulls(json_build_object(
                'educationOrganizationId', p."ParticipatingEducationOrganization_EducationOrganizationId",
                'org', case when participating_org.educationorganizationid is not null then json_build_object(
                    'href', concat('/orgs/', md5(p."ParticipatingEducationOrganization_EducationOrganizationId"::text)),
                    'sourcedId', md5(p."ParticipatingEducationOrganization_EducationOrganizationId"::text),
                    'type', 'org'
                ) end
            ))
            order by p."ParticipatingEducationOrganization_EducationOrganizationId"
        ) as organizations,
        max(p."ContentLastModifiedAt") as lastmodifieddate
    from edfi."AssessmentAdministrationParticipation" p
        left join published_orgs participating_org
            on participating_org.educationorganizationid = p."ParticipatingEducationOrganization_EducationOrganizationId"
    group by p."AssessmentAdministration_DocumentId"
)
select
    md5(concat(
        aa.k_namespace,
        '|', aa.k_assessmentidentifier,
        '|', aa."AssigningEducationOrganization_EducationOrganizationId"::text,
        '|', aa.k_administrationidentifier
    )) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi AssessmentAdministrations
    'active' as "status",
    (greatest(aa."ContentLastModifiedAt", participation.lastmodifieddate) at time zone 'UTC') as "dateLastModified",
    aa."AdministrationIdentifier" as "title",
    json_build_object(
        'href', concat('/assessments/', md5(concat(aa.k_namespace, '|', aa.k_assessmentidentifier))),
        'sourcedId', md5(concat(aa.k_namespace, '|', aa.k_assessmentidentifier)),
        'type', 'assessment'
    ) as "assessment",
    case when assigning_org.educationorganizationid is not null then json_build_object(
        'href', concat('/orgs/', md5(aa."AssigningEducationOrganization_EducationOrganizationId"::text)),
        'sourcedId', md5(aa."AssigningEducationOrganization_EducationOrganizationId"::text),
        'type', 'org'
    ) end as "org",
    coalesce(windows.windows, '[]'::json) as "testingWindows",
    -- Ed-Fi links sections to the assessment, not the administration (open question Q4)
    null::json as "class",
    -- Ed-Fi administrations have no academic session (open question Q5)
    null::json as "academicSession",
    json_build_object(
        'edfi', json_strip_nulls(json_build_object(
            'resource', 'assessmentAdministrations',
            'naturalKey', json_build_object(
                'namespace', aa."Assessment_Namespace",
                'assessmentIdentifier', aa."Assessment_AssessmentIdentifier",
                'assigningEducationOrganizationId', aa."AssigningEducationOrganization_EducationOrganizationId",
                'administrationIdentifier', aa."AdministrationIdentifier"
            ),
            'participatingEducationOrganizations', participation.organizations
        ))
    ) as metadata,
    -- Sub-collection /assessments/{id}/assessmentOfferings
    md5(concat(aa.k_namespace, '|', aa.k_assessmentidentifier)) as "assessmentSourcedId"
from administration aa
    left join published_orgs assigning_org
        on assigning_org.educationorganizationid = aa."AssigningEducationOrganization_EducationOrganizationId"
    left join windows
        on windows.documentid = aa."DocumentId"
    left join participation
        on participation.documentid = aa."DocumentId";

create index if not exists assessmentofferings_sourcedid on oneroster12.assessmentofferings ("sourcedId");

-- Sub-collection lookups
create index if not exists assessmentofferings_assessmentsourcedid on oneroster12.assessmentofferings ("assessmentSourcedId");
