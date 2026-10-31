-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

drop index if exists oneroster12.orgs_sourcedid;
drop materialized view if exists oneroster12.orgs;
--
create materialized view if not exists oneroster12.orgs as
with schools as (
    select
        school.*,
    	schoolOrg.*,
        leaOrg.id as leaId
    from edfi.school
        join edfi.educationOrganization schoolOrg
            on schoolOrg.educationOrganizationId = school.schoolId
        left join edfi.educationOrganization leaOrg
            on leaOrg.educationOrganizationId = school.localEducationAgencyId
),
leas as (
    select
        localEducationAgency.*,
        leaOrg.*,
        seaOrg.id as seaId
    from edfi.localEducationAgency
        join edfi.educationOrganization leaOrg
            on leaOrg.educationOrganizationId = localEducationAgency.localEducationAgencyId
        left join edfi.educationOrganization seaOrg
            on seaOrg.educationOrganizationId = localEducationAgency.stateEducationAgencyId
),
seas as (
    select
    	stateEducationAgency.*,
    	seaOrg.*
    from edfi.stateEducationAgency
    	join edfi.educationOrganization seaOrg
    		on seaOrg.educationOrganizationId = stateEducationAgency.stateEducationAgencyId
),
-- Optional org fields (provisional, WS2 shortlist; names as in ClassLink's metadata list): the NCES
-- and state identifiers, the physical address and the main phone. A key is left out when Ed-Fi has
-- no value; ties go to the lowest value by code point, the same on every engine.
org_codes as (
    select c.educationorganizationid,
        min(c.identificationcode collate "C") filter (where d.codevalue = 'NCES') as nces_id,
        min(c.identificationcode collate "C") filter (where d.codevalue = 'SEA') as state_id
    from edfi.educationorganizationidentificationcode c
        join edfi.descriptor d on d.descriptorid = c.educationorganizationidentificationsystemdescriptorid
    group by c.educationorganizationid
),
org_address as (
    select distinct on (a.educationorganizationid)
        a.educationorganizationid, a.streetnumbername, a.apartmentroomsuitenumber, a.city, s.codevalue as state, a.postalcode
    from edfi.educationorganizationaddress a
        join edfi.descriptor t on t.descriptorid = a.addresstypedescriptorid and t.codevalue = 'Physical'
        left join edfi.descriptor s on s.descriptorid = a.stateabbreviationdescriptorid
    order by a.educationorganizationid, a.streetnumbername collate "C", a.city collate "C", a.postalcode collate "C"
),
org_phone as (
    select p.educationorganizationid, min(p.telephonenumber collate "C") as phone
    from edfi.educationorganizationinstitutiontelephone p
        join edfi.descriptor d on d.descriptorid = p.institutiontelephonenumbertypedescriptorid and d.codevalue = 'Main'
    group by p.educationorganizationid
),
org_extras as (
    select o.educationorganizationid, jsonb_strip_nulls(jsonb_build_object(
        'NCESId', codes.nces_id, 'orgStateId', codes.state_id,
        'address1', address.streetnumbername, 'address2', address.apartmentroomsuitenumber, 'city', address.city,
        'state', address.state, 'postalCode', address.postalcode, 'phone', phone.phone
    )) as extras
    from edfi.educationorganization o
        left join org_codes codes on codes.educationorganizationid = o.educationorganizationid
        left join org_address address on address.educationorganizationid = o.educationorganizationid
        left join org_phone phone on phone.educationorganizationid = o.educationorganizationid
),
schools_formatted as (
    select
        md5(schools.schoolId::text) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi Schools
        'active' as "status",
        lastmodifieddate as "dateLastModified",
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
        (jsonb_build_object(
            'edfi', jsonb_build_object(
                'resource', 'schools',
                'naturalKey', jsonb_build_object(
                    'schoolId', schoolId
                )
            )
        ) || coalesce(x.extras, '{}'::jsonb))::json as metadata
    from schools
        left join org_extras x on x.educationorganizationid = schools.schoolId
),
leas_formatted as (
    select
        md5(leas.localEducationAgencyId::text) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi LocalEducationAgencies
        'active' as "status",
        lastmodifieddate as "dateLastModified",
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
        (jsonb_build_object(
            'edfi', jsonb_build_object(
                'resource', 'localEducationAgencies',
                'naturalKey', jsonb_build_object(
                    'localEducationAgencyId', localEducationAgencyId
                )
            )
        ) || coalesce(x.extras, '{}'::jsonb))::json as metadata
    from leas
        left join org_extras x on x.educationorganizationid = leas.localEducationAgencyId
),
seas_formatted as (
    select
        md5(seas.stateEducationAgencyId::text) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi StateEducationAgencies
        'active' as "status",
        lastmodifieddate as "dateLastModified",
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
        (jsonb_build_object(
            'edfi', jsonb_build_object(
                'resource', 'stateEducationAgencies',
                'naturalKey', jsonb_build_object(
                    'stateEducationAgencyId', stateEducationAgencyId
                )
            )
        ) || coalesce(x.extras, '{}'::jsonb))::json as metadata
    from seas
        left join org_extras x on x.educationorganizationid = seas.stateEducationAgencyId
),
-- property documentation at
-- https://www.imsglobal.org/sites/default/files/spec/oneroster/v1p2/rostering-restbinding/OneRosterv1p2RosteringService_RESTBindv1p0.html#Main6p16p2
stacked as (
    select * from schools_formatted
        union all
    select * from leas_formatted
        union all
    select * from seas_formatted
)
select * from stacked;

-- Add an index so the materialized view can be refreshed _concurrently_:
create index if not exists orgs_sourcedid ON oneroster12.orgs ("sourcedId");

-- Authorization filters: org id lookups
create index if not exists orgs_educationorganizationid on oneroster12.orgs ("educationOrganizationId");
