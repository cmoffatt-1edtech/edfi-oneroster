-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Phase 0 spike: the oneroster12.orgs projection written against the DMS relational schema
-- (DMS dms-pre-8.1.0-beta2.3, DS 5.2, PostgreSQL). A plain query, not a deploy artifact:
-- same columns, sourcedId formulas and JSON shapes as standard/5.2.0/artifacts/pgsql/core/orgs.sql.
-- Differences from the ODS version:
--   * no edfi.EducationOrganization base table: names live on School / LocalEducationAgency /
--     StateEducationAgency, so the base-table joins disappear;
--   * dateLastModified comes from "ContentLastModifiedAt" (timestamptz, UTC) instead of
--     the ODS lastmodifieddate (timestamp without time zone, UTC by convention).
with schools as (
    select
        s."SchoolId" as schoolId,
        s."NameOfInstitution" as nameOfInstitution,
        s."LocalEducationAgency_LocalEducationAgencyId" as localEducationAgencyId,
        s."ContentLastModifiedAt" as lastModifiedDate
    from edfi."School" s
),
leas as (
    select
        l."LocalEducationAgencyId" as localEducationAgencyId,
        l."NameOfInstitution" as nameOfInstitution,
        l."StateEducationAgency_StateEducationAgencyId" as stateEducationAgencyId,
        l."ContentLastModifiedAt" as lastModifiedDate
    from edfi."LocalEducationAgency" l
),
seas as (
    select
        e."StateEducationAgencyId" as stateEducationAgencyId,
        e."NameOfInstitution" as nameOfInstitution,
        e."ContentLastModifiedAt" as lastModifiedDate
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
