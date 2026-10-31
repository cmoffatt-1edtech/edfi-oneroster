-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.courses on DMS. Same output as standard/5.2.0/artifacts/pgsql/core/courses.sql: one row
-- per Ed-Fi Course, with the latest offering school year found on the course natural key
-- (educationOrganizationId, courseCode), which CourseOffering carries as Course_* identity copies.
drop index if exists oneroster12.courses_sourcedid;
drop materialized view if exists oneroster12.courses;
--
create materialized view if not exists oneroster12.courses as
with course as (
    select
        c."EducationOrganization_EducationOrganizationId" as educationOrganizationId,
        c."CourseCode" as coursecode,
        c."CourseTitle" as coursetitle,
        c."DocumentId" as documentid,
        (c."ContentLastModifiedAt" at time zone 'UTC') as lastmodifieddate
    from edfi."Course" c
),
course_offerings as (
    -- one offering row per course (latest school year wins) so a course with
    -- offerings in multiple years still yields a single courses row. Keyed by
    -- the course natural key (org + code) so courses sharing a code across
    -- organizations don't pick up each other's offerings.
    select
        "Course_EducationOrganizationId" as educationorganizationid,
        "Course_CourseCode" as coursecode,
        max("Session_SchoolYear") as schoolyear
    from edfi."CourseOffering"
    group by "Course_EducationOrganizationId", "Course_CourseCode"
),
-- Optional course field (provisional, WS2 shortlist; ClassLink's metadata name): the state course
-- code, left out when Ed-Fi has none; ties go to the lowest by code point
state_codes as (
    select c."Course_DocumentId" as documentid, min(c."IdentificationCode" collate "C") as state_code
    from edfi."CourseIdentificationCode" c
        join dms."Descriptor" d on d."DescriptorId" = c."CourseIdentificationSystemDescriptor_DescriptorId" and d."CodeValue" = 'State course code'
    group by c."Course_DocumentId"
)
-- property documentation at
-- https://www.imsglobal.org/sites/default/files/spec/oneroster/v1p2/rostering-restbinding/OneRosterv1p2RosteringService_RESTBindv1p0.html#Main6p8p2
select
    md5(concat(
                crs.educationOrganizationId::varchar,
                '-', crs.courseCode::varchar
            )) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi Courses
    'active' as "status",
    crs.lastmodifieddate as "dateLastModified",
    crs.coursetitle as "title",
    CASE
        -- Only emit a schoolYear reference when the owner resolves to a School or an LEA:
        -- the academicsessions view only ever materializes schoolYear sessions per-LEA, so
        -- a course owned directly by a State Education Agency (or any other non-LEA org)
        -- has no matching academic session to reference.
        WHEN course_offerings.schoolyear IS NOT NULL
             AND (crs_school."LocalEducationAgency_LocalEducationAgencyId" IS NOT NULL
                  OR crs_lea."LocalEducationAgencyId" IS NOT NULL) THEN
            json_build_object(
                'href', concat('/academicSessions/', md5(concat(COALESCE(crs_school."LocalEducationAgency_LocalEducationAgencyId", crs.educationOrganizationId)::varchar, '-', course_offerings.schoolyear::text))),
                'sourcedId', md5(concat(COALESCE(crs_school."LocalEducationAgency_LocalEducationAgencyId", crs.educationOrganizationId)::varchar, '-', course_offerings.schoolyear::text)),
                'type', 'academicSession'
            )
        ELSE NULL
    END AS "schoolYear",
    crs.coursecode as "courseCode",
    null as "grades",
    null::varchar as "subjects",
    json_build_object(
        'href', concat('/orgs/', md5(crs.educationOrganizationId::text)),
        'sourcedId', md5(crs.educationOrganizationId::text),
        'type', 'org'
    ) as "org",
    -- required to be SCED codes, not generally available
    null as "subjectCodes",
    (jsonb_build_object(
        'edfi', jsonb_build_object(
            'resource', 'courses',
            'naturalKey', jsonb_build_object(
                'educationOrganizationId', crs.educationOrganizationId,
                'courseCode', crs.coursecode
            )
        )
    ) || jsonb_strip_nulls(jsonb_build_object('courseStateId', state_codes.state_code)))::json AS metadata,
    crs.educationOrganizationId as "educationOrganizationId"
from course crs
    left join state_codes
        on state_codes.documentid = crs.documentid
    left join course_offerings
        on crs.educationorganizationid = course_offerings.educationorganizationid
        and crs.coursecode = course_offerings.coursecode
    left join edfi."School" crs_school
        on crs.educationOrganizationId = crs_school."SchoolId"
    left join edfi."LocalEducationAgency" crs_lea
        on crs.educationOrganizationId = crs_lea."LocalEducationAgencyId";

-- Add an index so the materialized view can be refreshed _concurrently_:
create index if not exists courses_sourcedid ON oneroster12.courses ("sourcedId");

-- Authorization filters: org id lookups
create index if not exists courses_educationorganizationid on oneroster12.courses ("educationOrganizationId");
