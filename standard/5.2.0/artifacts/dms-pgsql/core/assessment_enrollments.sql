-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional) on DMS. Same output as
-- standard/5.2.0/artifacts/pgsql/core/assessment_enrollments.sql: one student enrollment per Ed-Fi
-- StudentAssessmentRegistration. The registration carries the student's unique id and school but
-- not the student's "DocumentId", which the auth views return: that comes from its
-- StudentSchoolAssociation. Mapping: docs/design/assessment-rostering-mappings.md
drop index if exists oneroster12.assessmentenrollments_sourcedid;
drop index if exists oneroster12.assessmentenrollments_educationorganizationid;
drop index if exists oneroster12.assessmentenrollments_participantdocumentid;
drop index if exists oneroster12.assessmentenrollments_assessmentofferingsourcedid;
drop materialized view if exists oneroster12.assessmentenrollments;
--
create materialized view if not exists oneroster12.assessmentenrollments as
with registration as (
    -- Key parts for sourcedIds: lower case, then '\' and '|' escaped
    select
        r.*,
        ssa."Student_DocumentId" as student_documentid,
        replace(replace(lower(r."AssessmentAdministration_Namespace"), '\', '\\'), '|', '\|') as k_namespace,
        replace(replace(lower(r."AssessmentAdministration_AssessmentIdentifier"), '\', '\\'), '|', '\|') as k_assessmentidentifier,
        replace(replace(lower(r."AssessmentAdministration_AdministrationIdentifier"), '\', '\\'), '|', '\|') as k_administrationidentifier,
        replace(replace(lower(r."StudentUniqueId_Unified"), '\', '\\'), '|', '\|') as k_studentuniqueid
    from edfi."StudentAssessmentRegistration" r
        join edfi."StudentSchoolAssociation" ssa
            on ssa."DocumentId" = r."StudentSchoolAssociation_DocumentId"
),
registration_keyed as (
    select
        r.*,
        md5(concat(
            r.k_namespace,
            '|', r.k_assessmentidentifier,
            '|', r."AssessmentAdministration_AssigningEducationOrganizationId"::text,
            '|', r.k_administrationidentifier
        )) as offering_sourcedid,
        md5(concat('STU-', r."StudentUniqueId_Unified"::text, '-', r."StudentSchoolAssociation_SchoolId"::text)) as user_sourcedid
    from registration r
),
published_orgs as (
    -- The organizations the orgs view publishes; a reference to any other is left null
    select "SchoolId" as educationorganizationid from edfi."School"
    union
    select "LocalEducationAgencyId" from edfi."LocalEducationAgency"
    union
    select "StateEducationAgencyId" from edfi."StateEducationAgency"
)
select
    md5(concat(
        r.k_namespace,
        '|', r.k_assessmentidentifier,
        '|', r."AssessmentAdministration_AssigningEducationOrganizationId"::text,
        '|', r.k_administrationidentifier,
        '|', r."StudentEducationOrganizationAssociation_EducationOrganizationId"::text,
        '|', r.k_studentuniqueid
    )) as "sourcedId", -- unique ID constructed from natural key of Ed-Fi StudentAssessmentRegistrations
    'active' as "status",
    (r."ContentLastModifiedAt" at time zone 'UTC') as "dateLastModified",
    json_build_object(
        'href', concat('/users/', r.user_sourcedid),
        'sourcedId', r.user_sourcedid,
        'type', 'user'
    ) as "user",
    json_build_object(
        'href', concat('/assessmentOfferings/', r.offering_sourcedid),
        'sourcedId', r.offering_sourcedid,
        'type', 'assessmentOffering'
    ) as "assessmentOffering",
    json_build_object(
        'href', concat('/orgs/', md5(r."StudentSchoolAssociation_SchoolId"::text)),
        'sourcedId', md5(r."StudentSchoolAssociation_SchoolId"::text),
        'type', 'org'
    ) as "school",
    'student' as "role",
    -- Ed-Fi registrations have no dates
    null::text as "beginDate",
    null::text as "endDate",
    json_build_object(
        'edfi', json_strip_nulls(json_build_object(
            'resource', 'studentAssessmentRegistrations',
            'naturalKey', json_build_object(
                'namespace', r."AssessmentAdministration_Namespace",
                'assessmentIdentifier', r."AssessmentAdministration_AssessmentIdentifier",
                'assigningEducationOrganizationId', r."AssessmentAdministration_AssigningEducationOrganizationId",
                'administrationIdentifier', r."AssessmentAdministration_AdministrationIdentifier",
                'educationOrganizationId', r."StudentEducationOrganizationAssociation_EducationOrganizationId",
                'studentUniqueId', r."StudentUniqueId_Unified"
            ),
            'assessmentGradeLevel', grade."CodeValue",
            'platformType', platform."CodeValue",
            'testingEducationOrganization', case when r."TestingEducationOrganization_EducationOrganizationId" is not null then json_build_object(
                'educationOrganizationId', r."TestingEducationOrganization_EducationOrganizationId",
                'org', case when testing_org.educationorganizationid is not null then json_build_object(
                    'href', concat('/orgs/', md5(r."TestingEducationOrganization_EducationOrganizationId"::text)),
                    'sourcedId', md5(r."TestingEducationOrganization_EducationOrganizationId"::text),
                    'type', 'org'
                ) end
            ) end,
            'reportingEducationOrganization', case when r."ReportingEducationOrganization_EducationOrganizationId" is not null then json_build_object(
                'educationOrganizationId', r."ReportingEducationOrganization_EducationOrganizationId",
                'org', case when reporting_org.educationorganizationid is not null then json_build_object(
                    'href', concat('/orgs/', md5(r."ReportingEducationOrganization_EducationOrganizationId"::text)),
                    'sourcedId', md5(r."ReportingEducationOrganization_EducationOrganizationId"::text),
                    'type', 'org'
                ) end
            ) end
        ))
    ) as metadata,
    -- Authorization: the school of the registration's StudentSchoolAssociation, and the student
    r."StudentSchoolAssociation_SchoolId" as "educationOrganizationId",
    r.student_documentid as "participantDocumentId",
    -- Sub-collection /assessmentOfferings/{id}/assessmentEnrollments
    r.offering_sourcedid as "assessmentOfferingSourcedId"
from registration_keyed r
    left join dms."Descriptor" grade
        on grade."DescriptorId" = r."AssessmentGradeLevelDescriptor_DescriptorId"
    left join dms."Descriptor" platform
        on platform."DescriptorId" = r."PlatformTypeDescriptor_DescriptorId"
    left join published_orgs testing_org
        on testing_org.educationorganizationid = r."TestingEducationOrganization_EducationOrganizationId"
    left join published_orgs reporting_org
        on reporting_org.educationorganizationid = r."ReportingEducationOrganization_EducationOrganizationId";

create index if not exists assessmentenrollments_sourcedid on oneroster12.assessmentenrollments ("sourcedId");

-- Authorization filters: org and participant lookups
create index if not exists assessmentenrollments_educationorganizationid on oneroster12.assessmentenrollments ("educationOrganizationId");
create index if not exists assessmentenrollments_participantdocumentid on oneroster12.assessmentenrollments ("participantDocumentId");

-- Sub-collection lookups
create index if not exists assessmentenrollments_assessmentofferingsourcedid on oneroster12.assessmentenrollments ("assessmentOfferingSourcedId");
