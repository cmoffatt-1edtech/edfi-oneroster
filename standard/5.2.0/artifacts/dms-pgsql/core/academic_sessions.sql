-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.academicsessions on DMS. Same output as standard/5.2.0/artifacts/pgsql/core/academic_sessions.sql:
-- one schoolYear session per LEA and school year (modal first/last instructional day across the
-- LEA's schools), plus one term per Ed-Fi Session whose parent is that LEA school year. The calendar
-- event join is a single CalendarDate_DocumentId equality instead of the ODS four-part key.
drop index if exists oneroster12.academicsessions_sourcedid;
drop materialized view if exists oneroster12.academicsessions;
--
create materialized view if not exists oneroster12.academicsessions as
with sessions as (
    select
        ses."School_SchoolId" as schoolid,
        ses."SchoolYear_SchoolYear" as schoolyear,
        ses."SessionName" as sessionname,
        ses."TermDescriptor_DescriptorId" as termdescriptorid,
        ses."BeginDate" as begindate,
        ses."EndDate" as enddate,
        (ses."ContentLastModifiedAt" at time zone 'UTC') as lastmodifieddate,
        sch."LocalEducationAgency_LocalEducationAgencyId" as localEducationAgencyId
    from edfi."Session" ses
        join edfi."School" sch
            on ses."School_DocumentId" = sch."DocumentId"
),
calendar_windows as (
    select
        cd."Calendar_SchoolId" as schoolid,
        cd."Calendar_SchoolYear" as schoolyear,
        cd."Calendar_CalendarCode" as calendarcode,
        min(cd."Date") as first_school_day,
        max(cd."Date") as last_school_day,
        array_agg(distinct eventdescriptor."CodeValue") as eventdescriptors
    from edfi."CalendarDate" cd
        join edfi."CalendarDateCalendarEvent" cdce
            on cdce."CalendarDate_DocumentId" = cd."DocumentId"
        join dms."Descriptor" eventdescriptor
            on cdce."CalendarEventDescriptor_DescriptorId" = eventdescriptor."DescriptorId"
        join edfi."DescriptorMapping" mappedeventdescriptor
            on mappedeventdescriptor."Value" = eventdescriptor."CodeValue"
                and mappedeventdescriptor."Namespace" = eventdescriptor."Namespace"
                and mappedeventdescriptor."MappedNamespace" = 'uri://1edtech.org/oneroster12/CalendarEventDescriptor'
    where mappedeventdescriptor."MappedValue" = 'TRUE' -- IS a school/instructional day
    group by grouping sets (
        -- school level
        (cd."Calendar_SchoolId", cd."Calendar_SchoolYear"),
        (cd."Calendar_SchoolId", cd."Calendar_SchoolYear", cd."Calendar_CalendarCode")
    )
),
summarize_school_year as (
    -- school years are designed to be global in oneroster,
    -- but do not necessarily have uniform start/end days
    -- in the real world.
    -- As a compromise, we define school years by district
    -- and take the modal start/end day
    select
        sch."LocalEducationAgency_LocalEducationAgencyId" as localEducationAgencyId,
        cal.schoolyear,
        mode() within group (order by first_school_day) as first_school_day,
        mode() within group (order by last_school_day) as last_school_day
    from calendar_windows cal
    join edfi."School" sch
        on cal.schoolid = sch."SchoolId"
    where calendarcode is null
    group by 1,2
),
create_school_year as (
    select
        md5(concat(ssy.localEducationAgencyId::varchar, '-', ssy.schoolyear::text)) as "sourcedId",
        'active' as "status",
        max(ses.lastmodifieddate) as "dateLastModified",
        concat(ssy.schoolyear - 1, '-', ssy.schoolyear) as "title",
        'schoolYear' as "type",
        ssy.first_school_day::date::text as "startDate",
        ssy.last_school_day::date::text as "endDate",
        null::json as "parent",
        ssy.schoolyear::text as "schoolYear",
        ssy.localEducationAgencyId as "educationOrganizationId",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'schoolYearTypes',
                'naturalKey', json_build_object(
                    'schoolYear', ssy.schoolyear
                ),
                'educationOrganizationId', ssy.localEducationAgencyId
            )
        ) as metadata
    from summarize_school_year ssy
    left join sessions ses
        on ses.schoolyear = ssy.schoolyear
        and ses.localEducationAgencyId = ssy.localEducationAgencyId
    group by ssy.localEducationAgencyId, ssy.schoolyear, ssy.first_school_day, ssy.last_school_day
),
sessions_formatted as (
    select
        md5(concat(
            schoolid::varchar,
            '-', schoolyear::varchar,
            '-', sessionname::varchar
        )) as "sourcedId",
        'active' as "status",
        sessions.lastmodifieddate as "dateLastModified",
        termdescriptor."CodeValue" as "title",
        mappedtermdescriptor."MappedValue" as "type",
        begindate::date::text as "startDate",
        enddate::date::text as "endDate",
        json_build_object(
            'href', concat('/academicSessions/', md5(concat(sessions.localEducationAgencyId::varchar, '-', schoolyear::text))),
            'sourcedId', md5(concat(sessions.localEducationAgencyId::varchar, '-', schoolyear::text)),
            'type', 'academicSession'
        ) as "parent",
        schoolyear::text as "schoolYear",
        sessions.schoolid as "educationOrganizationId",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'sessions',
                'naturalKey', json_build_object(
                    'schoolId', schoolid,
                    'sessionName', sessionname
                )
            )
        ) as metadata
    from sessions
        join dms."Descriptor" termdescriptor
            on sessions.termdescriptorid = termdescriptor."DescriptorId"
        join edfi."DescriptorMapping" mappedtermdescriptor
            on mappedtermdescriptor."Value" = termdescriptor."CodeValue"
                and mappedtermdescriptor."Namespace" = termdescriptor."Namespace"
                and mappedtermdescriptor."MappedNamespace" = 'uri://1edtech.org/oneroster12/TermDescriptor'
),
stacked as (
    select * from create_school_year
    union all
    select * from sessions_formatted
)
-- property documentation at
-- https://www.imsglobal.org/sites/default/files/spec/oneroster/v1p2/rostering-restbinding/OneRosterv1p2RosteringService_RESTBindv1p0.html#Main6p4p2
select * from stacked;

-- Add an index so the materialized view can be refreshed _concurrently_:
create index if not exists academicsessions_sourcedid ON oneroster12.academicsessions ("sourcedId");

-- Authorization filters: org id lookups
create index if not exists academicsessions_educationorganizationid on oneroster12.academicsessions ("educationOrganizationId");
