-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.orgs on DMS. Same output as standard/5.2.0/artifacts/pgsql/core/orgs.sql; DMS has no
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
-- Optional org fields (provisional, WS2 shortlist; names as in ClassLink's metadata list): the NCES
-- and state identifiers, the physical address and the main phone. A key is left out when Ed-Fi has
-- no value; ties go to the lowest value by code point, the same on every engine.
org_documents as (
    select "DocumentId" as documentid, "SchoolId" as educationorganizationid from edfi."School"
    union all
    select "DocumentId", "LocalEducationAgencyId" from edfi."LocalEducationAgency"
    union all
    select "DocumentId", "StateEducationAgencyId" from edfi."StateEducationAgency"
),
org_codes as (
    select c.documentid,
        min(c.code collate "C") filter (where d."CodeValue" = 'NCES') as nces_id,
        min(c.code collate "C") filter (where d."CodeValue" = 'SEA') as state_id
    from (
        select "School_DocumentId" as documentid, "EducationOrganizationIdentificationSystemDescriptor__f63fb21ede" as descriptorid, "IdentificationCode" as code from edfi."SchoolIdentificationCode"
        union all
        select "LocalEducationAgency_DocumentId", "EducationOrganizationIdentificationSystemDescriptor__f63fb21ede", "IdentificationCode" from edfi."LocalEducationAgencyIdentificationCode"
        union all
        select "StateEducationAgency_DocumentId", "EducationOrganizationIdentificationSystemDescriptor__f63fb21ede", "IdentificationCode" from edfi."StateEducationAgencyIdentificationCode"
    ) c
        join dms."Descriptor" d on d."DescriptorId" = c.descriptorid
    group by c.documentid
),
org_address as (
    select distinct on (a.documentid)
        a.documentid, a.streetnumbername, a.apartmentroomsuitenumber, a.city, s."CodeValue" as state, a.postalcode
    from (
        select "School_DocumentId" as documentid, "AddressTypeDescriptor_DescriptorId" as typeid, "StateAbbreviationDescriptor_DescriptorId" as stateid,
            "StreetNumberName" as streetnumbername, "ApartmentRoomSuiteNumber" as apartmentroomsuitenumber, "City" as city, "PostalCode" as postalcode
        from edfi."SchoolAddress"
        union all
        select "LocalEducationAgency_DocumentId", "AddressTypeDescriptor_DescriptorId", "StateAbbreviationDescriptor_DescriptorId",
            "StreetNumberName", "ApartmentRoomSuiteNumber", "City", "PostalCode"
        from edfi."LocalEducationAgencyAddress"
        union all
        select "StateEducationAgency_DocumentId", "AddressTypeDescriptor_DescriptorId", "StateAbbreviationDescriptor_DescriptorId",
            "StreetNumberName", "ApartmentRoomSuiteNumber", "City", "PostalCode"
        from edfi."StateEducationAgencyAddress"
    ) a
        join dms."Descriptor" t on t."DescriptorId" = a.typeid and t."CodeValue" = 'Physical'
        left join dms."Descriptor" s on s."DescriptorId" = a.stateid
    order by a.documentid, a.streetnumbername collate "C", a.city collate "C", a.postalcode collate "C"
),
org_phone as (
    select p.documentid, min(p.telephonenumber collate "C") as phone
    from (
        select "School_DocumentId" as documentid, "InstitutionTelephoneNumberTypeDescriptor_DescriptorId" as typeid, "TelephoneNumber" as telephonenumber from edfi."SchoolInstitutionTelephone"
        union all
        select "LocalEducationAgency_DocumentId", "InstitutionTelephoneNumberTypeDescriptor_DescriptorId", "TelephoneNumber" from edfi."LocalEducationAgencyInstitutionTelephone"
        union all
        select "StateEducationAgency_DocumentId", "InstitutionTelephoneNumberTypeDescriptor_DescriptorId", "TelephoneNumber" from edfi."StateEducationAgencyInstitutionTelephone"
    ) p
        join dms."Descriptor" d on d."DescriptorId" = p.typeid and d."CodeValue" = 'Main'
    group by p.documentid
),
org_extras as (
    select o.educationorganizationid, jsonb_strip_nulls(jsonb_build_object(
        'NCESId', codes.nces_id, 'orgStateId', codes.state_id,
        'address1', address.streetnumbername, 'address2', address.apartmentroomsuitenumber, 'city', address.city,
        'state', address.state, 'postalCode', address.postalcode, 'phone', phone.phone
    )) as extras
    from org_documents o
        left join org_codes codes on codes.documentid = o.documentid
        left join org_address address on address.documentid = o.documentid
        left join org_phone phone on phone.documentid = o.documentid
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
        (jsonb_build_object(
            'edfi', jsonb_build_object(
                'resource', 'schools',
                'naturalKey', jsonb_build_object('schoolId', schoolId)
            )
        ) || coalesce(x.extras, '{}'::jsonb))::json as metadata
    from schools
        left join org_extras x on x.educationorganizationid = schools.schoolId
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
        (jsonb_build_object(
            'edfi', jsonb_build_object(
                'resource', 'localEducationAgencies',
                'naturalKey', jsonb_build_object('localEducationAgencyId', localEducationAgencyId)
            )
        ) || coalesce(x.extras, '{}'::jsonb))::json as metadata
    from leas
        left join org_extras x on x.educationorganizationid = leas.localEducationAgencyId
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
        (jsonb_build_object(
            'edfi', jsonb_build_object(
                'resource', 'stateEducationAgencies',
                'naturalKey', jsonb_build_object('stateEducationAgencyId', stateEducationAgencyId)
            )
        ) || coalesce(x.extras, '{}'::jsonb))::json as metadata
    from seas
        left join org_extras x on x.educationorganizationid = seas.stateEducationAgencyId
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
