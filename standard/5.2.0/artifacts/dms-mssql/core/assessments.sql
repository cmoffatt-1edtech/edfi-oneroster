-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional): oneroster12.assessments on DMS (SQL Server). Same output as
-- standard/5.2.0/artifacts/mssql/core/assessments.sql and dms-pgsql/core/assessments.sql: one row per
-- Ed-Fi Assessment; subjects and grades are collections of the Assessment document. sourcedIds hash
-- the UTF-8 bytes of the key, as PostgreSQL does. Mapping: docs/design/assessment-rostering-mappings.md

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.assessments', 'U') IS NOT NULL
    DROP TABLE oneroster12.assessments;
GO

CREATE TABLE oneroster12.assessments (
    sourcedId NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    title NVARCHAR(256) NOT NULL,
    identifier NVARCHAR(120) NOT NULL,
    version NVARCHAR(20) NULL,
    category NVARCHAR(256) NULL,
    subjects NVARCHAR(MAX) NOT NULL, -- JSON array, [] when none
    grades NVARCHAR(MAX) NOT NULL, -- JSON array, [] when none
    org NVARCHAR(MAX) NULL, -- JSON GUIDRef, only when the org is published
    course NVARCHAR(MAX) NULL, -- always null: Ed-Fi has no course link
    metadata NVARCHAR(MAX) NULL, -- JSON
    definingEducationOrganizationId BIGINT NULL -- for authorization filtering
);
GO

ALTER TABLE oneroster12.assessments ADD CONSTRAINT PK_assessments PRIMARY KEY (sourcedId);
GO

IF OBJECT_ID('oneroster12.sp_refresh_assessments', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_assessments;
GO

CREATE PROCEDURE oneroster12.sp_refresh_assessments
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('assessments', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_assessments') IS NOT NULL
            DROP TABLE #staging_assessments;

        SELECT TOP 0 * INTO #staging_assessments FROM oneroster12.assessments;

        WITH assessment AS (
            -- Key parts for sourcedIds: lower case, then '\' and '|' escaped, so that joining them
            -- with '|' can't make two different keys collide
            SELECT
                a.*,
                REPLACE(REPLACE(LOWER(a.[Namespace]), N'\', N'\\'), N'|', N'\|') AS k_namespace,
                REPLACE(REPLACE(LOWER(a.[AssessmentIdentifier]), N'\', N'\\'), N'|', N'\|') AS k_assessmentidentifier
            FROM edfi.[Assessment] a
        ),
        published_orgs AS (
            -- The organizations the orgs table publishes; a reference to any other is left null
            SELECT [SchoolId] AS educationOrganizationId FROM edfi.[School]
            UNION
            SELECT [LocalEducationAgencyId] FROM edfi.[LocalEducationAgency]
            UNION
            SELECT [StateEducationAgencyId] FROM edfi.[StateEducationAgency]
        )
        INSERT INTO #staging_assessments
            (sourcedId, status, dateLastModified, title, identifier, version, category,
             subjects, grades, org, course, metadata, definingEducationOrganizationId)
        SELECT
            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                CAST(CONCAT(a.k_namespace, N'|', a.k_assessmentidentifier) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
            ), 2)),
            'active',
            a.[ContentLastModifiedAt],
            a.[AssessmentTitle],
            a.[AssessmentIdentifier],
            CAST(a.[AssessmentVersion] AS NVARCHAR(20)),
            category.[CodeValue],
            COALESCE((
                SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(d.[CodeValue], 'json') + '"', ',') WITHIN GROUP (ORDER BY d.[CodeValue] COLLATE Latin1_General_100_BIN2) + ']'
                FROM edfi.[AssessmentAcademicSubject] s
                JOIN dms.[Descriptor] d ON d.[DescriptorId] = s.[AcademicSubjectDescriptor_DescriptorId]
                WHERE s.[Assessment_DocumentId] = a.[DocumentId]
            ), '[]'),
            -- Grade level code values, as users.grades
            COALESCE((
                SELECT '[' + STRING_AGG('"' + STRING_ESCAPE(d.[CodeValue], 'json') + '"', ',') WITHIN GROUP (ORDER BY d.[CodeValue] COLLATE Latin1_General_100_BIN2) + ']'
                FROM edfi.[AssessmentAssessedGradeLevel] g
                JOIN dms.[Descriptor] d ON d.[DescriptorId] = g.[GradeLevelDescriptor_DescriptorId]
                WHERE g.[Assessment_DocumentId] = a.[DocumentId]
            ), '[]'),
            CASE WHEN defining_org.educationOrganizationId IS NOT NULL THEN
                (SELECT
                    CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(a.[EducationOrganization_EducationOrganizationId] AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(a.[EducationOrganization_EducationOrganizationId] AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                    'org' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
            END,
            NULL,
            -- FOR JSON leaves out nulls, as json_strip_nulls does on PostgreSQL
            (SELECT
                'assessments' AS [edfi.resource],
                a.[Namespace] AS [edfi.naturalKey.namespace],
                a.[AssessmentIdentifier] AS [edfi.naturalKey.assessmentIdentifier],
                a.[EducationOrganization_EducationOrganizationId] AS [edfi.educationOrganizationId],
                a.[AssessmentFamily] AS [edfi.assessmentFamily],
                a.[AssessmentForm] AS [edfi.assessmentForm],
                a.[RevisionDate] AS [edfi.revisionDate],
                a.[AdaptiveAssessment] AS [edfi.adaptiveAssessment]
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
            a.[EducationOrganization_EducationOrganizationId]
        FROM assessment a
        LEFT JOIN dms.[Descriptor] category ON category.[DescriptorId] = a.[AssessmentCategoryDescriptor_DescriptorId]
        LEFT JOIN published_orgs defining_org ON defining_org.educationOrganizationId = a.[EducationOrganization_EducationOrganizationId];

        SET @RowCount = @@ROWCOUNT;

        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.assessments;
            INSERT INTO oneroster12.assessments SELECT * FROM #staging_assessments;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Success', row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_assessments;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT @ErrorMessage = ERROR_MESSAGE(), @ErrorSeverity = ERROR_SEVERITY(), @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('assessments', @ErrorMessage, @ErrorSeverity, @ErrorState, 'sp_refresh_assessments', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
