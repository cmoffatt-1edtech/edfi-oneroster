-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.classes on DMS (SQL Server). Same output as standard/5.2.0/artifacts/mssql/core/classes.sql
-- and dms-pgsql/core/classes.sql: one class per Ed-Fi Section, keyed with the school year. The ODS
-- joins Section to CourseOffering and SectionClassPeriod on the five-part section key; here they
-- are DocumentId equalities (CourseOffering_DocumentId, Section_DocumentId), which identify the
-- same rows. The ODS inner join from CourseOffering to School only carried an unused LEA id, so it
-- is left out. Period names are JSON-escaped (the ODS file wraps them in quotes as they are).

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.classes', 'U') IS NOT NULL
    DROP TABLE oneroster12.classes;
GO

CREATE TABLE oneroster12.classes (
    sourcedId NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    title NVARCHAR(256) NOT NULL,
    classCode NVARCHAR(64) NULL,
    classType NVARCHAR(32) NULL,
    location NVARCHAR(256) NULL,
    grades NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    subjects NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    course NVARCHAR(MAX) NULL, -- JSON
    school NVARCHAR(MAX) NULL, -- JSON
    terms NVARCHAR(MAX) NULL, -- JSON array
    subjectCodes NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    periods NVARCHAR(MAX) NULL, -- JSON array
    resources NVARCHAR(MAX) NULL, -- JSON array
    metadata NVARCHAR(MAX) NULL, -- JSON
    educationOrganizationId BIGINT NULL, -- for authorization filtering
    CONSTRAINT PK_classes PRIMARY KEY (sourcedId)
);
GO

-- API performance indexes for filtering
CREATE NONCLUSTERED INDEX IX_classes_status_type ON oneroster12.classes (status, classType) INCLUDE (title, classCode);
CREATE NONCLUSTERED INDEX IX_classes_api_status_filter ON oneroster12.classes (status, dateLastModified) INCLUDE (title, classCode);
-- Authorization filters: org id lookups
CREATE INDEX IX_classes_educationOrganizationId ON oneroster12.classes (educationOrganizationId) WHERE educationOrganizationId IS NOT NULL;
GO

IF OBJECT_ID('oneroster12.sp_refresh_classes', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_classes;
GO

CREATE PROCEDURE oneroster12.sp_refresh_classes
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('classes', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_classes') IS NOT NULL
            DROP TABLE #staging_classes;

        SELECT TOP 0 * INTO #staging_classes FROM oneroster12.classes;

        WITH section AS (
            SELECT
                sec.[DocumentId] AS sectionDocumentId,
                sec.[CourseOffering_DocumentId] AS courseOfferingDocumentId,
                sec.[CourseOffering_LocalCourseCode] AS localCourseCode,
                sec.[CourseOffering_SchoolReferenceSchoolId] AS schoolId,
                sec.[CourseOffering_SchoolYear] AS schoolYear,
                sec.[SectionIdentifier] AS sectionIdentifier,
                sec.[CourseOffering_SessionName] AS sessionName,
                sec.[LocationLocation_ClassroomIdentificationCode] AS locationClassroomIdentificationCode,
                sec.[ContentLastModifiedAt] AS lastModifiedDate
            FROM edfi.[Section] sec
        ),
        courseoffering AS (
            SELECT
                co.[DocumentId] AS courseOfferingDocumentId,
                co.[LocalCourseTitle] AS localCourseTitle,
                co.[Course_EducationOrganizationId] AS educationOrganizationId,
                co.[Course_CourseCode] AS courseCode
            FROM edfi.[CourseOffering] co
        ),
        periods AS (
            -- one row per section (Section_DocumentId is the full section key:
            -- sectionIdentifier, localCourseCode, schoolId, schoolYear, sessionName)
            SELECT
                sectionDocumentId,
                '[' + STRING_AGG(CAST('"' + STRING_ESCAPE(classPeriodName, 'json') + '"' AS NVARCHAR(MAX)), ',')
                    WITHIN GROUP (ORDER BY classPeriodName) + ']' AS periods
            FROM (
                SELECT DISTINCT
                    scp.[Section_DocumentId] AS sectionDocumentId,
                    scp.[ClassPeriod_ClassPeriodName] AS classPeriodName
                FROM edfi.[SectionClassPeriod] scp
            ) distinct_periods
            GROUP BY sectionDocumentId
        )
        INSERT INTO #staging_classes
            (sourcedId, status, dateLastModified, title, classCode, classType,
             location, grades, subjects, course, school, terms, subjectCodes,
             periods, resources, metadata, educationOrganizationId)
        SELECT
            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                CAST(
                    CONCAT(LOWER(section.localCourseCode), '-', CAST(section.schoolId AS VARCHAR(20)),
                           '-', CAST(section.schoolYear AS VARCHAR(10)),
                           '-', LOWER(section.sectionIdentifier), '-', LOWER(section.sessionName))
                    AS VARCHAR(MAX)
                ) COLLATE Latin1_General_BIN), 2)) AS sourcedId, -- natural key of Ed-Fi Sections (incl. SchoolYear)
            'active' AS status,
            section.lastModifiedDate AS dateLastModified,
            CASE
                WHEN courseoffering.localCourseTitle IS NULL THEN ''
                ELSE courseoffering.localCourseTitle
            END AS title,
            section.localCourseCode AS classCode,
            'scheduled' AS classType,
            section.locationClassroomIdentificationCode AS location,
            NULL AS grades,
            NULL AS subjects,
            (SELECT
                CONCAT('/courses/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(
                        CONCAT(CAST(courseoffering.educationOrganizationId AS VARCHAR(20)), '-', courseoffering.courseCode)
                        AS VARCHAR(MAX)
                    ) COLLATE Latin1_General_BIN), 2))) AS href,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(
                        CONCAT(CAST(courseoffering.educationOrganizationId AS VARCHAR(20)), '-', courseoffering.courseCode)
                        AS VARCHAR(MAX)
                    ) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                'course' AS type
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS course,
            (SELECT
                CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(section.schoolId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(section.schoolId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                'org' AS type
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS school,
            -- key order href, type, sourcedId is how PostgreSQL's jsonb array prints the object
            (SELECT
                CONCAT('/academicSessions/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(
                        CONCAT(CAST(section.schoolId AS VARCHAR(20)), '-', CAST(section.schoolYear AS VARCHAR(10)), '-', section.sessionName)
                        AS VARCHAR(MAX)
                    ) COLLATE Latin1_General_BIN), 2))) AS href,
                'academicSession' AS type,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(
                        CONCAT(CAST(section.schoolId AS VARCHAR(20)), '-', CAST(section.schoolYear AS VARCHAR(10)), '-', section.sessionName)
                        AS VARCHAR(MAX)
                    ) COLLATE Latin1_General_BIN), 2)) AS sourcedId
             FOR JSON PATH) AS terms,
            NULL AS subjectCodes,
            periods.periods AS periods,
            NULL AS resources,
            (SELECT
                'sections' AS [edfi.resource],
                section.localCourseCode AS [edfi.naturalKey.localCourseCode],
                section.schoolId AS [edfi.naturalKey.schoolid],
                section.sectionIdentifier AS [edfi.naturalKey.sectionIdentifier],
                section.sessionName AS [edfi.naturalKey.sessionName]
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata,
            section.schoolId AS educationOrganizationId
        FROM section
        JOIN courseoffering
            ON section.courseOfferingDocumentId = courseoffering.courseOfferingDocumentId
        LEFT JOIN periods
            ON section.sectionDocumentId = periods.sectionDocumentId;

        SET @RowCount = @@ROWCOUNT;

        -- Atomic swap
        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.classes;
            INSERT INTO oneroster12.classes SELECT * FROM #staging_classes;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Success', row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_classes;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT @ErrorMessage = ERROR_MESSAGE(), @ErrorSeverity = ERROR_SEVERITY(), @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('classes', @ErrorMessage, @ErrorSeverity, @ErrorState, 'sp_refresh_classes', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
