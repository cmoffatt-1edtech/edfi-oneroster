-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.demographics on DMS. Same output as standard/5.2.0/artifacts/pgsql/core/demographics.sql.
-- Students are keyed by "DocumentId" (studentUSI becomes studentDocumentId, the Student_DocumentId the
-- auth views return). Race is a child collection of StudentEducationOrganizationAssociation, so race
-- rows reach the student through their parent SEOA row.
drop index if exists oneroster12.demographics_sourcedid;
drop materialized view if exists oneroster12.demographics;
--
create materialized view if not exists oneroster12.demographics as
with student as (
    select * from edfi."Student"
),
-- One row per (student, school), mirroring the users view's anchor so the
-- school-keyed sourcedId always matches a user. Race/ethnicity is resolved
-- per-student (below) and replicated onto each of the student's school rows.
student_school as (
    select distinct
        ssa."Student_DocumentId" as studentDocumentId,
        ssa."School_SchoolId" as schoolId
    from edfi."StudentSchoolAssociation" ssa
    join edfi."School" s on ssa."School_SchoolId" = s."SchoolId"
),
-- Hispanic/ethnicity is a person-level fact, not an org-level one. Aggregate
-- across ALL of the student's SEOA records regardless of the org level (school,
-- LEA, ESC, SEA) they were recorded at, so higher-org data is never dropped.
student_edorg as (
    select
        se."Student_DocumentId" as studentDocumentId,
        bool_or(se."HispanicLatinoEthnicity") as hispanicLatinoEthnicity,
        max(se."ContentLastModifiedAt" at time zone 'UTC') as edorg_lmdate
    from edfi."StudentEducationOrganizationAssociation" se
    group by se."Student_DocumentId"
),
-- Race is likewise person-level: union the mapped race descriptors across all
-- of the student's SEOA records.
student_race as (
    select
        se."Student_DocumentId" as studentDocumentId,
        array_remove(array_agg(distinct mappedracedescriptor."MappedValue"::text), null) as race_array
    from edfi."StudentEducationOrganizationAssociationRace" seoar
    join edfi."StudentEducationOrganizationAssociation" se
        on seoar."StudentEducationOrganizationAssociation_DocumentId" = se."DocumentId"
    join dms."Descriptor" racedescriptor
        on seoar."RaceDescriptor_DescriptorId" = racedescriptor."DescriptorId"
    left join edfi."DescriptorMapping" mappedracedescriptor
        on mappedracedescriptor."Value" = racedescriptor."CodeValue"
            and mappedracedescriptor."Namespace" = racedescriptor."Namespace"
            and mappedracedescriptor."MappedNamespace" = 'uri://1edtech.org/oneroster12/RaceDescriptor'
    group by se."Student_DocumentId"
)
-- property documentation at
-- https://www.imsglobal.org/sites/default/files/spec/oneroster/v1p2/rostering-restbinding/OneRosterv1p2RosteringService_RESTBindv1p0.html#Main6p10p2
select
    md5(
        case
            when ss.schoolId is null then concat('STU-', student."StudentUniqueId"::text)
            else concat('STU-', student."StudentUniqueId"::text, '-', ss.schoolId::text)
        end
    ) as "sourcedId",
    'active' as "status",
    greatest(
        (student."ContentLastModifiedAt" at time zone 'UTC'),
        coalesce(seo.edorg_lmdate, (student."ContentLastModifiedAt" at time zone 'UTC'))
    ) as "dateLastModified",
    to_char(student."BirthDate", 'YYYY-MM-DD') as "birthDate",
    mappedsexdescriptor."MappedValue" as "sex",
    -- OneRoster spec expects the _string_ "true" or "false", not a JSON boolean value
    case when coalesce(sr.race_array, array[]::text[]) @> array['americanIndianOrAlaskaNative'] then 'true' else 'false' end         as "americanIndianOrAlaskaNative",
    case when coalesce(sr.race_array, array[]::text[]) @> array['asian'] then 'true' else 'false' end                                as "asian",
    case when coalesce(sr.race_array, array[]::text[]) @> array['blackOrAfricanAmerican'] then 'true' else 'false' end               as "blackOrAfricanAmerican",
    case when coalesce(sr.race_array, array[]::text[]) @> array['nativeHawaiianOrOtherPacificIslander'] then 'true' else 'false' end as "nativeHawaiianOrOtherPacificIslander",
    case when coalesce(sr.race_array, array[]::text[]) @> array['white'] then 'true' else 'false' end                                as "white",
    case when coalesce(array_length(sr.race_array, 1), 0) > 1 then 'true' else 'false' end as "demographicRaceTwoOrMoreRaces",
    case when coalesce(seo.hispanicLatinoEthnicity, false) then 'true' else 'false' end as "hispanicOrLatinoEthnicity",
    countrydescriptor."CodeValue" as "countryOfBirthCode",
    statedescriptor."CodeValue" as "stateOfBirthAbbreviation",
    student."BirthCity" as "cityOfBirth",
    null as "publicSchoolResidenceStatus",
    student."DocumentId" as "studentDocumentId",
    ss.schoolId as "educationOrganizationId",
    json_build_object(
        'edfi', jsonb_strip_nulls(
            jsonb_build_object(
                'resource', 'students',
                'naturalKey', jsonb_build_object(
                    'studentUniqueId', student."StudentUniqueId"
                ),
                'educationOrganizationId', ss.schoolId
            )
        )::json
    ) AS metadata
from student
    left join student_school ss on student."DocumentId" = ss.studentDocumentId
    left join student_edorg seo
        on student."DocumentId" = seo.studentDocumentId
    left join student_race sr
        on student."DocumentId" = sr.studentDocumentId
    left join dms."Descriptor" sexdescriptor
        on student."BirthSexDescriptor_DescriptorId" = sexdescriptor."DescriptorId"
    left join edfi."DescriptorMapping" mappedsexdescriptor
        on mappedsexdescriptor."Value" = sexdescriptor."CodeValue"
            and mappedsexdescriptor."Namespace" = sexdescriptor."Namespace"
            and mappedsexdescriptor."MappedNamespace" = 'uri://1edtech.org/oneroster12/SexDescriptor'
    left join dms."Descriptor" countrydescriptor
        on student."BirthCountryDescriptor_DescriptorId" = countrydescriptor."DescriptorId"
    left join dms."Descriptor" statedescriptor
        on student."BirthStateAbbreviationDescriptor_DescriptorId" = statedescriptor."DescriptorId";

-- Add an index so the materialized view can be refreshed _concurrently_:
create index if not exists demographics_sourcedid ON oneroster12.demographics ("sourcedId");

-- Authorization filters: org and student lookups
create index if not exists demographics_educationorganizationid on oneroster12.demographics ("educationOrganizationId");
create index if not exists demographics_studentdocumentid on oneroster12.demographics ("studentDocumentId");
