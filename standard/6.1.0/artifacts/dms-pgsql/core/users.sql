-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.users on DMS, Data Standard 6.1. Same output as standard/6.1.0/artifacts/pgsql/core/users.sql,
-- with these differences:
--   * participantUSI is participantDocumentId: the "DocumentId" of the person's edfi."Student",
--     edfi."Staff" or edfi."Contact" row, the key the auth."EducationOrganizationIdTo*DocumentId"
--     views return.
--   * DMS has no CreateDate. A staff member's primary org is ranked by the StaffSchoolAssociation
--     "DocumentId" (insertion order) descending, then schoolId, where the ODS uses createdate desc,
--     schoolid.
--   * The base CTEs below rename the DMS columns to the ODS names, so the logic after them reads like
--     the ODS file. The ODS file's unused lea_staff_classification CTE is left out.
--   * DS 6.1 resources: student identification codes are the StudentIdentificationCode resource; student
--     and staff e-mail addresses are the electronicMails collections of StudentDirectory and
--     StaffDirectory, each keyed by education organization (StaffDirectory replaces both
--     StaffElectronicMail and StaffEducationOrganizationContactAssociation); StaffIdentificationCode is
--     keyed by education organization. Identifiers and e-mail are resolved per school with a
--     person-level fallback, as in the ODS 6.1 file.
drop index if exists oneroster12.users_sourcedid;
drop index if exists oneroster12.users_participantdocumentid;
drop materialized view if exists oneroster12.users;
--
create materialized view if not exists oneroster12.users as
with student as (
    select
        s."DocumentId" as studentDocumentId,
        s."StudentUniqueId" as studentUniqueId,
        s."FirstName" as firstName,
        s."LastSurname" as lastSurname,
        s."MiddleName" as middleName,
        s."PreferredFirstName" as preferredFirstName,
        s."PreferredLastSurname" as preferredLastSurname,
        (s."ContentLastModifiedAt" at time zone 'UTC') as lastModifiedDate
    from edfi."Student" s
),
student_school as (
    select
        ssa."Student_DocumentId" as studentDocumentId,
        ssa."School_SchoolId" as schoolId,
        ssa."PrimarySchool" as primarySchool,
        ssa."EntryDate" as entryDate,
        ssa."ExitWithdrawDate" as exitWithdrawDate,
        ssa."EntryGradeLevelDescriptor_DescriptorId" as entryGradeLevelDescriptorId
    from edfi."StudentSchoolAssociation" ssa
),
school as (
    select
        sch."SchoolId" as schoolId,
        sch."LocalEducationAgency_LocalEducationAgencyId" as localEducationAgencyId
    from edfi."School" sch
),
staff as (
    select
        st."DocumentId" as staffDocumentId,
        st."StaffUniqueId" as staffUniqueId,
        st."FirstName" as firstName,
        st."LastSurname" as lastSurname,
        st."MiddleName" as middleName,
        st."PreferredFirstName" as preferredFirstName,
        st."PreferredLastSurname" as preferredLastSurname,
        (st."ContentLastModifiedAt" at time zone 'UTC') as lastModifiedDate
    from edfi."Staff" st
),
staff_school as (
    select
        ssa."DocumentId" as staffSchoolAssociationDocumentId,
        ssa."Staff_DocumentId" as staffDocumentId,
        ssa."School_SchoolId" as schoolId
    from edfi."StaffSchoolAssociation" ssa
),
staff_edorg_assign as (
    select
        seoaa."Staff_DocumentId" as staffDocumentId,
        seoaa."EducationOrganization_EducationOrganizationId" as educationOrganizationId,
        seoaa."StaffClassificationDescriptor_DescriptorId" as staffClassificationDescriptorId
    from edfi."StaffEducationOrganizationAssignmentAssociation" seoaa
),
student_ids as (
    select
        seoa_sid."Student_DocumentId" as studentDocumentId,
        seoa_sid."EducationOrganization_EducationOrganizationId" as educationOrganizationId,
        json_agg(
            json_build_object(
                'type', studentIDsystemDescriptor."CodeValue",
                'identifier', seoa_sid."IdentificationCode"
            )
            order by studentIDsystemDescriptor."CodeValue"
        ) as ids
    from edfi."StudentIdentificationCode" seoa_sid
        join dms."Descriptor" studentIDsystemDescriptor
            on seoa_sid."StudentIdentificationSystemDescriptor_DescriptorId" = studentIDsystemDescriptor."DescriptorId"
    group by 1,2
),
student_email as (
    select x.*
    from (
        select
            sd."Student_DocumentId" as studentDocumentId,
            seoa_et."ElectronicMailAddress" as electronicMailAddress,
            emailtypedescriptor."CodeValue" = 'Home/Personal' as is_preferred,
            row_number() over(
                partition by sd."Student_DocumentId"
                order by (emailtypedescriptor."CodeValue" = 'Home/Personal') desc nulls last,
                         emailtypedescriptor."CodeValue"
            ) as seq
        -- DS 6.1: StudentEducationOrganizationAssociation e-mail moved to StudentDirectory
        from edfi."StudentDirectoryElectronicMail" seoa_et
            join edfi."StudentDirectory" sd
                on seoa_et."StudentDirectory_DocumentId" = sd."DocumentId"
            join dms."Descriptor" emailtypedescriptor
                on seoa_et."ElectronicMailTypeDescriptor_DescriptorId" = emailtypedescriptor."DescriptorId"
        -- exclude do-not-publish addresses before ranking, so a suppressed preferred
        -- address falls through to the next publishable one instead of leaving no email
        where seoa_et."DoNotPublishIndicator" is null or not seoa_et."DoNotPublishIndicator"
    ) x
    where seq = 1
),
student_orgs as (
    select
        studentDocumentId,
        school.localEducationAgencyId,
        school.schoolId,
        md5(school.schoolId::text) as sourcedid,
        student_school.primarySchool,
        student_school.entryDate
    from student_school
        join school
            on student_school.schoolId = school.schoolId
),
student_primary_org as (
    select studentDocumentId, schoolid
    from (
        select
            studentDocumentId,
            schoolid,
            row_number() over (
                partition by studentDocumentId
                order by (case when primarySchool then 1 else 0 end) desc,
                         entryDate desc,
                         schoolid
            ) as seq
        from student_orgs
    ) ranked
    where seq = 1
),
student_orgs_agg as (
    select
        student_orgs.studentDocumentId,
        json_agg(
            json_build_object(
                'roleType', case
                    when student_primary_org.schoolid is not null
                         and student_orgs.schoolid = student_primary_org.schoolid then 'primary'
                    else 'secondary'
                end,
                'role', 'student',
                'org', json_build_object(
                    'href', concat('/orgs/', student_orgs.sourcedid::text),
                    'sourcedId', student_orgs.sourcedid,
                    'type', 'org'
                )
            )
            -- deterministic order so the array matches the MSSQL artifact
            order by student_orgs.schoolid
        ) AS "roles"
    -- dedup to one row per (student, school): a re-enrollment at the same school
    -- must not duplicate that org in the roles array.
    from (select distinct studentDocumentId, schoolid, sourcedid from student_orgs) student_orgs
        left join student_primary_org
            on student_orgs.studentDocumentId = student_primary_org.studentDocumentId
    group by student_orgs.studentDocumentId
),
student_grade as (
    select x.*
    from (
        select
            studentDocumentId,
            gradeleveldescriptor."CodeValue" as grade_level,
            row_number() over(
                -- partition by student alone (not student, schoolyear) so a
                -- student with enrolments in multiple years yields one user row
                partition by studentDocumentId
                order by
                    entrydate desc,
                    exitwithdrawdate desc nulls first,
                    gradeleveldescriptor."CodeValue" desc
            ) as seq
        from student_school
            join dms."Descriptor" gradeleveldescriptor
                on student_school.entryGradeLevelDescriptorId = gradeleveldescriptor."DescriptorId"
    ) x
    where seq = 1
),
formatted_users_student as (
    select
        md5(
            case
                when student_orgs.schoolId is null then concat('STU-', student.studentUniqueId::text)
                else concat('STU-', student.studentUniqueId::text, '-', student_orgs.schoolId::text)
            end
          ) as "sourcedId",
            'active' as "status",
            student.lastmodifieddate as "dateLastModified",
        null::text as "userMasterIdentifier",
        case when student_email.electronicmailaddress is null then '' else student_email.electronicmailaddress end as "username",
        case when student_ids.ids is not null then
            jsonb_insert(
                student_ids.ids::jsonb,
                '{0}',
                json_build_object(
                    'type', 'studentUniqueId',
                    'identifier', student.studentUniqueId
                )::jsonb
            )::json
        else
            json_build_array(json_build_object(
                'type', 'studentUniqueId',
                'identifier', student.studentUniqueId
            ))
        end as "userIds",
        'true' as "enabledUser",
        student.firstname as "givenName",
        student.lastsurname as "familyName",
        student.middlename as "middleName",
        student.preferredfirstname as "preferredFirstName",
        null::text as "preferredMiddleName",
        student.preferredlastsurname as "preferredLastName",
        null::text as "pronouns",
        'student' as "role",
        student_orgs_agg.roles AS "roles",
        null as "userProfiles",
        student.studentuniqueid as "identifier",
            student_orgs.schoolId as "educationOrganizationId",
        student.studentDocumentId as "participantDocumentId",
        student_email.electronicmailaddress as "email",
        null::text as "sms",
        null::text as "phone",
        null::text as "agentSourceIds",
        json_build_array(student_grade.grade_level) as "grades",
        null::text as "password",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'students',
                'naturalKey', json_build_object(
                    'studentUniqueId', student.studentuniqueid
                ),
                'educationOrganizationId', student_orgs.schoolId
            )
        ) AS metadata
    from student
    left join student_grade
        on student.studentDocumentId = student_grade.studentDocumentId
    left join student_orgs_agg
        on student.studentDocumentId = student_orgs_agg.studentDocumentId
    -- dedupe to one row per (student, school): a student with multiple
    -- associations to the same school (e.g. re-enrollments) must not
    -- duplicate the school-keyed user sourcedId.
    left join (select distinct studentDocumentId, schoolid from student_orgs) student_orgs
        on student.studentDocumentId = student_orgs.studentDocumentId
    left join student_ids
        on student.studentDocumentId = student_ids.studentDocumentId
        and student_ids.educationOrganizationId = student_orgs.schoolId
    left join student_email
        on student.studentDocumentId = student_email.studentDocumentId
),
teaching_staff as (
    select distinct "Staff_DocumentId" as staffDocumentId
    from edfi."StaffSectionAssociation"
),
staff_school_with_classification as (
    select
        staff_school.*,
        coalesce(mappedschoolstaffclassificationdescriptor."MappedValue",
                 mappedleastaffclassificationdescriptor."MappedValue") as staff_classification
    from staff_school
        join school
            on staff_school.schoolid=school.schoolid
        left join staff_edorg_assign school_assign
            on staff_school.staffDocumentId = school_assign.staffDocumentId
            and staff_school.schoolid = school_assign.educationorganizationid
        left join staff_edorg_assign lea_assign
            on staff_school.staffDocumentId = lea_assign.staffDocumentId
            and school.localeducationagencyid = lea_assign.educationorganizationid
        left join dms."Descriptor" schoolstaffclassificationdescriptor
            on school_assign.staffclassificationdescriptorid=schoolstaffclassificationdescriptor."DescriptorId"
        left join edfi."DescriptorMapping" mappedschoolstaffclassificationdescriptor
            on mappedschoolstaffclassificationdescriptor."Value"=schoolstaffclassificationdescriptor."CodeValue"
                and mappedschoolstaffclassificationdescriptor."Namespace"=schoolstaffclassificationdescriptor."Namespace"
                and mappedschoolstaffclassificationdescriptor."MappedNamespace"='uri://1edtech.org/oneroster12/StaffClassificationDescriptor'
        left join dms."Descriptor" leastaffclassificationdescriptor
            on lea_assign.staffclassificationdescriptorid=leastaffclassificationdescriptor."DescriptorId"
        left join edfi."DescriptorMapping" mappedleastaffclassificationdescriptor
            on mappedleastaffclassificationdescriptor."Value"=leastaffclassificationdescriptor."CodeValue"
                and mappedleastaffclassificationdescriptor."Namespace"=leastaffclassificationdescriptor."Namespace"
                and mappedleastaffclassificationdescriptor."MappedNamespace"='uri://1edtech.org/oneroster12/StaffClassificationDescriptor'
    where school.schoolid is not null
),
staff_role as (
    select x.*
    from (
        select
            staff_school.staffDocumentId,
            coalesce(staff_school.staff_classification, 'teacher') as staff_classification,
            -- as on the ODS, the window orders by the input column (the unmapped value, nulls last),
            -- not by the coalesced output alias
            row_number() over(partition by staff_school.staffDocumentId order by staff_classification) as seq
        from staff_school_with_classification as staff_school
        left join teaching_staff
            on staff_school.staffDocumentId = teaching_staff.staffDocumentId
        where (staff_school.staff_classification is not null or teaching_staff.staffDocumentId is not null)
    ) x
    where seq = 1
),
-- DS 6.1: StaffIdentificationCode is keyed by education organization, so the same identifier can
-- be recorded at several organizations. Aggregating by staff alone would repeat it once per
-- organization in the userIds array. This mirrors student_ids above.
staff_ids_base as (
    select
        sic."Staff_DocumentId" as staffDocumentId,
        sic."EducationOrganization_EducationOrganizationId" as educationorganizationid,
        staffIDsystemDescriptor."CodeValue" as code_value,
        sic."IdentificationCode" as identificationcode
    from edfi."StaffIdentificationCode" sic
        join dms."Descriptor" staffIDsystemDescriptor
            on sic."StaffIdentificationSystemDescriptor_DescriptorId" = staffIDsystemDescriptor."DescriptorId"
),
staff_ids as (
    select
        staffDocumentId,
        educationorganizationid,
        json_agg(
            json_build_object('type', code_value, 'identifier', identificationcode)
            order by code_value
        ) as ids
    from staff_ids_base
    group by 1,2
    union all
    -- Person-level fallback row, keyed with a null organization, for staff user rows with no
    -- school; the inner distinct keeps an identifier recorded at several organizations from
    -- repeating.
    select
        staffDocumentId,
        null::bigint as educationorganizationid,
        json_agg(
            json_build_object('type', code_value, 'identifier', identificationcode)
            order by code_value
        ) as ids
    from (select distinct staffDocumentId, code_value, identificationcode from staff_ids_base) deduped
    group by 1
),
staff_orgs as (
    select
        staffDocumentId,
        schoolid,
        staff_classification,
        staffSchoolAssociationDocumentId
    from staff_school_with_classification
),
staff_primary_org as (
    select staffDocumentId, schoolid
    from (
        select
            staffDocumentId,
            schoolid,
            row_number() over (
                partition by staffDocumentId
                -- the ODS orders by createdate desc; DMS has no CreateDate, and "DocumentId" is
                -- insertion order
                order by staffSchoolAssociationDocumentId desc, schoolid
            ) as seq
        from staff_orgs
    ) ranked
    where seq = 1
),
staff_orgs_agg as (
    select
        so.staffDocumentId,
        json_agg(
            json_build_object(
                'roleType', case when spo.schoolid is not null and so.schoolid = spo.schoolid then 'primary' else 'secondary' end,
                'role', so.staff_classification,
                'org', json_build_object(
                    'href', concat('/orgs/', md5(so.schoolid::text)),
                    'sourcedId', md5(so.schoolid::text),
                    'type', 'org'
                )
            )
            -- deterministic order so the array matches the MSSQL artifact
            order by so.schoolid
        ) AS "roles"
    -- One row per (staff, school), preferring a mapped classification over an unmapped
    -- (null) one, so multiple assignments to the same school neither duplicate that org in
    -- the roles array nor emit "role": null, which is not a valid OneRoster role object.
    from (
        select distinct on (staffDocumentId, schoolid) staffDocumentId, schoolid, staff_classification
        from staff_orgs
        order by staffDocumentId, schoolid, staff_classification nulls last
    ) so
        left join staff_primary_org spo
            on so.staffDocumentId = spo.staffDocumentId
    group by so.staffDocumentId
),
-- DS 6.1: StaffElectronicMail (person level) and StaffEducationOrganizationContactAssociation
-- (organization level) were both replaced by the StaffDirectory electronicMails collection, keyed
-- by education organization, so the two-source union collapses to one select.
staff_emails as (
    select
        sd."Staff_DocumentId" as staffDocumentId,
        sd."EducationOrganization_EducationOrganizationId" as educationorganizationid,
        sde."DoNotPublishIndicator" as donotpublishindicator,
        electronicMailTypeDescriptor."CodeValue" as email_type,
        sde."ElectronicMailAddress" as email_address,
        sde."ElectronicMailAddress" ~ '^[a-zA-Z0-9_.-]+[+]?[a-zA-Z0-9.-]*@[a-zA-Z0-9.-]+[.][a-zA-Z0-9]{2,9}$' as is_valid_email
    from edfi."StaffDirectoryElectronicMail" sde
        join edfi."StaffDirectory" sd
            on sde."StaffDirectory_DocumentId" = sd."DocumentId"
        join dms."Descriptor" electronicMailTypeDescriptor
            on sde."ElectronicMailTypeDescriptor_DescriptorId" = electronicMailTypeDescriptor."DescriptorId"
    -- exclude do-not-publish addresses before ranking, so a suppressed preferred
    -- address falls through to the next publishable one instead of leaving no email
    where sde."ElectronicMailAddress" is not null
      and (sde."DoNotPublishIndicator" is null or not sde."DoNotPublishIndicator")
),
-- Staff user rows are emitted per (staff, school), so the preferred address is resolved per
-- organization and joined on the school below. The second branch is the person-level fallback
-- row, keyed with a null organization, for rows with no school or no address at their school.
choose_email as (
    select
        staffDocumentId,
        educationorganizationid,
        email_address
    from (
        select
            *,
            row_number() over(
                partition by staffDocumentId, educationorganizationid
                order by (email_type = 'Work') desc nulls last, email_type, email_address
            ) as seq
        from staff_emails
    ) x
    where seq = 1
    union all
    select
        staffDocumentId,
        null::bigint as educationorganizationid,
        email_address
    from (
        select
            *,
            row_number() over(
                partition by staffDocumentId
                order by (email_type = 'Work') desc nulls last, email_type, email_address
            ) as seq
        from staff_emails
    ) y
    where seq = 1
),
formatted_users_staff as (
    select
        md5(
            case
                when so.schoolid is null then concat('STA-', staff.staffUniqueId::text)
                else concat('STA-', staff.staffUniqueId::text, '-', so.schoolid::text)
            end
        ) as "sourcedId",
        'active' as "status",
        staff.lastmodifieddate as "dateLastModified",
        null::text as "userMasterIdentifier",
        case when coalesce(choose_email.email_address, choose_email_any.email_address) is null then ''
             else coalesce(choose_email.email_address, choose_email_any.email_address) end as "username",
        -- jsonb_insert is strict: a null ids array would yield a null userIds, dropping even
        -- the mandatory staffUniqueId. Guarded the same way as the student path above.
        case when coalesce(staff_ids.ids, staff_ids_any.ids) is not null then
            jsonb_insert(
                coalesce(staff_ids.ids, staff_ids_any.ids)::jsonb,
                '{0}',
                json_build_object(
                    'type', 'staffUniqueId',
                    'identifier', staff.staffUniqueId
                )::jsonb
            )::json
        else
            json_build_array(json_build_object(
                'type', 'staffUniqueId',
                'identifier', staff.staffUniqueId
            ))
        end as "userIds",
        'true' as "enabledUser",
        staff.firstname as "givenName",
        staff.lastsurname as "familyName",
        staff.middlename as "middleName",
        staff.preferredfirstname as "preferredFirstName",
        null::text as "preferredMiddleName",
        staff.preferredlastsurname as "preferredLastName",
        null::text as "pronouns",
        staff_role.staff_classification as "role",
        staff_orgs_agg.roles AS "roles",
        null::text as "userProfiles",
        staff.staffUniqueId as "identifier",
        so.schoolid as "educationOrganizationId",
        staff.staffDocumentId as "participantDocumentId",
        coalesce(choose_email.email_address, choose_email_any.email_address) as "email",
        null::text as "sms",
        null::text as "phone",
        null::text as "agentSourceIds",
        null::json as "grades",
        null::text as "password",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'staffs',
                'naturalKey', json_build_object(
                    'staffUniqueId', staff.staffUniqueId
                ),
                'staffClassification', staff_role.staff_classification,
                'educationOrganizationId', so.schoolid
            )
        ) AS metadata
    from staff
        left join (select distinct staffDocumentId, schoolid from staff_orgs) so
            on staff.staffDocumentId = so.staffDocumentId
        -- staff_ids and choose_email are each joined twice: on the row's own school, and on the
        -- person-level fallback row (educationorganizationid null); the coalesces above prefer
        -- the school's own value.
        left join staff_ids
            on staff.staffDocumentId = staff_ids.staffDocumentId
            and staff_ids.educationorganizationid = so.schoolid
        left join staff_ids staff_ids_any
            on staff.staffDocumentId = staff_ids_any.staffDocumentId
            and staff_ids_any.educationorganizationid is null
        left join staff_role
            on staff.staffDocumentId = staff_role.staffDocumentId
        left join staff_orgs_agg
            on staff.staffDocumentId = staff_orgs_agg.staffDocumentId
        left join choose_email
            on staff.staffDocumentId = choose_email.staffDocumentId
            and choose_email.educationorganizationid = so.schoolid
        left join choose_email choose_email_any
            on staff.staffDocumentId = choose_email_any.staffDocumentId
            and choose_email_any.educationorganizationid is null
),
-- dedup to one row per (contact, school) first, so a contact linked to a student with
-- multiple enrollments (or to two students at the same school) does not fan out or
-- duplicate the org in the parent's roles.
contact_orgs as (
    select
        contactDocumentId,
        schoolid,
        row_number() over (
            partition by contactDocumentId
            order by max_entrydate desc, schoolid
        ) as seq
    from (
        select sca."Contact_DocumentId" as contactDocumentId, s.schoolid, max(ssa.entrydate) as max_entrydate
        from edfi."StudentContactAssociation" sca
        join student_school ssa on sca."Student_DocumentId" = ssa.studentDocumentId
        join school s on ssa.schoolid = s.schoolid
        group by sca."Contact_DocumentId", s.schoolid
    ) distinct_contact_school
),
contact_primary_org as (
    select contactDocumentId, schoolId
    from contact_orgs
    where seq = 1
),
parent_roles as (
    select
        contactDocumentId,
        json_agg(
            json_build_object(
                'roleType', 'primary',
                'role', 'parent',
                'org', json_build_object(
                    'href', concat('/orgs/', md5(schoolid::text)),
                    'sourcedId', md5(schoolid::text),
                    'type', 'org'
                )
            )
            -- deterministic order so the array matches the MSSQL artifact
            order by schoolid
        ) as roles
    from contact_orgs
    group by contactDocumentId
),
parent_emails as (
    select contactDocumentId, electronicmailaddress
    from (
        select
            ce."Contact_DocumentId" as contactDocumentId,
            ce."ElectronicMailAddress" as electronicmailaddress,
            row_number() over (
                partition by ce."Contact_DocumentId"
                order by ce."ElectronicMailAddress"
            ) as seq
        from edfi."ContactElectronicMail" ce
        where ce."PrimaryEmailAddressIndicator" and not ce."DoNotPublishIndicator"
    ) ranked
    where seq = 1
),
contact as (
    select
        c."DocumentId" as contactDocumentId,
        c."ContactUniqueId" as contactUniqueId,
        c."FirstName" as firstName,
        c."LastSurname" as lastSurname,
        c."MiddleName" as middleName,
        c."PreferredFirstName" as preferredFirstName,
        c."PreferredLastSurname" as preferredLastSurname,
        (c."ContentLastModifiedAt" at time zone 'UTC') as lastModifiedDate
    from edfi."Contact" c
),
formatted_users_parents as (
    select
        md5(
            case
                when cpo.schoolid is null then concat('PAR-', contact.contactUniqueId::text)
                else concat('PAR-', contact.contactUniqueId::text, '-', cpo.schoolid::text)
            end
        ) as "sourcedId",
        'active' as "status",
        contact.lastmodifieddate as "dateLastModified",
        null::text as "userMasterIdentifier",
        case when parent_emails.electronicmailaddress is null then '' else parent_emails.electronicmailaddress end as "username",
        json_build_array(json_build_object(
            'type', 'contactUniqueId',
            'identifier', contact.contactUniqueId
        )) as "userIds",
        'true' as "enabledUser",
        contact.firstname as "givenName",
        contact.lastsurname as "familyName",
        contact.middlename as "middleName",
        contact.preferredfirstname as "preferredFirstName",
        null::text as "preferredMiddleName",
        contact.preferredlastsurname as "preferredLastName",
        null::text as "pronouns",
        'parent' as "role",
        parent_roles.roles AS "roles",
        null::text as "userProfiles",
        contact.contactUniqueId as "identifier",
        cpo.schoolId as "educationOrganizationId",
        contact.contactDocumentId as "participantDocumentId",
        parent_emails.electronicmailaddress as "email",
        null::text as "sms",
        null::text as "phone",
        null::text as "agentSourceIds",
        null::json as "grades",
        null::text as "password",
        json_build_object(
            'edfi', json_build_object(
                'resource', 'contacts',
                'naturalKey', json_build_object(
                    'contactUniqueId', contact.contactUniqueId
                ),
                'educationOrganizationId', cpo.schoolId
            )
        ) AS metadata
    from contact
        left join parent_emails
            on contact.contactDocumentId = parent_emails.contactDocumentId
        left join parent_roles
            on contact.contactDocumentId = parent_roles.contactDocumentId
        left join contact_primary_org cpo
            on contact.contactDocumentId = cpo.contactDocumentId
)
select * from formatted_users_student
union all
select * from formatted_users_staff
union all
select * from formatted_users_parents;

create index if not exists users_sourcedid ON oneroster12.users ("sourcedId");
create index if not exists users_participantdocumentid ON oneroster12.users ("participantDocumentId");
