-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.classes on DMS. Same output as standard/6.1.0/artifacts/pgsql/core/classes.sql: one
-- class per Ed-Fi Section, keyed with the school year. The ODS joins Section to CourseOffering and
-- SectionClassPeriod on the five-part section key; here they are DocumentId equalities
-- (CourseOffering_DocumentId, Section_DocumentId), which identify the same rows. The ODS inner join
-- from CourseOffering to School only carried an unused LEA id (every offering references a school),
-- so it is left out.
drop index if exists oneroster12.classes_sourcedid;
drop materialized view if exists oneroster12.classes;
--
create materialized view if not exists oneroster12.classes as
with section as (
    select
        sec."DocumentId" as sectiondocumentid,
        sec."CourseOffering_DocumentId" as courseofferingdocumentid,
        sec."CourseOffering_LocalCourseCode" as localcoursecode,
        sec."CourseOffering_SchoolReferenceSchoolId" as schoolid,
        sec."CourseOffering_SchoolYear" as schoolyear,
        sec."SectionIdentifier" as sectionidentifier,
        sec."CourseOffering_SessionName" as sessionname,
        sec."LocationLocation_ClassroomIdentificationCode" as locationclassroomidentificationcode,
        (sec."ContentLastModifiedAt" at time zone 'UTC') as lastmodifieddate
    from edfi."Section" sec
),
courseoffering as (
    select
        off."DocumentId" as courseofferingdocumentid,
        off."LocalCourseTitle" as localcoursetitle,
        off."Course_EducationOrganizationId" as educationOrganizationId,
        off."Course_CourseCode" as courseCode
    from edfi."CourseOffering" off
),
periods as (
    -- one row per section (Section_DocumentId is the full section key:
    -- sectionIdentifier, localCourseCode, schoolId, schoolYear, sessionName)
    select
        "Section_DocumentId" as sectiondocumentid,
        jsonb_agg(distinct "ClassPeriod_ClassPeriodName") as periods
    from edfi."SectionClassPeriod"
    group by "Section_DocumentId"
),
-- property documentation at
-- https://www.imsglobal.org/sites/default/files/spec/oneroster/v1p2/rostering-restbinding/OneRosterv1p2RosteringService_RESTBindv1p0.html#Main6p6p2
classes as (
    select
        md5(concat(
            lower(section.localcoursecode)::varchar,
            '-', section.schoolid::varchar,
            '-', section.schoolyear::varchar,
            '-', lower(section.sectionidentifier)::varchar,
            '-', lower(section.sessionname)::varchar)
        ) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi Sections (incl. SchoolYear)
        'active' as "status",
        section.lastmodifieddate as "dateLastModified",
        case
            when courseoffering.localcoursetitle is null then ''
            else courseoffering.localcoursetitle
        end as "title",
        section.localcoursecode as "classCode",
        'scheduled' as "classType",
        section.locationclassroomidentificationcode as "location",
        null as "grades",
        null as "subjects",
        json_build_object(
            'href', concat('/courses/', md5(concat(
                courseoffering.educationOrganizationId::varchar,
                '-', courseoffering.courseCode::varchar
            ))),
            'sourcedId', md5(concat(
                courseoffering.educationOrganizationId::varchar,
                '-', courseoffering.courseCode::varchar)
            ),  -- unique ID constructed from natural key of Ed-Fi Courses
            'type', 'course'
        ) as "course",
        json_build_object(
            'href', concat('/orgs/', md5(section.schoolid::varchar)),
            'sourcedId', md5(
                section.schoolid::varchar
            ),  -- unique ID constructed from natural key of Ed-Fi Schools
            'type', 'org'
        ) as "school",
        jsonb_build_array(json_build_object(
            'href', concat('/academicSessions/', md5(concat(
                section.schoolid::varchar,
                '-', section.schoolyear::varchar,
                '-', section.sessionname::varchar
            ))),
            'sourcedId', md5(concat(
                section.schoolid::varchar,
                '-', section.schoolyear::varchar,
                '-', section.sessionname::varchar)
            ), -- unique ID constructed from natural key of Ed-Fi Sessions
            'type', 'academicSession'
        )) as "terms",
        null as "subjectCodes",
        periods.periods as "periods",
        null as resources,
        section.schoolid as "educationOrganizationId",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'sections',
                'naturalKey', json_build_object(
                    'localCourseCode', section.localcoursecode,
                    'schoolid', section.schoolid,
                    'sectionIdentifier', section.sectionidentifier,
                    'sessionName', section.sessionname
                )
            )
        ) AS metadata
    from section
        join courseoffering
            on section.courseofferingdocumentid = courseoffering.courseofferingdocumentid
        left join periods
            on section.sectiondocumentid = periods.sectiondocumentid
)
select * from classes;

-- Add an index so the materialized view can be refreshed _concurrently_:
create index if not exists classes_sourcedid ON oneroster12.classes ("sourcedId");

-- Authorization filters: org id lookups
create index if not exists classes_educationorganizationid on oneroster12.classes ("educationOrganizationId");
