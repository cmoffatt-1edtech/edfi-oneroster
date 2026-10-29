-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.courses on DMS (SQL Server). Same output as standard/5.2.0/artifacts/mssql/core/courses.sql
-- and dms-pgsql/core/courses.sql: one row per Ed-Fi Course, with the latest offering school year
-- found on the course natural key (educationOrganizationId, courseCode), which CourseOffering
-- carries as Course_* identity copies. The course code is hashed without truncation (the DS 5.2
-- ODS file cuts it at 50 characters; CourseCode is 60; DS 6.1 fixes this).

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.courses', 'U') IS NOT NULL
    DROP TABLE oneroster12.courses;
GO

CREATE TABLE oneroster12.courses (
    sourcedId NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    schoolYear NVARCHAR(MAX) NULL, -- JSON object
    title NVARCHAR(256) NOT NULL,
    courseCode NVARCHAR(64) NULL,
    grades NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    subjects NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    org NVARCHAR(MAX) NULL, -- JSON
    subjectCodes NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    metadata NVARCHAR(MAX) NULL, -- JSON
    educationOrganizationId BIGINT NULL, -- for authorization filtering
    CONSTRAINT PK_courses PRIMARY KEY (sourcedId)
);
GO

CREATE NONCLUSTERED INDEX IX_courses_coursecode ON oneroster12.courses (courseCode) WHERE courseCode IS NOT NULL;
CREATE NONCLUSTERED INDEX IX_courses_status ON oneroster12.courses (status) INCLUDE (title, courseCode);
-- Authorization filters: org id lookups
CREATE INDEX IX_courses_educationOrganizationId ON oneroster12.courses (educationOrganizationId) WHERE educationOrganizationId IS NOT NULL;
GO

IF OBJECT_ID('oneroster12.sp_refresh_courses', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_courses;
GO

CREATE PROCEDURE oneroster12.sp_refresh_courses
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('courses', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_courses') IS NOT NULL
            DROP TABLE #staging_courses;

        SELECT TOP 0 * INTO #staging_courses FROM oneroster12.courses;

        WITH course AS (
            SELECT
                c.[EducationOrganization_EducationOrganizationId] AS educationOrganizationId,
                c.[CourseCode] AS courseCode,
                c.[CourseTitle] AS courseTitle,
                c.[ContentLastModifiedAt] AS lastModifiedDate
            FROM edfi.[Course] c
        ),
        course_offerings AS (
            -- one offering row per course (latest school year wins) so a course with
            -- offerings in multiple years still yields a single courses row. Keyed by
            -- the course natural key (org + code) so courses sharing a code across
            -- organizations don't pick up each other's offerings.
            SELECT
                co.[Course_EducationOrganizationId] AS educationOrganizationId,
                co.[Course_CourseCode] AS courseCode,
                MAX(co.[Session_SchoolYear]) AS schoolYear
            FROM edfi.[CourseOffering] co
            GROUP BY co.[Course_EducationOrganizationId], co.[Course_CourseCode]
        )
        INSERT INTO #staging_courses
            (sourcedId, status, dateLastModified, schoolYear, title, courseCode,
             grades, subjects, org, subjectCodes, metadata, educationOrganizationId)
        SELECT
            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                CAST(
                    CONCAT(CAST(crs.educationOrganizationId AS VARCHAR(20)), '-', crs.courseCode)
                    AS VARCHAR(MAX)
                ) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
            'active' AS status,
            crs.lastModifiedDate AS dateLastModified,
            CASE
                -- Only emit a schoolYear reference when the owner resolves to a School or an
                -- LEA: sp_refresh_academicsessions only ever materializes schoolYear sessions
                -- per-LEA, so a course owned directly by a State Education Agency (or any
                -- other non-LEA org) has no matching academic session to reference.
                WHEN course_offerings.schoolYear IS NOT NULL
                     AND (crs_school.[LocalEducationAgency_LocalEducationAgencyId] IS NOT NULL
                          OR crs_lea.[LocalEducationAgencyId] IS NOT NULL) THEN
                    (SELECT
                        CONCAT('/academicSessions/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(CONCAT(CAST(COALESCE(crs_school.[LocalEducationAgency_LocalEducationAgencyId], crs.educationOrganizationId) AS VARCHAR(20)), '-', CAST(course_offerings.schoolYear AS VARCHAR(10))) AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                        LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(CONCAT(CAST(COALESCE(crs_school.[LocalEducationAgency_LocalEducationAgencyId], crs.educationOrganizationId) AS VARCHAR(20)), '-', CAST(course_offerings.schoolYear AS VARCHAR(10))) AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                        'academicSession' AS type
                     FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                ELSE NULL
            END AS schoolYear,
            crs.courseTitle AS title,
            crs.courseCode AS courseCode,
            NULL AS grades,
            NULL AS subjects,
            (SELECT
                CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(crs.educationOrganizationId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(crs.educationOrganizationId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                'org' AS type
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS org,
            NULL AS subjectCodes, -- required to be SCED codes, not generally available
            (SELECT
                'courses' AS [edfi.resource],
                crs.educationOrganizationId AS [edfi.naturalKey.educationOrganizationId],
                crs.courseCode AS [edfi.naturalKey.courseCode]
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata,
            crs.educationOrganizationId AS educationOrganizationId
        FROM course crs
        LEFT JOIN course_offerings
            ON crs.educationOrganizationId = course_offerings.educationOrganizationId
            AND crs.courseCode = course_offerings.courseCode
        LEFT JOIN edfi.[School] crs_school
            ON crs.educationOrganizationId = crs_school.[SchoolId]
        LEFT JOIN edfi.[LocalEducationAgency] crs_lea
            ON crs.educationOrganizationId = crs_lea.[LocalEducationAgencyId];

        SET @RowCount = @@ROWCOUNT;

        -- Atomic swap
        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.courses;
            INSERT INTO oneroster12.courses SELECT * FROM #staging_courses;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Success', row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_courses;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT @ErrorMessage = ERROR_MESSAGE(), @ErrorSeverity = ERROR_SEVERITY(), @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('courses', @ErrorMessage, @ErrorSeverity, @ErrorState, 'sp_refresh_courses', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
