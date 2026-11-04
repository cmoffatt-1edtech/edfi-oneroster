-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.users on DMS (SQL Server), Data Standard 6.1. Same output as
-- standard/6.1.0/artifacts/dms-pgsql/core/users.sql, built the way standard/6.1.0/artifacts/mssql/core/users.sql
-- builds it (indexed #temp steps, then one insert per user type). Where the ODS SQL Server file departs
-- from the PostgreSQL logic, this file follows PostgreSQL:
--   * a student's primary org is ranked by PrimarySchool, then EntryDate desc, then schoolId;
--   * a staff member's roles carry the classification of each school (a null one as "role":null),
--     and every DescriptorMapping row joins (no dedup to one MappedValue);
--   * a student with no enrollment gets grades [null].
-- participantUSI is participantDocumentId (the person's [DocumentId]). DMS has no CreateDate, so a
-- staff member's primary org is ranked by the StaffSchoolAssociation [DocumentId] desc, then
-- schoolId, as on dms-pgsql.
-- DS 6.1: student identification codes are the StudentIdentificationCode resource; student and staff
-- e-mail addresses are the electronicMails collections of StudentDirectory and StaffDirectory, keyed
-- by education organization (StaffDirectory replaces StaffElectronicMail and
-- StaffEducationOrganizationContactAssociation); StaffIdentificationCode is keyed by education
-- organization. Staff identifiers and e-mail are resolved per school with a person-level fallback,
-- and a staff member's roles hold one entry per school, preferring a mapped classification.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.users', 'U') IS NOT NULL
    DROP TABLE oneroster12.users;
GO

CREATE TABLE oneroster12.users (
    sourcedId NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    userMasterIdentifier NVARCHAR(256) NULL,
    username NVARCHAR(256) NULL,
    userIds NVARCHAR(MAX) NULL, -- JSON array
    enabledUser NVARCHAR(8) NOT NULL DEFAULT 'true',
    givenName NVARCHAR(256) NULL,
    familyName NVARCHAR(256) NULL,
    middleName NVARCHAR(256) NULL,
    preferredFirstName NVARCHAR(256) NULL,
    preferredMiddleName NVARCHAR(256) NULL,
    preferredLastName NVARCHAR(256) NULL,
    pronouns NVARCHAR(64) NULL,
    role NVARCHAR(32) NULL,
    roles NVARCHAR(MAX) NULL, -- JSON array
    userProfiles NVARCHAR(MAX) NULL,
    identifier NVARCHAR(256) NULL,
    email NVARCHAR(256) NULL,
    sms NVARCHAR(32) NULL,
    phone NVARCHAR(32) NULL,
    agentSourceIds NVARCHAR(MAX) NULL,
    grades NVARCHAR(MAX) NULL, -- JSON array
    password NVARCHAR(256) NULL,
    educationOrganizationId BIGINT NULL,
    participantDocumentId BIGINT NULL,
    metadata NVARCHAR(MAX) NULL, -- JSON
    CONSTRAINT PK_users PRIMARY KEY (sourcedId)
);
GO

CREATE INDEX IX_users_role_status ON oneroster12.users (role, status) INCLUDE (givenName, familyName, username);
CREATE INDEX IX_users_identifier ON oneroster12.users (identifier) WHERE identifier IS NOT NULL;
CREATE INDEX IX_users_username ON oneroster12.users (username) WHERE username IS NOT NULL;
CREATE INDEX IX_users_email ON oneroster12.users (email) WHERE email IS NOT NULL;
CREATE INDEX IX_users_lastmodified ON oneroster12.users (dateLastModified) WHERE dateLastModified IS NOT NULL;
-- Authorization filters: org and participant lookups
CREATE INDEX IX_users_educationOrganizationId ON oneroster12.users (educationOrganizationId) WHERE educationOrganizationId IS NOT NULL;
CREATE INDEX IX_users_participantDocumentId ON oneroster12.users (participantDocumentId);
GO

IF OBJECT_ID('oneroster12.sp_refresh_users', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_users;
GO

CREATE PROCEDURE oneroster12.sp_refresh_users
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('users', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_users') IS NOT NULL
            DROP TABLE #staging_users;

        -- Heap: uniqueness is checked by an index built once after the load (below).
        SELECT TOP 0 * INTO #staging_users FROM oneroster12.users;

        -- Each step is materialized into an indexed #temp table, as in the ODS file: SQL Server
        -- does not materialize CTEs, so one big WITH would re-expand the chains per row.
        -- JSON is built as text; STRING_ESCAPE keeps it valid for any value.

        -- ---- Students -------------------------------------------------------

        -- Latest grade level per student. Partitioned by student alone (not student, school year),
        -- so a student with enrollments in several years yields one user row. ExitWithdrawDate
        -- sorts NULLS FIRST, as PostgreSQL's DESC does: an open enrollment outranks a withdrawn one.
        SELECT x.studentDocumentId, x.grade_level
        INTO #student_grade
        FROM (
            SELECT
                ssa.[Student_DocumentId] AS studentDocumentId,
                gld.[CodeValue] AS grade_level,
                ROW_NUMBER() OVER (
                    PARTITION BY ssa.[Student_DocumentId]
                    ORDER BY
                        ssa.[EntryDate] DESC,
                        CASE WHEN ssa.[ExitWithdrawDate] IS NULL THEN 0 ELSE 1 END,
                        ssa.[ExitWithdrawDate] DESC,
                        gld.[CodeValue] DESC
                ) AS seq
            FROM edfi.[StudentSchoolAssociation] ssa
                JOIN dms.[Descriptor] gld
                    ON ssa.[EntryGradeLevelDescriptor_DescriptorId] = gld.[DescriptorId]
        ) x
        WHERE x.seq = 1;
        CREATE CLUSTERED INDEX IX_tmp_student_grade ON #student_grade (studentDocumentId);

        -- Student identification codes per (student, ed org): the JSON objects, comma-separated,
        -- ordered by system; the userIds array puts the studentUniqueId first.
        SELECT
            sid.[Student_DocumentId] AS studentDocumentId,
            sid.[EducationOrganization_EducationOrganizationId] AS educationOrganizationId,
            STRING_AGG(
                CAST(
                    '{"type":"' + STRING_ESCAPE(d.[CodeValue], 'json') +
                    '","identifier":"' + STRING_ESCAPE(sid.[IdentificationCode], 'json') + '"}'
                AS NVARCHAR(MAX)),
                ','
            ) WITHIN GROUP (ORDER BY d.[CodeValue]) AS ids
        INTO #student_ids
        FROM edfi.[StudentIdentificationCode] sid
            JOIN dms.[Descriptor] d
                ON sid.[StudentIdentificationSystemDescriptor_DescriptorId] = d.[DescriptorId]
        GROUP BY sid.[Student_DocumentId], sid.[EducationOrganization_EducationOrganizationId];
        CREATE CLUSTERED INDEX IX_tmp_student_ids ON #student_ids (studentDocumentId, educationOrganizationId);

        -- Preferred student email (Home/Personal first, then by type). Do-not-publish addresses are
        -- dropped before ranking, so a suppressed preferred address falls through to the next one.
        SELECT x.studentDocumentId, x.electronicMailAddress
        INTO #student_email
        FROM (
            SELECT
                sd.[Student_DocumentId] AS studentDocumentId,
                seoa_et.[ElectronicMailAddress] AS electronicMailAddress,
                ROW_NUMBER() OVER (
                    PARTITION BY sd.[Student_DocumentId]
                    ORDER BY
                        CASE WHEN d.[CodeValue] = 'Home/Personal' THEN 0 ELSE 1 END,
                        d.[CodeValue]
                ) AS seq
            FROM edfi.[StudentDirectoryElectronicMail] seoa_et
                JOIN edfi.[StudentDirectory] sd
                    ON seoa_et.[StudentDirectory_DocumentId] = sd.[DocumentId]
                JOIN dms.[Descriptor] d
                    ON seoa_et.[ElectronicMailTypeDescriptor_DescriptorId] = d.[DescriptorId]
            WHERE seoa_et.[DoNotPublishIndicator] IS NULL OR seoa_et.[DoNotPublishIndicator] = 0
        ) x
        WHERE x.seq = 1;
        CREATE CLUSTERED INDEX IX_tmp_student_email ON #student_email (studentDocumentId);

        -- Student enrollments at existing schools (one row per enrollment); contacts use it too.
        SELECT
            ssa.[Student_DocumentId] AS studentDocumentId,
            sch.[SchoolId] AS schoolId,
            ssa.[PrimarySchool] AS primarySchool,
            ssa.[EntryDate] AS entryDate
        INTO #student_orgs
        FROM edfi.[StudentSchoolAssociation] ssa
            JOIN edfi.[School] sch
                ON ssa.[School_SchoolId] = sch.[SchoolId];
        CREATE CLUSTERED INDEX IX_tmp_student_orgs ON #student_orgs (studentDocumentId, schoolId);

        -- Primary school per student: flagged PrimarySchool first, then the latest entry, then schoolId
        SELECT studentDocumentId, schoolId
        INTO #student_primary_org
        FROM (
            SELECT
                studentDocumentId,
                schoolId,
                ROW_NUMBER() OVER (
                    PARTITION BY studentDocumentId
                    ORDER BY
                        CASE WHEN primarySchool = 1 THEN 1 ELSE 0 END DESC,
                        entryDate DESC,
                        schoolId
                ) AS seq
            FROM #student_orgs
        ) ranked
        WHERE seq = 1;
        CREATE CLUSTERED INDEX IX_tmp_student_primary_org ON #student_primary_org (studentDocumentId);

        -- One row per (student, school): a re-enrollment at the same school must not duplicate the
        -- school-keyed user sourcedId or the org in roles.
        SELECT DISTINCT
            studentDocumentId,
            schoolId,
            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(schoolId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS orgSourcedId
        INTO #student_school
        FROM #student_orgs;
        CREATE CLUSTERED INDEX IX_tmp_student_school ON #student_school (studentDocumentId, schoolId);

        SELECT
            ss.studentDocumentId,
            '[' + STRING_AGG(
                CAST(
                    '{"roleType":"' +
                    CASE WHEN spo.schoolId IS NOT NULL AND ss.schoolId = spo.schoolId
                         THEN 'primary' ELSE 'secondary' END +
                    '","role":"student","org":{"href":"/orgs/' + ss.orgSourcedId +
                    '","sourcedId":"' + ss.orgSourcedId + '","type":"org"}}'
                AS NVARCHAR(MAX)),
                ','
            ) WITHIN GROUP (ORDER BY ss.schoolId) + ']' AS roles
        INTO #student_orgs_agg
        FROM #student_school ss
            LEFT JOIN #student_primary_org spo
                ON ss.studentDocumentId = spo.studentDocumentId
        GROUP BY ss.studentDocumentId;
        CREATE CLUSTERED INDEX IX_tmp_student_orgs_agg ON #student_orgs_agg (studentDocumentId);

        -- ---- Staff ----------------------------------------------------------

        SELECT DISTINCT [Staff_DocumentId] AS staffDocumentId
        INTO #teaching_staff
        FROM edfi.[StaffSectionAssociation];
        CREATE CLUSTERED INDEX IX_tmp_teaching_staff ON #teaching_staff (staffDocumentId);

        -- Classification per staff school association: the school-level assignment's mapped value,
        -- else the LEA-level one. More than one row per association when a staff member has several
        -- assignments (or a classification several mappings), as on PostgreSQL.
        SELECT
            ssa.[DocumentId] AS staffSchoolAssociationDocumentId,
            ssa.[Staff_DocumentId] AS staffDocumentId,
            sch.[SchoolId] AS schoolId,
            COALESCE(mappedschool.[MappedValue], mappedlea.[MappedValue]) AS staff_classification
        INTO #staff_orgs
        FROM edfi.[StaffSchoolAssociation] ssa
            JOIN edfi.[School] sch
                ON ssa.[School_SchoolId] = sch.[SchoolId]
            LEFT JOIN edfi.[StaffEducationOrganizationAssignmentAssociation] school_assign
                ON ssa.[Staff_DocumentId] = school_assign.[Staff_DocumentId]
                AND sch.[SchoolId] = school_assign.[EducationOrganization_EducationOrganizationId]
            LEFT JOIN edfi.[StaffEducationOrganizationAssignmentAssociation] lea_assign
                ON ssa.[Staff_DocumentId] = lea_assign.[Staff_DocumentId]
                AND sch.[LocalEducationAgency_LocalEducationAgencyId] = lea_assign.[EducationOrganization_EducationOrganizationId]
            LEFT JOIN dms.[Descriptor] schoolclassification
                ON school_assign.[StaffClassificationDescriptor_DescriptorId] = schoolclassification.[DescriptorId]
            LEFT JOIN edfi.[DescriptorMapping] mappedschool
                ON mappedschool.[Value] = schoolclassification.[CodeValue]
                AND mappedschool.[Namespace] = schoolclassification.[Namespace]
                AND mappedschool.[MappedNamespace] = 'uri://1edtech.org/oneroster12/StaffClassificationDescriptor'
            LEFT JOIN dms.[Descriptor] leaclassification
                ON lea_assign.[StaffClassificationDescriptor_DescriptorId] = leaclassification.[DescriptorId]
            LEFT JOIN edfi.[DescriptorMapping] mappedlea
                ON mappedlea.[Value] = leaclassification.[CodeValue]
                AND mappedlea.[Namespace] = leaclassification.[Namespace]
                AND mappedlea.[MappedNamespace] = 'uri://1edtech.org/oneroster12/StaffClassificationDescriptor';
        CREATE CLUSTERED INDEX IX_tmp_staff_orgs ON #staff_orgs (staffDocumentId, schoolId);

        -- One role per staff member who has a classification or teaches a section. The window
        -- orders by the unmapped value with NULLS LAST, as PostgreSQL's ASC does; a staff member
        -- with no mapped classification is a teacher.
        SELECT staffDocumentId, staff_classification
        INTO #staff_role
        FROM (
            SELECT
                so.staffDocumentId,
                COALESCE(so.staff_classification, 'teacher') AS staff_classification,
                ROW_NUMBER() OVER (
                    PARTITION BY so.staffDocumentId
                    ORDER BY CASE WHEN so.staff_classification IS NULL THEN 1 ELSE 0 END, so.staff_classification
                ) AS seq
            FROM #staff_orgs so
                LEFT JOIN #teaching_staff ts
                    ON so.staffDocumentId = ts.staffDocumentId
            WHERE so.staff_classification IS NOT NULL OR ts.staffDocumentId IS NOT NULL
        ) x
        WHERE seq = 1;
        CREATE CLUSTERED INDEX IX_tmp_staff_role ON #staff_role (staffDocumentId);

        -- Staff identification codes per (staff, ed org): StaffIdentificationCode is keyed by
        -- education organization in DS 6.1, so the same identifier can be recorded at several
        -- organizations. Plus one person-level row per staff member (NULL organization) for user
        -- rows with no school or no codes at their school; DISTINCT keeps an identifier recorded at
        -- several organizations from repeating there.
        SELECT
            sic.[Staff_DocumentId] AS staffDocumentId,
            sic.[EducationOrganization_EducationOrganizationId] AS educationOrganizationId,
            d.[CodeValue] AS code_value,
            sic.[IdentificationCode] AS identification_code
        INTO #staff_ids_base
        FROM edfi.[StaffIdentificationCode] sic
            JOIN dms.[Descriptor] d
                ON sic.[StaffIdentificationSystemDescriptor_DescriptorId] = d.[DescriptorId];

        SELECT
            staffDocumentId,
            educationOrganizationId,
            STRING_AGG(
                CAST(
                    '{"type":"' + STRING_ESCAPE(code_value, 'json') +
                    '","identifier":"' + STRING_ESCAPE(identification_code, 'json') + '"}'
                AS NVARCHAR(MAX)),
                ','
            ) WITHIN GROUP (ORDER BY code_value) AS ids
        INTO #staff_ids
        FROM #staff_ids_base
        GROUP BY staffDocumentId, educationOrganizationId
        UNION ALL
        SELECT
            staffDocumentId,
            CAST(NULL AS BIGINT),
            STRING_AGG(
                CAST(
                    '{"type":"' + STRING_ESCAPE(code_value, 'json') +
                    '","identifier":"' + STRING_ESCAPE(identification_code, 'json') + '"}'
                AS NVARCHAR(MAX)),
                ','
            ) WITHIN GROUP (ORDER BY code_value) AS ids
        FROM (SELECT DISTINCT staffDocumentId, code_value, identification_code FROM #staff_ids_base) deduped
        GROUP BY staffDocumentId;
        CREATE CLUSTERED INDEX IX_tmp_staff_ids ON #staff_ids (staffDocumentId, educationOrganizationId);

        -- Primary school per staff member: the latest association ([DocumentId] desc, as there is
        -- no CreateDate on DMS), then schoolId
        SELECT staffDocumentId, schoolId
        INTO #staff_primary_org
        FROM (
            SELECT
                staffDocumentId,
                schoolId,
                ROW_NUMBER() OVER (
                    PARTITION BY staffDocumentId
                    ORDER BY staffSchoolAssociationDocumentId DESC, schoolId
                ) AS seq
            FROM #staff_orgs
        ) ranked
        WHERE seq = 1;
        CREATE CLUSTERED INDEX IX_tmp_staff_primary_org ON #staff_primary_org (staffDocumentId);

        -- roles: one entry per (staff, school), preferring a mapped classification over an unmapped
        -- (null) one, so several assignments to the same school neither duplicate the org nor emit
        -- "role":null when a mapped one exists.
        SELECT
            sod.staffDocumentId,
            '[' + STRING_AGG(
                CAST(
                    '{"roleType":"' +
                    CASE WHEN spo.schoolId IS NOT NULL AND sod.schoolId = spo.schoolId
                         THEN 'primary' ELSE 'secondary' END +
                    '","role":' + ISNULL('"' + STRING_ESCAPE(sod.staff_classification, 'json') + '"', 'null') +
                    ',"org":{"href":"/orgs/' + sod.orgSourcedId +
                    '","sourcedId":"' + sod.orgSourcedId + '","type":"org"}}'
                AS NVARCHAR(MAX)),
                ','
            ) WITHIN GROUP (ORDER BY sod.schoolId) + ']' AS roles
        INTO #staff_orgs_agg
        FROM (
            SELECT
                staffDocumentId,
                schoolId,
                staff_classification,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(schoolId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS orgSourcedId
            FROM (
                SELECT
                    staffDocumentId,
                    schoolId,
                    staff_classification,
                    ROW_NUMBER() OVER (
                        PARTITION BY staffDocumentId, schoolId
                        ORDER BY CASE WHEN staff_classification IS NULL THEN 1 ELSE 0 END, staff_classification
                    ) AS seq
                FROM #staff_orgs
            ) ranked
            WHERE seq = 1
        ) sod
            LEFT JOIN #staff_primary_org spo
                ON sod.staffDocumentId = spo.staffDocumentId
        GROUP BY sod.staffDocumentId;
        CREATE CLUSTERED INDEX IX_tmp_staff_orgs_agg ON #staff_orgs_agg (staffDocumentId);

        -- One user row per (staff, school)
        SELECT DISTINCT staffDocumentId, schoolId
        INTO #staff_school
        FROM #staff_orgs;
        CREATE CLUSTERED INDEX IX_tmp_staff_school ON #staff_school (staffDocumentId, schoolId);

        -- Preferred staff email per (staff, ed org) from StaffDirectory: Work first, then by type,
        -- then by address. Do-not-publish addresses are dropped before ranking. Plus one person-level
        -- row per staff member (NULL organization), ranked the same way across all organizations, for
        -- user rows with no school or no address at their school.
        SELECT
            sd.[Staff_DocumentId] AS staffDocumentId,
            sd.[EducationOrganization_EducationOrganizationId] AS educationOrganizationId,
            d.[CodeValue] AS email_type,
            sde.[ElectronicMailAddress] AS email_address
        INTO #staff_emails
        FROM edfi.[StaffDirectoryElectronicMail] sde
            JOIN edfi.[StaffDirectory] sd
                ON sde.[StaffDirectory_DocumentId] = sd.[DocumentId]
            JOIN dms.[Descriptor] d
                ON sde.[ElectronicMailTypeDescriptor_DescriptorId] = d.[DescriptorId]
        WHERE sde.[ElectronicMailAddress] IS NOT NULL
            AND (sde.[DoNotPublishIndicator] IS NULL OR sde.[DoNotPublishIndicator] = 0);

        SELECT staffDocumentId, educationOrganizationId, email_address
        INTO #staff_email
        FROM (
            SELECT
                staffDocumentId,
                educationOrganizationId,
                email_address,
                ROW_NUMBER() OVER (
                    PARTITION BY staffDocumentId, educationOrganizationId
                    ORDER BY CASE WHEN email_type = 'Work' THEN 0 ELSE 1 END, email_type, email_address
                ) AS seq
            FROM #staff_emails
        ) x
        WHERE x.seq = 1
        UNION ALL
        SELECT staffDocumentId, CAST(NULL AS BIGINT), email_address
        FROM (
            SELECT
                staffDocumentId,
                email_address,
                ROW_NUMBER() OVER (
                    PARTITION BY staffDocumentId
                    ORDER BY CASE WHEN email_type = 'Work' THEN 0 ELSE 1 END, email_type, email_address
                ) AS seq
            FROM #staff_emails
        ) y
        WHERE y.seq = 1;
        CREATE CLUSTERED INDEX IX_tmp_staff_email ON #staff_email (staffDocumentId, educationOrganizationId);

        -- ---- Contacts / Parents --------------------------------------------

        -- Preferred contact email: primary and publishable, first by address
        SELECT x.contactDocumentId, x.electronicMailAddress
        INTO #contact_email
        FROM (
            SELECT
                ce.[Contact_DocumentId] AS contactDocumentId,
                ce.[ElectronicMailAddress] AS electronicMailAddress,
                ROW_NUMBER() OVER (
                    PARTITION BY ce.[Contact_DocumentId]
                    ORDER BY ce.[ElectronicMailAddress]
                ) AS seq
            FROM edfi.[ContactElectronicMail] ce
            WHERE ce.[PrimaryEmailAddressIndicator] = 1
              AND ce.[DoNotPublishIndicator] = 0
        ) x
        WHERE x.seq = 1;
        CREATE CLUSTERED INDEX IX_tmp_contact_email ON #contact_email (contactDocumentId);

        -- Contact schools, one row per (contact, school) first, so a contact linked to a student with
        -- several enrollments (or to two students at the same school) does not fan out or duplicate
        -- the org in roles. The latest entry ranks first.
        SELECT
            contactDocumentId,
            schoolId,
            ROW_NUMBER() OVER (
                PARTITION BY contactDocumentId
                ORDER BY max_entrydate DESC, schoolId
            ) AS seq
        INTO #contact_orgs
        FROM (
            SELECT
                sca.[Contact_DocumentId] AS contactDocumentId,
                so.schoolId,
                MAX(so.entryDate) AS max_entrydate
            FROM edfi.[StudentContactAssociation] sca
                JOIN #student_orgs so
                    ON sca.[Student_DocumentId] = so.studentDocumentId
            GROUP BY sca.[Contact_DocumentId], so.schoolId
        ) distinct_contact_school;
        CREATE CLUSTERED INDEX IX_tmp_contact_orgs ON #contact_orgs (contactDocumentId);

        -- Primary school (keys the single contact user row)
        SELECT contactDocumentId, schoolId
        INTO #contact_primary_org
        FROM #contact_orgs
        WHERE seq = 1;
        CREATE CLUSTERED INDEX IX_tmp_contact_primary_org ON #contact_primary_org (contactDocumentId);

        SELECT
            co.contactDocumentId,
            '[' + STRING_AGG(
                CAST(
                    '{"roleType":"primary","role":"parent","org":{"href":"/orgs/' +
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(co.schoolId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) +
                    '","sourcedId":"' +
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(co.schoolId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) +
                    '","type":"org"}}'
                AS NVARCHAR(MAX)),
                ','
            ) WITHIN GROUP (ORDER BY co.schoolId) + ']' AS roles
        INTO #parent_roles
        FROM #contact_orgs co
        GROUP BY co.contactDocumentId;
        CREATE CLUSTERED INDEX IX_tmp_parent_roles ON #parent_roles (contactDocumentId);

        -- ---- Staging: one insert per user type ---------------------------

        INSERT INTO #staging_users
            (sourcedId, status, dateLastModified, userMasterIdentifier, username, userIds, enabledUser,
             givenName, familyName, middleName, preferredFirstName, preferredMiddleName, preferredLastName,
             pronouns, role, roles, userProfiles, identifier, email, sms, phone, agentSourceIds, grades,
             password, educationOrganizationId, participantDocumentId, metadata)
        SELECT
            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                CONVERT(VARCHAR(4000),
                    CASE
                        WHEN ss.schoolId IS NULL THEN 'STU-' + CONVERT(VARCHAR(256), s.[StudentUniqueId])
                        ELSE 'STU-' + CONVERT(VARCHAR(256), s.[StudentUniqueId]) + '-' + CONVERT(VARCHAR(20), ss.schoolId)
                    END
                ) COLLATE Latin1_General_BIN), 2)),
            'active',
            s.[ContentLastModifiedAt],
            NULL,
            ISNULL(se.electronicMailAddress, ''),
            '[{"type":"studentUniqueId","identifier":"' + STRING_ESCAPE(s.[StudentUniqueId], 'json') + '"}' +
                ISNULL(',' + si.ids, '') + ']',
            'true',
            s.[FirstName],
            s.[LastSurname],
            s.[MiddleName],
            s.[PreferredFirstName],
            NULL,
            s.[PreferredLastSurname],
            NULL,
            'student',
            soa.roles,
            NULL,
            s.[StudentUniqueId],
            se.electronicMailAddress,
            NULL,
            NULL,
            NULL,
            '[' + ISNULL('"' + STRING_ESCAPE(sg.grade_level, 'json') + '"', 'null') + ']',
            NULL,
            ss.schoolId,
            s.[DocumentId],
            '{"edfi":{"resource":"students","naturalKey":{"studentUniqueId":"' + STRING_ESCAPE(s.[StudentUniqueId], 'json') +
                '"},"educationOrganizationId":' + ISNULL(CONVERT(VARCHAR(20), ss.schoolId), 'null') + '}}'
        FROM edfi.[Student] s
            LEFT JOIN #student_grade sg
                ON s.[DocumentId] = sg.studentDocumentId
            LEFT JOIN #student_orgs_agg soa
                ON s.[DocumentId] = soa.studentDocumentId
            LEFT JOIN #student_school ss
                ON s.[DocumentId] = ss.studentDocumentId
            LEFT JOIN #student_ids si
                ON s.[DocumentId] = si.studentDocumentId
                AND si.educationOrganizationId = ss.schoolId
            LEFT JOIN #student_email se
                ON s.[DocumentId] = se.studentDocumentId;

        INSERT INTO #staging_users
            (sourcedId, status, dateLastModified, userMasterIdentifier, username, userIds, enabledUser,
             givenName, familyName, middleName, preferredFirstName, preferredMiddleName, preferredLastName,
             pronouns, role, roles, userProfiles, identifier, email, sms, phone, agentSourceIds, grades,
             password, educationOrganizationId, participantDocumentId, metadata)
        SELECT
            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                CONVERT(VARCHAR(4000),
                    CASE
                        WHEN sso.schoolId IS NULL THEN 'STA-' + CONVERT(VARCHAR(256), st.[StaffUniqueId])
                        ELSE 'STA-' + CONVERT(VARCHAR(256), st.[StaffUniqueId]) + '-' + CONVERT(VARCHAR(20), sso.schoolId)
                    END
                ) COLLATE Latin1_General_BIN), 2)),
            'active',
            st.[ContentLastModifiedAt],
            NULL,
            ISNULL(COALESCE(ste.email_address, ste_any.email_address), ''),
            '[{"type":"staffUniqueId","identifier":"' + STRING_ESCAPE(st.[StaffUniqueId], 'json') + '"}' +
                ISNULL(',' + COALESCE(sti.ids, sti_any.ids), '') + ']',
            'true',
            st.[FirstName],
            st.[LastSurname],
            st.[MiddleName],
            st.[PreferredFirstName],
            NULL,
            st.[PreferredLastSurname],
            NULL,
            sr.staff_classification,
            stoa.roles,
            NULL,
            st.[StaffUniqueId],
            COALESCE(ste.email_address, ste_any.email_address),
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            sso.schoolId,
            st.[DocumentId],
            '{"edfi":{"resource":"staffs","naturalKey":{"staffUniqueId":"' + STRING_ESCAPE(st.[StaffUniqueId], 'json') +
                '"},"staffClassification":' + ISNULL('"' + STRING_ESCAPE(sr.staff_classification, 'json') + '"', 'null') +
                ',"educationOrganizationId":' + ISNULL(CONVERT(VARCHAR(20), sso.schoolId), 'null') + '}}'
        -- #staff_school comes first: the organization-scoped joins below reference sso.schoolId.
        -- #staff_ids and #staff_email are each joined twice, on the row's own school and on the
        -- person-level row (NULL organization); the COALESCEs prefer the school's own value.
        FROM edfi.[Staff] st
            LEFT JOIN #staff_school sso
                ON st.[DocumentId] = sso.staffDocumentId
            LEFT JOIN #staff_ids sti
                ON st.[DocumentId] = sti.staffDocumentId
                AND sti.educationOrganizationId = sso.schoolId
            LEFT JOIN #staff_ids sti_any
                ON st.[DocumentId] = sti_any.staffDocumentId
                AND sti_any.educationOrganizationId IS NULL
            LEFT JOIN #staff_role sr
                ON st.[DocumentId] = sr.staffDocumentId
            LEFT JOIN #staff_orgs_agg stoa
                ON st.[DocumentId] = stoa.staffDocumentId
            LEFT JOIN #staff_email ste
                ON st.[DocumentId] = ste.staffDocumentId
                AND ste.educationOrganizationId = sso.schoolId
            LEFT JOIN #staff_email ste_any
                ON st.[DocumentId] = ste_any.staffDocumentId
                AND ste_any.educationOrganizationId IS NULL;

        INSERT INTO #staging_users
            (sourcedId, status, dateLastModified, userMasterIdentifier, username, userIds, enabledUser,
             givenName, familyName, middleName, preferredFirstName, preferredMiddleName, preferredLastName,
             pronouns, role, roles, userProfiles, identifier, email, sms, phone, agentSourceIds, grades,
             password, educationOrganizationId, participantDocumentId, metadata)
        SELECT
            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                CONVERT(VARCHAR(4000),
                    CASE
                        WHEN cpo.schoolId IS NULL THEN 'PAR-' + CONVERT(VARCHAR(256), c.[ContactUniqueId])
                        ELSE 'PAR-' + CONVERT(VARCHAR(256), c.[ContactUniqueId]) + '-' + CONVERT(VARCHAR(20), cpo.schoolId)
                    END
                ) COLLATE Latin1_General_BIN), 2)),
            'active',
            c.[ContentLastModifiedAt],
            NULL,
            ISNULL(ce.electronicMailAddress, ''),
            '[{"type":"contactUniqueId","identifier":"' + STRING_ESCAPE(c.[ContactUniqueId], 'json') + '"}]',
            'true',
            c.[FirstName],
            c.[LastSurname],
            c.[MiddleName],
            c.[PreferredFirstName],
            NULL,
            c.[PreferredLastSurname],
            NULL,
            'parent',
            pr.roles,
            NULL,
            c.[ContactUniqueId],
            ce.electronicMailAddress,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            cpo.schoolId,
            c.[DocumentId],
            '{"edfi":{"resource":"contacts","naturalKey":{"contactUniqueId":"' + STRING_ESCAPE(c.[ContactUniqueId], 'json') +
                '"},"educationOrganizationId":' + ISNULL(CONVERT(VARCHAR(20), cpo.schoolId), 'null') + '}}'
        FROM edfi.[Contact] c
            LEFT JOIN #contact_email ce
                ON c.[DocumentId] = ce.contactDocumentId
            LEFT JOIN #parent_roles pr
                ON c.[DocumentId] = pr.contactDocumentId
            LEFT JOIN #contact_primary_org cpo
                ON c.[DocumentId] = cpo.contactDocumentId;

        -- Check sourcedId uniqueness once, after the load and before the swap
        CREATE UNIQUE NONCLUSTERED INDEX IX_staging_users_sourcedId ON #staging_users (sourcedId);

        SET @RowCount = (SELECT COUNT(*) FROM #staging_users);

        -- Atomic swap
        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.users;
            INSERT INTO oneroster12.users SELECT * FROM #staging_users;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Success', row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_users;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT @ErrorMessage = ERROR_MESSAGE(), @ErrorSeverity = ERROR_SEVERITY(), @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('users', @ErrorMessage, @ErrorSeverity, @ErrorState, 'sp_refresh_users', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
