-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.orgs on DMS. Same output as standard/6.1.0/artifacts/pgsql/core/orgs.sql; DMS has no
-- edfi.EducationOrganization base table, so names come from the School, LocalEducationAgency and
-- StateEducationAgency tables directly.
drop index if exists oneroster12.orgs_sourcedid;
drop materialized view if exists oneroster12.orgs;
--
create materialized view if not exists oneroster12.orgs as
with schools as (
    select
        s."SchoolId" as schoolId,
        s."NameOfInstitution" as nameOfInstitution,
        s."LocalEducationAgency_LocalEducationAgencyId" as localEducationAgencyId,
        (s."ContentLastModifiedAt" at time zone 'UTC') as lastModifiedDate
    from edfi."School" s
),
leas as (
    select
        l."LocalEducationAgencyId" as localEducationAgencyId,
        l."NameOfInstitution" as nameOfInstitution,
        l."StateEducationAgency_StateEducationAgencyId" as stateEducationAgencyId,
        (l."ContentLastModifiedAt" at time zone 'UTC') as lastModifiedDate
    from edfi."LocalEducationAgency" l
),
seas as (
    select
        e."StateEducationAgencyId" as stateEducationAgencyId,
        e."NameOfInstitution" as nameOfInstitution,
        (e."ContentLastModifiedAt" at time zone 'UTC') as lastModifiedDate
    from edfi."StateEducationAgency" e
),
schools_formatted as (
    select
        md5(schools.schoolId::text) as "sourcedId",
        'active' as "status",
        lastModifiedDate as "dateLastModified",
        nameOfInstitution::text as "name",
        'school' as "type",
        schoolId::text as "identifier",
        case when localEducationAgencyId is not null then json_build_object(
            'href', concat('/orgs/', md5(localEducationAgencyId::text)),
            'sourcedId', md5(localEducationAgencyId::text),
            'type', 'org'
        ) else null end as "parent",
        null::json as "children",
        schoolId as "educationOrganizationId",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'schools',
                'naturalKey', json_build_object('schoolId', schoolId)
            )
        ) as metadata
    from schools
),
leas_formatted as (
    select
        md5(leas.localEducationAgencyId::text) as "sourcedId",
        'active' as "status",
        lastModifiedDate as "dateLastModified",
        nameOfInstitution::text as "name",
        'district' as "type",
        localEducationAgencyId::text as "identifier",
        case when stateEducationAgencyId is not null then json_build_object(
            'href', concat('/orgs/', md5(stateEducationAgencyId::text)),
            'sourcedId', md5(stateEducationAgencyId::text),
            'type', 'org'
        ) else null end as "parent",
        (
            select json_agg(
                json_build_object(
                    'href', concat('/orgs/', md5(s.schoolId::text)),
                    'sourcedId', md5(s.schoolId::text),
                    'type', 'org'
                )
                -- deterministic order so the array matches the MSSQL artifact
                order by s.schoolId
            )
            from schools s
            where s.localEducationAgencyId = leas.localEducationAgencyId
        ) as "children",
        localEducationAgencyId as "educationOrganizationId",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'localEducationAgencies',
                'naturalKey', json_build_object('localEducationAgencyId', localEducationAgencyId)
            )
        ) as metadata
    from leas
),
seas_formatted as (
    select
        md5(seas.stateEducationAgencyId::text) as "sourcedId",
        'active' as "status",
        lastModifiedDate as "dateLastModified",
        nameOfInstitution::text as "name",
        'state' as "type",
        stateEducationAgencyId::text as "identifier",
        null::json as "parent",
        (
            select json_agg(
                json_build_object(
                    'href', concat('/orgs/', md5(l.localEducationAgencyId::text)),
                    'sourcedId', md5(l.localEducationAgencyId::text),
                    'type', 'org'
                )
                -- deterministic order so the array matches the MSSQL artifact
                order by l.localEducationAgencyId
            )
            from leas l
            where l.stateEducationAgencyId = seas.stateEducationAgencyId
        ) as "children",
        stateEducationAgencyId as "educationOrganizationId",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'stateEducationAgencies',
                'naturalKey', json_build_object('stateEducationAgencyId', stateEducationAgencyId)
            )
        ) as metadata
    from seas
)
select * from schools_formatted
union all
select * from leas_formatted
union all
select * from seas_formatted;

-- Add an index so the materialized view can be refreshed _concurrently_:
create index if not exists orgs_sourcedid ON oneroster12.orgs ("sourcedId");

-- Authorization filters: org id lookups
create index if not exists orgs_educationorganizationid on oneroster12.orgs ("educationOrganizationId");
