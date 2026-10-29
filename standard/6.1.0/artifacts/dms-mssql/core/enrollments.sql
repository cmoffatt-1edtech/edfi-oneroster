-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.enrollments on DMS (SQL Server). Same output as standard/6.1.0/artifacts/mssql/core/enrollments.sql.
-- StaffSectionAssociation and StudentSectionAssociation carry the full section identity
-- (Section_LocalCourseCode, Section_SchoolId, Section_SchoolYear, Section_SessionName,
-- Section_SectionIdentifier) and the person's unique id, so the ODS joins to Section, Staff and
-- Student are not needed (as in dms-pgsql/core/enrollments.sql). participantUSI becomes
-- participantDocumentId: the Staff_DocumentId / Student_DocumentId the auth views return.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.enrollments', 'U') IS NOT NULL
    DROP TABLE oneroster12.enrollments;
GO

CREATE TABLE oneroster12.enrollments (
    sourcedId NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    class NVARCHAR(MAX) NULL, -- JSON
    school NVARCHAR(MAX) NULL, -- JSON
    [user] NVARCHAR(MAX) NULL, -- JSON ('user' is a reserved word)
    educationOrganizationId BIGINT NULL,
    participantDocumentId BIGINT NULL,
    role NVARCHAR(32) NULL,
    [primary] NVARCHAR(8) NULL, -- 'primary' is a reserved word; OneRoster wants the string
    beginDate NVARCHAR(32) NULL,
    endDate NVARCHAR(32) NULL,
    metadata NVARCHAR(MAX) NULL, -- JSON
    CONSTRAINT PK_enrollments PRIMARY KEY (sourcedId)
);
GO

-- Primary access patterns: by role, by status, by dates
CREATE INDEX IX_enrollments_status_role ON oneroster12.enrollments (status, role);
CREATE INDEX IX_enrollments_dates ON oneroster12.enrollments (beginDate, endDate) WHERE beginDate IS NOT NULL;
-- API performance index for filtering
CREATE INDEX IX_enrollments_api_status_filter ON oneroster12.enrollments (status, dateLastModified) INCLUDE (role);
-- Authorization filters: org and participant lookups
CREATE INDEX IX_enrollments_educationOrganizationId ON oneroster12.enrollments (educationOrganizationId);
CREATE INDEX IX_enrollments_participantDocumentId ON oneroster12.enrollments (participantDocumentId) WHERE participantDocumentId IS NOT NULL;
GO

IF OBJECT_ID('oneroster12.sp_refresh_enrollments', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_enrollments;
GO

CREATE PROCEDURE oneroster12.sp_refresh_enrollments
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('enrollments', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_enrollments') IS NOT NULL
            DROP TABLE #staging_enrollments;

        SELECT TOP 0 * INTO #staging_enrollments FROM oneroster12.enrollments;

        -- Each section association yields its class, school and user sourcedIds once (CROSS APPLY),
        -- formatted exactly as the ODS file and dms-pgsql format them.
        WITH staff_enrollments_formatted AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(
                        CONCAT('STA-', LOWER(ssa.[Staff_StaffUniqueId]),
                               '-', LOWER(ssa.[Section_LocalCourseCode]),
                               '-', CAST(ssa.[Section_SchoolId] AS VARCHAR(50)),
                               '-', CAST(ssa.[Section_SchoolYear] AS VARCHAR(10)),
                               '-', LOWER(ssa.[Section_SectionIdentifier]),
                               '-', LOWER(ssa.[Section_SessionName]),
                               '-', CONVERT(VARCHAR(32), ssa.[BeginDate], 23))
                        AS VARCHAR(MAX)
                    ) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                'active' AS status,
                ssa.[ContentLastModifiedAt] AS dateLastModified,
                (SELECT
                    CONCAT('/classes/', keys.classSourcedId) AS href,
                    keys.classSourcedId AS sourcedId,
                    'class' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS class,
                (SELECT
                    CONCAT('/orgs/', keys.schoolSourcedId) AS href,
                    keys.schoolSourcedId AS sourcedId,
                    'org' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS school,
                (SELECT
                    CONCAT('/users/', keys.userSourcedId) AS href,
                    keys.userSourcedId AS sourcedId,
                    'user' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS [user],
                ssa.[Section_SchoolId] AS educationOrganizationId,
                ssa.[Staff_DocumentId] AS participantDocumentId,
                'teacher' AS role,
                -- primary is derived from the staff's ClassroomPositionDescriptor via the
                -- oneroster12/ClassroomPositionDescriptor crosswalk (e.g. 'Teacher of Record' => TRUE).
                -- Unmapped or missing positions default to 'false'.
                LOWER(COALESCE(mappedclassroomposition.[MappedValue], 'FALSE')) AS [primary],
                CONVERT(NVARCHAR(32), ssa.[BeginDate], 23) AS beginDate,
                CONVERT(NVARCHAR(32), ssa.[EndDate], 23) AS endDate,
                (SELECT
                    'staffSectionAssociations' AS [edfi.resource],
                    ssa.[Staff_StaffUniqueId] AS [edfi.naturalKey.staffUniqueId],
                    ssa.[Section_LocalCourseCode] AS [edfi.naturalKey.localCourseCode],
                    ssa.[Section_SchoolId] AS [edfi.naturalKey.schoolId],
                    ssa.[Section_SchoolYear] AS [edfi.naturalKey.schoolYear],
                    ssa.[Section_SectionIdentifier] AS [edfi.naturalKey.sectionIdentifier],
                    ssa.[Section_SessionName] AS [edfi.naturalKey.sessionName],
                    ssa.[BeginDate] AS [edfi.naturalKey.beginDate]
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata
            FROM edfi.[StaffSectionAssociation] ssa
            CROSS APPLY (SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(
                        CONCAT(LOWER(ssa.[Section_LocalCourseCode]),
                               '-', CAST(ssa.[Section_SchoolId] AS VARCHAR(50)),
                               '-', CAST(ssa.[Section_SchoolYear] AS VARCHAR(10)),
                               '-', LOWER(ssa.[Section_SectionIdentifier]),
                               '-', LOWER(ssa.[Section_SessionName]))
                        AS VARCHAR(MAX)
                    ) COLLATE Latin1_General_BIN), 2)) AS classSourcedId,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(ssa.[Section_SchoolId] AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS schoolSourcedId,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT('STA-', CAST(ssa.[Staff_StaffUniqueId] AS VARCHAR(256)), '-', CAST(ssa.[Section_SchoolId] AS VARCHAR(20))) AS VARCHAR(MAX))
                    COLLATE Latin1_General_BIN), 2)) AS userSourcedId
            ) keys
            LEFT JOIN dms.[Descriptor] classroompositiondescriptor
                ON ssa.[ClassroomPositionDescriptor_DescriptorId] = classroompositiondescriptor.[DescriptorId]
            LEFT JOIN edfi.[DescriptorMapping] mappedclassroomposition
                ON mappedclassroomposition.[Value] = classroompositiondescriptor.[CodeValue]
                AND mappedclassroomposition.[Namespace] = classroompositiondescriptor.[Namespace]
                AND mappedclassroomposition.[MappedNamespace] = 'uri://1edtech.org/oneroster12/ClassroomPositionDescriptor'
        ),
        student_enrollments_formatted AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(
                        CONCAT(LOWER(ssa.[Student_StudentUniqueId]),
                               '-', LOWER(ssa.[Section_LocalCourseCode]),
                               '-', CAST(ssa.[Section_SchoolId] AS VARCHAR(50)),
                               '-', CAST(ssa.[Section_SchoolYear] AS VARCHAR(10)),
                               '-', LOWER(ssa.[Section_SectionIdentifier]),
                               '-', LOWER(ssa.[Section_SessionName]),
                               '-', CONVERT(VARCHAR(32), ssa.[BeginDate], 23))
                        AS VARCHAR(MAX)
                    ) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                'active' AS status,
                ssa.[ContentLastModifiedAt] AS dateLastModified,
                (SELECT
                    CONCAT('/classes/', keys.classSourcedId) AS href,
                    keys.classSourcedId AS sourcedId,
                    'class' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS class,
                (SELECT
                    CONCAT('/orgs/', keys.schoolSourcedId) AS href,
                    keys.schoolSourcedId AS sourcedId,
                    'org' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS school,
                (SELECT
                    CONCAT('/users/', keys.userSourcedId) AS href,
                    keys.userSourcedId AS sourcedId,
                    'user' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS [user],
                ssa.[Section_SchoolId] AS educationOrganizationId,
                ssa.[Student_DocumentId] AS participantDocumentId,
                'student' AS role,
                'false' AS [primary],
                CONVERT(NVARCHAR(32), ssa.[BeginDate], 23) AS beginDate,
                CONVERT(NVARCHAR(32), ssa.[EndDate], 23) AS endDate,
                (SELECT
                    'studentSectionAssociations' AS [edfi.resource],
                    ssa.[Student_StudentUniqueId] AS [edfi.naturalKey.studentUniqueId],
                    ssa.[Section_LocalCourseCode] AS [edfi.naturalKey.localCourseCode],
                    ssa.[Section_SchoolId] AS [edfi.naturalKey.schoolId],
                    ssa.[Section_SchoolYear] AS [edfi.naturalKey.schoolYear],
                    ssa.[Section_SectionIdentifier] AS [edfi.naturalKey.sectionIdentifier],
                    ssa.[Section_SessionName] AS [edfi.naturalKey.sessionName],
                    ssa.[BeginDate] AS [edfi.naturalKey.beginDate]
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata
            FROM edfi.[StudentSectionAssociation] ssa
            CROSS APPLY (SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(
                        CONCAT(LOWER(ssa.[Section_LocalCourseCode]),
                               '-', CAST(ssa.[Section_SchoolId] AS VARCHAR(50)),
                               '-', CAST(ssa.[Section_SchoolYear] AS VARCHAR(10)),
                               '-', LOWER(ssa.[Section_SectionIdentifier]),
                               '-', LOWER(ssa.[Section_SessionName]))
                        AS VARCHAR(MAX)
                    ) COLLATE Latin1_General_BIN), 2)) AS classSourcedId,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(ssa.[Section_SchoolId] AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS schoolSourcedId,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT('STU-', CAST(ssa.[Student_StudentUniqueId] AS VARCHAR(256)), '-', CAST(ssa.[Section_SchoolId] AS VARCHAR(20))) AS VARCHAR(MAX))
                    COLLATE Latin1_General_BIN), 2)) AS userSourcedId
            ) keys
        )
        INSERT INTO #staging_enrollments
            (sourcedId, status, dateLastModified, class, school, [user], educationOrganizationId,
             participantDocumentId, role, [primary], beginDate, endDate, metadata)
        SELECT sourcedId, status, dateLastModified, class, school, [user], educationOrganizationId,
               participantDocumentId, role, [primary], beginDate, endDate, metadata
        FROM (
            SELECT * FROM staff_enrollments_formatted
            UNION ALL
            SELECT * FROM student_enrollments_formatted
        ) AS combined_enrollments;

        SET @RowCount = @@ROWCOUNT;

        -- Atomic swap
        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.enrollments;
            INSERT INTO oneroster12.enrollments SELECT * FROM #staging_enrollments;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Success', row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_enrollments;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT @ErrorMessage = ERROR_MESSAGE(), @ErrorSeverity = ERROR_SEVERITY(), @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('enrollments', @ErrorMessage, @ErrorSeverity, @ErrorState, 'sp_refresh_enrollments', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
