-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional): one student enrollment per Ed-Fi
-- StudentAssessmentRegistration. Ed-Fi registers students only.
-- Mapping: docs/design/assessment-rostering-mappings.md
drop index if exists oneroster12.assessmentenrollments_sourcedid;
drop index if exists oneroster12.assessmentenrollments_educationorganizationid;
drop index if exists oneroster12.assessmentenrollments_participantusi;
drop index if exists oneroster12.assessmentenrollments_assessmentofferingsourcedid;
drop materialized view if exists oneroster12.assessmentenrollments;
--
create materialized view if not exists oneroster12.assessmentenrollments as
with registration as (
    -- Key parts for sourcedIds: lower case, then '\' and '|' escaped
    select
        r.*,
        student.studentuniqueid,
        replace(replace(lower(r.namespace), '\', '\\'), '|', '\|') as k_namespace,
        replace(replace(lower(r.assessmentidentifier), '\', '\\'), '|', '\|') as k_assessmentidentifier,
        replace(replace(lower(r.administrationidentifier), '\', '\\'), '|', '\|') as k_administrationidentifier,
        replace(replace(lower(student.studentuniqueid), '\', '\\'), '|', '\|') as k_studentuniqueid
    from edfi.studentassessmentregistration r
        join edfi.student
            on student.studentusi = r.studentusi
),
registration_keyed as (
    select
        r.*,
        md5(concat(
            r.k_namespace,
            '|', r.k_assessmentidentifier,
            '|', r.assigningeducationorganizationid::text,
            '|', r.k_administrationidentifier
        )) as offering_sourcedid,
        md5(concat('STU-', r.studentuniqueid::text, '-', r.schoolid::text)) as user_sourcedid
    from registration r
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
    md5(concat(
        r.k_namespace,
        '|', r.k_assessmentidentifier,
        '|', r.assigningeducationorganizationid::text,
        '|', r.k_administrationidentifier,
        '|', r.educationorganizationid::text,
        '|', r.k_studentuniqueid
    )) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi StudentAssessmentRegistrations
    'active' as "status",
    r.lastmodifieddate as "dateLastModified",
    json_build_object(
        'href', concat('/users/', r.user_sourcedid),
        'sourcedId', r.user_sourcedid,
        'type', 'user'
    ) as "user",
    json_build_object(
        'href', concat('/assessmentOfferings/', r.offering_sourcedid),
        'sourcedId', r.offering_sourcedid,
        'type', 'assessmentOffering'
    ) as "assessmentOffering",
    json_build_object(
        'href', concat('/orgs/', md5(r.schoolid::text)),
        'sourcedId', md5(r.schoolid::text),
        'type', 'org'
    ) as "school",
    'student' as "role",
    -- Ed-Fi registrations have no dates
    null::text as "beginDate",
    null::text as "endDate",
    json_build_object(
        'edfi', json_strip_nulls(json_build_object(
            'resource', 'studentAssessmentRegistrations',
            'naturalKey', json_build_object(
                'namespace', r.namespace,
                'assessmentIdentifier', r.assessmentidentifier,
                'assigningEducationOrganizationId', r.assigningeducationorganizationid,
                'administrationIdentifier', r.administrationidentifier,
                'educationOrganizationId', r.educationorganizationid,
                'studentUniqueId', r.studentuniqueid
            ),
            'assessmentGradeLevel', grade.codevalue,
            'platformType', platform.codevalue,
            'testingEducationOrganization', case when r.testingeducationorganizationid is not null then json_build_object(
                'educationOrganizationId', r.testingeducationorganizationid,
                'org', case when testing_org.educationorganizationid is not null then json_build_object(
                    'href', concat('/orgs/', md5(r.testingeducationorganizationid::text)),
                    'sourcedId', md5(r.testingeducationorganizationid::text),
                    'type', 'org'
                ) end
            ) end,
            'reportingEducationOrganization', case when r.reportingeducationorganizationid is not null then json_build_object(
                'educationOrganizationId', r.reportingeducationorganizationid,
                'org', case when reporting_org.educationorganizationid is not null then json_build_object(
                    'href', concat('/orgs/', md5(r.reportingeducationorganizationid::text)),
                    'sourcedId', md5(r.reportingeducationorganizationid::text),
                    'type', 'org'
                ) end
            ) end
        ))
    ) as metadata,
    -- Authorization: the school of the registration's StudentSchoolAssociation, and the student
    r.schoolid as "educationOrganizationId",
    r.studentusi as "participantUSI",
    -- Sub-collection /assessmentOfferings/{id}/assessmentEnrollments
    r.offering_sourcedid as "assessmentOfferingSourcedId"
from registration_keyed r
    left join edfi.descriptor grade
        on grade.descriptorid = r.assessmentgradeleveldescriptorid
    left join edfi.descriptor platform
        on platform.descriptorid = r.platformtypedescriptorid
    left join published_orgs testing_org
        on testing_org.educationorganizationid = r.testingeducationorganizationid
    left join published_orgs reporting_org
        on reporting_org.educationorganizationid = r.reportingeducationorganizationid;

create index if not exists assessmentenrollments_sourcedid on oneroster12.assessmentenrollments ("sourcedId");

-- Authorization filters: org and participant lookups
create index if not exists assessmentenrollments_educationorganizationid on oneroster12.assessmentenrollments ("educationOrganizationId");
create index if not exists assessmentenrollments_participantusi on oneroster12.assessmentenrollments ("participantUSI");

-- Sub-collection lookups
create index if not exists assessmentenrollments_assessmentofferingsourcedid on oneroster12.assessmentenrollments ("assessmentOfferingSourcedId");
