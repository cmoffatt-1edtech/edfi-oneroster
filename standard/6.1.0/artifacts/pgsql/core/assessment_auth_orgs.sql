-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional): the organizations each assessment and offering is tied to,
-- one row per (assessment, offering, organization, role). Not an endpoint: the assessments and
-- assessmentOfferings authorization filters read it (AuthorizationQueryService). Organizations
-- the orgs view doesn't publish are kept, because the ed-org hierarchy may still reach them.
drop index if exists oneroster12.assessmentauthorgs_sourcedid;
drop index if exists oneroster12.assessmentauthorgs_educationorganizationid;
drop materialized view if exists oneroster12.assessmentauthorgs;
--
create materialized view if not exists oneroster12.assessmentauthorgs as
with keyed as (
    -- Key parts for sourcedIds, as in the assessments and assessmentofferings views
    select
        namespace,
        assessmentidentifier,
        replace(replace(lower(namespace), '\', '\\'), '|', '\|') as k_namespace,
        replace(replace(lower(assessmentidentifier), '\', '\\'), '|', '\|') as k_assessmentidentifier
    from edfi.assessment
),
organizations as (
    -- defining: the assessment's own organization (no offering)
    select a.namespace, a.assessmentidentifier, null::bigint as assigningeducationorganizationid,
        null::varchar as administrationidentifier, a.educationorganizationid, 'defining' as orgrole
    from edfi.assessment a
    where a.educationorganizationid is not null
    union all
    -- assigning: the organization an offering belongs to
    select aa.namespace, aa.assessmentidentifier, aa.assigningeducationorganizationid,
        aa.administrationidentifier, aa.assigningeducationorganizationid, 'assigning'
    from edfi.assessmentadministration aa
    union all
    -- participating: schools and districts taking part
    select p.namespace, p.assessmentidentifier, p.assigningeducationorganizationid,
        p.administrationidentifier, p.participatingeducationorganizationid, 'participating'
    from edfi.assessmentadministrationparticipation p
    union all
    -- registration: schools with a student registered, so every visible enrollment's offering is visible
    select distinct r.namespace, r.assessmentidentifier, r.assigningeducationorganizationid,
        r.administrationidentifier, r.schoolid, 'registration'
    from edfi.studentassessmentregistration r
),
rows as (
    select
        md5(concat(k.k_namespace, '|', k.k_assessmentidentifier)) as assessment_sourcedid,
        case when o.administrationidentifier is not null then md5(concat(
            k.k_namespace,
            '|', k.k_assessmentidentifier,
            '|', o.assigningeducationorganizationid::text,
            '|', replace(replace(lower(o.administrationidentifier), '\', '\\'), '|', '\|')
        )) end as offering_sourcedid,
        o.educationorganizationid::bigint as educationorganizationid,
        o.orgrole
    from organizations o
        join keyed k
            on k.namespace = o.namespace
            and k.assessmentidentifier = o.assessmentidentifier
)
select
    -- A row key for the parity tools, not a OneRoster id
    md5(concat(assessment_sourcedid, '|', coalesce(offering_sourcedid, ''), '|', educationorganizationid::text, '|', orgrole)) as "sourcedId",
    assessment_sourcedid as "assessmentSourcedId",
    offering_sourcedid as "assessmentOfferingSourcedId",
    educationorganizationid as "educationOrganizationId",
    orgrole as "orgRole"
from rows;

create index if not exists assessmentauthorgs_sourcedid on oneroster12.assessmentauthorgs ("sourcedId");

-- Authorization filters: org id lookups
create index if not exists assessmentauthorgs_educationorganizationid on oneroster12.assessmentauthorgs ("educationOrganizationId");
