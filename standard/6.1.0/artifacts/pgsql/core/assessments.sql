-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional): one row per Ed-Fi Assessment.
-- Mapping: docs/design/assessment-rostering-mappings.md
drop index if exists oneroster12.assessments_sourcedid;
drop materialized view if exists oneroster12.assessments;
--
create materialized view if not exists oneroster12.assessments as
with assessment as (
    -- Key parts for sourcedIds: lower case, then '\' and '|' escaped, so that joining them with
    -- '|' can't make two different keys collide
    select
        a.*,
        replace(replace(lower(a.namespace), '\', '\\'), '|', '\|') as k_namespace,
        replace(replace(lower(a.assessmentidentifier), '\', '\\'), '|', '\|') as k_assessmentidentifier
    from edfi.assessment a
),
subjects as (
    -- Data Standard 6.1: one academic subject per assessment, published as an array of 0 or 1
    select
        a.namespace,
        a.assessmentidentifier,
        json_build_array(d.codevalue) as subjects
    from edfi.assessment a
        join edfi.descriptor d
            on d.descriptorid = a.academicsubjectdescriptorid
),
grades as (
    -- Grade level code values, as users.grades
    select
        g.namespace,
        g.assessmentidentifier,
        json_agg(d.codevalue order by d.codevalue) as grades
    from edfi.assessmentassessedgradelevel g
        join edfi.descriptor d
            on d.descriptorid = g.gradeleveldescriptorid
    group by g.namespace, g.assessmentidentifier
),
published_orgs as (
    -- The organizations the orgs view publishes; a reference to any other is left null
    select schoolid as educationorganizationid from edfi.school
    union
    select localeducationagencyid from edfi.localeducationagency
    union
    select stateeducationagencyid from edfi.stateeducationagency
)
select
    md5(concat(a.k_namespace, '|', a.k_assessmentidentifier)) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi Assessments
    'active' as "status",
    a.lastmodifieddate as "dateLastModified",
    a.assessmenttitle as "title",
    a.assessmentidentifier as "identifier",
    a.assessmentversion::text as "version",
    category.codevalue as "category",
    coalesce(subjects.subjects, '[]'::json) as "subjects",
    coalesce(grades.grades, '[]'::json) as "grades",
    case when defining_org.educationorganizationid is not null then json_build_object(
        'href', concat('/orgs/', md5(a.educationorganizationid::text)),
        'sourcedId', md5(a.educationorganizationid::text),
        'type', 'org'
    ) end as "org",
    -- Ed-Fi has no course link for an assessment
    null::json as "course",
    json_build_object(
        'edfi', json_strip_nulls(json_build_object(
            'resource', 'assessments',
            'naturalKey', json_build_object(
                'namespace', a.namespace,
                'assessmentIdentifier', a.assessmentidentifier
            ),
            'educationOrganizationId', a.educationorganizationid,
            'assessmentFamily', a.assessmentfamily,
            'assessmentForm', a.assessmentform,
            'revisionDate', a.revisiondate,
            'adaptiveAssessment', a.adaptiveassessment
        ))
    ) as metadata,
    -- Authorization: the defining organization, kept when the org reference is null
    a.educationorganizationid as "definingEducationOrganizationId"
from assessment a
    left join edfi.descriptor category
        on category.descriptorid = a.assessmentcategorydescriptorid
    left join subjects
        on subjects.namespace = a.namespace
        and subjects.assessmentidentifier = a.assessmentidentifier
    left join grades
        on grades.namespace = a.namespace
        and grades.assessmentidentifier = a.assessmentidentifier
    left join published_orgs defining_org
        on defining_org.educationorganizationid = a.educationorganizationid;

create index if not exists assessments_sourcedid on oneroster12.assessments ("sourcedId");
