-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.enrollments on DMS. Same output as standard/6.1.0/artifacts/pgsql/core/enrollments.sql.
-- StaffSectionAssociation and StudentSectionAssociation carry the full section identity
-- (Section_LocalCourseCode, Section_SchoolId, Section_SchoolYear, Section_SessionName,
-- Section_SectionIdentifier) and the person's unique id, so the ODS joins to section, staff and
-- student are not needed for any key, href or natural key. participantUSI becomes
-- participantDocumentId: the Staff_DocumentId / Student_DocumentId the auth views return.
drop index if exists oneroster12.enrollments_sourcedid;
drop materialized view if exists oneroster12.enrollments;
--
create materialized view oneroster12.enrollments as
with staff_section_associations as (
    select * from edfi."StaffSectionAssociation"
),
student_section_associations as (
    select * from edfi."StudentSectionAssociation"
),
staff_enrollments_formatted as (
    select
        md5(concat(
            'STA-', lower(ssa."Staff_StaffUniqueId")::varchar,
            '-', lower(ssa."Section_LocalCourseCode")::varchar,
            '-', ssa."Section_SchoolId"::varchar,
            '-', ssa."Section_SchoolYear"::varchar,
            '-', lower(ssa."Section_SectionIdentifier")::varchar,
            '-', lower(ssa."Section_SessionName")::varchar,
            '-', ssa."BeginDate"::varchar
        )) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi StaffSectionAssociations
        'active' as "status",
        (ssa."ContentLastModifiedAt" at time zone 'UTC') as "dateLastModified",
        json_build_object(
            'href', concat('/classes/', md5(concat(
                lower(ssa."Section_LocalCourseCode")::varchar,
                '-', ssa."Section_SchoolId"::varchar,
                '-', ssa."Section_SchoolYear"::varchar,
                '-', lower(ssa."Section_SectionIdentifier")::varchar,
                '-', lower(ssa."Section_SessionName")::varchar
            ))),
            'sourcedId', md5(concat(
                lower(ssa."Section_LocalCourseCode")::varchar,
                '-', ssa."Section_SchoolId"::varchar,
                '-', ssa."Section_SchoolYear"::varchar,
                '-', lower(ssa."Section_SectionIdentifier")::varchar,
                '-', lower(ssa."Section_SessionName")::varchar
            )),
            'type', 'class'
        ) as "class",
        json_build_object(
            'href', concat('/users/', md5(concat('STA-', ssa."Staff_StaffUniqueId"::text, '-', ssa."Section_SchoolId"::text))),
            'sourcedId', md5(concat('STA-', ssa."Staff_StaffUniqueId"::text, '-', ssa."Section_SchoolId"::text)),
            'type', 'user'
        ) as "user",
        json_build_object(
            'href', concat('/orgs/', md5(ssa."Section_SchoolId"::varchar)),
            'sourcedId', md5(ssa."Section_SchoolId"::varchar),
            'type', 'org'
        ) as "school",
        ssa."Section_SchoolId" as "educationOrganizationId",
        ssa."Staff_DocumentId" as "participantDocumentId",
        'teacher' as "role",
        -- primary is derived from the staff's ClassroomPositionDescriptor via the
        -- oneroster12/ClassroomPositionDescriptor crosswalk (e.g. 'Teacher of Record' => TRUE).
        -- Unmapped or missing positions default to 'false'.
        lower(coalesce(mappedclassroomposition."MappedValue", 'FALSE')) as "primary",
        ssa."BeginDate"::text as "beginDate",
        ssa."EndDate"::text as "endDate",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'staffSectionAssociations',
                'naturalKey', json_build_object(
                    'staffUniqueId', ssa."Staff_StaffUniqueId",
                    'localCourseCode', ssa."Section_LocalCourseCode",
                    'schoolId', ssa."Section_SchoolId",
                    'schoolYear', ssa."Section_SchoolYear",
                    'sectionIdentifier', ssa."Section_SectionIdentifier",
                    'sessionName', ssa."Section_SessionName",
                    'beginDate', ssa."BeginDate"
                )
            )
        ) AS metadata
    from staff_section_associations ssa
        left join dms."Descriptor" classroompositiondescriptor
            on ssa."ClassroomPositionDescriptor_DescriptorId" = classroompositiondescriptor."DescriptorId"
        left join edfi."DescriptorMapping" mappedclassroomposition
            on mappedclassroomposition."Value" = classroompositiondescriptor."CodeValue"
                and mappedclassroomposition."Namespace" = classroompositiondescriptor."Namespace"
                and mappedclassroomposition."MappedNamespace" = 'uri://1edtech.org/oneroster12/ClassroomPositionDescriptor'
),
student_enrollments_formatted as (
    select
        md5(concat(
            lower(ssa."Student_StudentUniqueId")::varchar,
            '-', lower(ssa."Section_LocalCourseCode")::varchar,
            '-', ssa."Section_SchoolId"::varchar,
            '-', ssa."Section_SchoolYear"::varchar,
            '-', lower(ssa."Section_SectionIdentifier")::varchar,
            '-', lower(ssa."Section_SessionName")::varchar,
            '-', ssa."BeginDate"::varchar
        )) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi StudentSectionAssociations
        'active' as "status",
        (ssa."ContentLastModifiedAt" at time zone 'UTC') as "dateLastModified",
        json_build_object(
            'href', concat('/classes/', md5(concat(
                lower(ssa."Section_LocalCourseCode")::varchar,
                '-', ssa."Section_SchoolId"::varchar,
                '-', ssa."Section_SchoolYear"::varchar,
                '-', lower(ssa."Section_SectionIdentifier")::varchar,
                '-', lower(ssa."Section_SessionName")::varchar
            ))),
            'sourcedId', md5(concat(
                lower(ssa."Section_LocalCourseCode")::varchar,
                '-', ssa."Section_SchoolId"::varchar,
                '-', ssa."Section_SchoolYear"::varchar,
                '-', lower(ssa."Section_SectionIdentifier")::varchar,
                '-', lower(ssa."Section_SessionName")::varchar
            )),
            'type', 'class'
        ) as "class",
        json_build_object(
            'href', concat('/users/', md5(concat('STU-', ssa."Student_StudentUniqueId"::text, '-', ssa."Section_SchoolId"::text))),
            'sourcedId', md5(concat('STU-', ssa."Student_StudentUniqueId"::text, '-', ssa."Section_SchoolId"::text)),
            'type', 'user'
        ) as "user",
        json_build_object(
            'href', concat('/orgs/', md5(ssa."Section_SchoolId"::varchar)),
            'sourcedId', md5(ssa."Section_SchoolId"::varchar),
            'type', 'org'
        ) as "school",
        ssa."Section_SchoolId" as "educationOrganizationId",
        ssa."Student_DocumentId" as "participantDocumentId",
        'student' as "role",
        'false' as "primary",
        ssa."BeginDate"::text as "beginDate",
        ssa."EndDate"::text as "endDate",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'studentSectionAssociations',
                'naturalKey', json_build_object(
                    'studentUniqueId', ssa."Student_StudentUniqueId",
                    'localCourseCode', ssa."Section_LocalCourseCode",
                    'schoolId', ssa."Section_SchoolId",
                    'schoolYear', ssa."Section_SchoolYear",
                    'sectionIdentifier', ssa."Section_SectionIdentifier",
                    'sessionName', ssa."Section_SessionName",
                    'beginDate', ssa."BeginDate"
                )
            )
        ) AS metadata
    from student_section_associations ssa
)
-- property documentation at
-- https://www.imsglobal.org/sites/default/files/spec/oneroster/v1p2/rostering-restbinding/OneRosterv1p2RosteringService_RESTBindv1p0.html#Main6p12p2
select * from staff_enrollments_formatted
union all
select * from student_enrollments_formatted;

create index enrollments_sourcedid ON oneroster12.enrollments ("sourcedId");

-- Authorization filters: org and participant lookups
create index if not exists enrollments_educationorganizationid on oneroster12.enrollments ("educationOrganizationId");
create index if not exists enrollments_participantdocumentid on oneroster12.enrollments ("participantDocumentId");
