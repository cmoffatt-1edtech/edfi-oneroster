-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional) on DMS. Same output as standard/6.1.0/artifacts/pgsql/core/assessments.sql:
-- one row per Ed-Fi Assessment. Subjects and grades are collections of the Assessment document, so
-- its "ContentLastModifiedAt" covers them. Mapping: docs/design/assessment-rostering-mappings.md
drop index if exists oneroster12.assessments_sourcedid;
drop materialized view if exists oneroster12.assessments;
--
create materialized view if not exists oneroster12.assessments as
with assessment as (
    -- Key parts for sourcedIds: lower case, then '\' and '|' escaped, so that joining them with
    -- '|' can't make two different keys collide
    select
        a.*,
        replace(replace(lower(a."Namespace"), '\', '\\'), '|', '\|') as k_namespace,
        replace(replace(lower(a."AssessmentIdentifier"), '\', '\\'), '|', '\|') as k_assessmentidentifier
    from edfi."Assessment" a
),
subjects as (
    -- Data Standard 6.1: one academic subject per assessment, published as an array of 0 or 1
    select
        a."DocumentId" as documentid,
        json_build_array(d."CodeValue") as subjects
    from edfi."Assessment" a
        join dms."Descriptor" d
            on d."DescriptorId" = a."AcademicSubjectDescriptor_DescriptorId"
),
grades as (
    -- Grade level code values, as users.grades
    select
        g."Assessment_DocumentId" as documentid,
        json_agg(d."CodeValue" order by d."CodeValue" collate "C") as grades
    from edfi."AssessmentAssessedGradeLevel" g
        join dms."Descriptor" d
            on d."DescriptorId" = g."GradeLevelDescriptor_DescriptorId"
    group by g."Assessment_DocumentId"
),
published_orgs as (
    -- The organizations the orgs view publishes; a reference to any other is left null
    select "SchoolId" as educationorganizationid from edfi."School"
    union
    select "LocalEducationAgencyId" from edfi."LocalEducationAgency"
    union
    select "StateEducationAgencyId" from edfi."StateEducationAgency"
)
select
    md5(concat(a.k_namespace, '|', a.k_assessmentidentifier)) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi Assessments
    'active' as "status",
    (a."ContentLastModifiedAt" at time zone 'UTC') as "dateLastModified",
    a."AssessmentTitle" as "title",
    a."AssessmentIdentifier" as "identifier",
    a."AssessmentVersion"::text as "version",
    category."CodeValue" as "category",
    coalesce(subjects.subjects, '[]'::json) as "subjects",
    coalesce(grades.grades, '[]'::json) as "grades",
    case when defining_org.educationorganizationid is not null then json_build_object(
        'href', concat('/orgs/', md5(a."EducationOrganization_EducationOrganizationId"::text)),
        'sourcedId', md5(a."EducationOrganization_EducationOrganizationId"::text),
        'type', 'org'
    ) end as "org",
    -- Ed-Fi has no course link for an assessment
    null::json as "course",
    json_build_object(
        'edfi', json_strip_nulls(json_build_object(
            'resource', 'assessments',
            'naturalKey', json_build_object(
                'namespace', a."Namespace",
                'assessmentIdentifier', a."AssessmentIdentifier"
            ),
            'educationOrganizationId', a."EducationOrganization_EducationOrganizationId",
            'assessmentFamily', a."AssessmentFamily",
            'assessmentForm', a."AssessmentForm",
            'revisionDate', a."RevisionDate",
            'adaptiveAssessment', a."AdaptiveAssessment"
        ))
    ) as metadata,
    -- Authorization: the defining organization, kept when the org reference is null
    a."EducationOrganization_EducationOrganizationId" as "definingEducationOrganizationId"
from assessment a
    left join dms."Descriptor" category
        on category."DescriptorId" = a."AssessmentCategoryDescriptor_DescriptorId"
    left join subjects
        on subjects.documentid = a."DocumentId"
    left join grades
        on grades.documentid = a."DocumentId"
    left join published_orgs defining_org
        on defining_org.educationorganizationid = a."EducationOrganization_EducationOrganizationId";

create index if not exists assessments_sourcedid on oneroster12.assessments ("sourcedId");
