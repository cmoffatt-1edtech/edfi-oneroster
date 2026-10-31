-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional): one offering per Ed-Fi AssessmentAdministration, offered by
-- its assigning organization. Mapping: docs/design/assessment-rostering-mappings.md
drop index if exists oneroster12.assessmentofferings_sourcedid;
drop index if exists oneroster12.assessmentofferings_assessmentsourcedid;
drop materialized view if exists oneroster12.assessmentofferings;
--
create materialized view if not exists oneroster12.assessmentofferings as
with administration as (
    -- Key parts for sourcedIds: lower case, then '\' and '|' escaped
    select
        aa.*,
        replace(replace(lower(aa.namespace), '\', '\\'), '|', '\|') as k_namespace,
        replace(replace(lower(aa.assessmentidentifier), '\', '\\'), '|', '\|') as k_assessmentidentifier,
        replace(replace(lower(aa.administrationidentifier), '\', '\\'), '|', '\|') as k_administrationidentifier
    from edfi.assessmentadministration aa
),
published_orgs as (
    -- The organizations the orgs view publishes; a reference to any other is left null
    select schoolid as educationorganizationid from edfi.school
    union
    select localeducationagencyid from edfi.localeducationagency
    union
    select stateeducationagencyid from edfi.stateeducationagency
),
windows as (
    -- One window per Ed-Fi period, never merged; an open-ended window keeps a null end date
    select
        p.namespace,
        p.assessmentidentifier,
        p.assigningeducationorganizationid,
        p.administrationidentifier,
        json_agg(
            json_build_object('startDate', p.begindate::text, 'endDate', p.enddate::text)
            order by p.begindate, p.enddate nulls last
        ) as windows
    from edfi.assessmentadministrationperiod p
    group by p.namespace, p.assessmentidentifier, p.assigningeducationorganizationid, p.administrationidentifier
),
participation as (
    select
        p.namespace,
        p.assessmentidentifier,
        p.assigningeducationorganizationid,
        p.administrationidentifier,
        json_agg(
            json_strip_nulls(json_build_object(
                'educationOrganizationId', p.participatingeducationorganizationid,
                'org', case when participating_org.educationorganizationid is not null then json_build_object(
                    'href', concat('/orgs/', md5(p.participatingeducationorganizationid::text)),
                    'sourcedId', md5(p.participatingeducationorganizationid::text),
                    'type', 'org'
                ) end
            ))
            order by p.participatingeducationorganizationid
        ) as organizations,
        max(p.lastmodifieddate) as lastmodifieddate
    from edfi.assessmentadministrationparticipation p
        left join published_orgs participating_org
            on participating_org.educationorganizationid = p.participatingeducationorganizationid
    group by p.namespace, p.assessmentidentifier, p.assigningeducationorganizationid, p.administrationidentifier
)
select
    md5(concat(
        aa.k_namespace,
        '|', aa.k_assessmentidentifier,
        '|', aa.assigningeducationorganizationid::text,
        '|', aa.k_administrationidentifier
    )) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi AssessmentAdministrations
    'active' as "status",
    -- The participation rows are separate resources; periods are part of the administration
    greatest(aa.lastmodifieddate, participation.lastmodifieddate) as "dateLastModified",
    aa.administrationidentifier as "title",
    json_build_object(
        'href', concat('/assessments/', md5(concat(aa.k_namespace, '|', aa.k_assessmentidentifier))),
        'sourcedId', md5(concat(aa.k_namespace, '|', aa.k_assessmentidentifier)),
        'type', 'assessment'
    ) as "assessment",
    case when assigning_org.educationorganizationid is not null then json_build_object(
        'href', concat('/orgs/', md5(aa.assigningeducationorganizationid::text)),
        'sourcedId', md5(aa.assigningeducationorganizationid::text),
        'type', 'org'
    ) end as "org",
    coalesce(windows.windows, '[]'::json) as "testingWindows",
    -- Ed-Fi links sections to the assessment, not the administration (open question Q4)
    null::json as "class",
    -- Ed-Fi administrations have no academic session (open question Q5)
    null::json as "academicSession",
    json_build_object(
        'edfi', json_strip_nulls(json_build_object(
            'resource', 'assessmentAdministrations',
            'naturalKey', json_build_object(
                'namespace', aa.namespace,
                'assessmentIdentifier', aa.assessmentidentifier,
                'assigningEducationOrganizationId', aa.assigningeducationorganizationid,
                'administrationIdentifier', aa.administrationidentifier
            ),
            'participatingEducationOrganizations', participation.organizations
        ))
    ) as metadata,
    -- Sub-collection /assessments/{id}/assessmentOfferings
    md5(concat(aa.k_namespace, '|', aa.k_assessmentidentifier)) as "assessmentSourcedId"
from administration aa
    left join published_orgs assigning_org
        on assigning_org.educationorganizationid = aa.assigningeducationorganizationid
    left join windows
        on windows.namespace = aa.namespace
        and windows.assessmentidentifier = aa.assessmentidentifier
        and windows.assigningeducationorganizationid = aa.assigningeducationorganizationid
        and windows.administrationidentifier = aa.administrationidentifier
    left join participation
        on participation.namespace = aa.namespace
        and participation.assessmentidentifier = aa.assessmentidentifier
        and participation.assigningeducationorganizationid = aa.assigningeducationorganizationid
        and participation.administrationidentifier = aa.administrationidentifier;

create index if not exists assessmentofferings_sourcedid on oneroster12.assessmentofferings ("sourcedId");

-- Sub-collection lookups
create index if not exists assessmentofferings_assessmentsourcedid on oneroster12.assessmentofferings ("assessmentSourcedId");
