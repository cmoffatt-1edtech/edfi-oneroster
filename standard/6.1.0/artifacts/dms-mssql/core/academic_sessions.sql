-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.academicsessions on DMS (SQL Server). Same output as
-- standard/6.1.0/artifacts/mssql/core/academic_sessions.sql and dms-pgsql/core/academic_sessions.sql:
-- one schoolYear session per LEA and school year (modal first/last instructional day across the
-- LEA's schools), plus one term per Ed-Fi Session whose parent is that LEA school year. The
-- calendar event join is a single CalendarDate_DocumentId equality instead of the ODS four-part key.
-- The modal day is picked with a tie-break on the day itself, as PostgreSQL mode() does (the
-- DS 5.2 ODS file has no tie-break; DS 6.1 adds it), and schools without an LEA form one group,
-- as in PostgreSQL.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.academicsessions', 'U') IS NOT NULL
    DROP TABLE oneroster12.academicsessions;
GO

CREATE TABLE oneroster12.academicsessions (
    sourcedId NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    title NVARCHAR(256) NOT NULL,
    type NVARCHAR(32) NOT NULL,
    startDate NVARCHAR(32) NULL,
    endDate NVARCHAR(32) NULL,
    parent NVARCHAR(MAX) NULL, -- JSON
    schoolYear NVARCHAR(16) NULL,
    educationOrganizationId BIGINT NULL,
    metadata NVARCHAR(MAX) NULL, -- JSON
    CONSTRAINT PK_academicsessions PRIMARY KEY (sourcedId)
);
GO

CREATE INDEX IX_academicsessions_type_year ON oneroster12.academicsessions (type, schoolYear);
CREATE NONCLUSTERED INDEX IX_academicsessions_type_dates ON oneroster12.academicsessions (type, startDate, endDate) INCLUDE (title);
-- Authorization filters: org id lookups
CREATE INDEX IX_academicsessions_educationOrganizationId ON oneroster12.academicsessions (educationOrganizationId) WHERE educationOrganizationId IS NOT NULL;
GO

IF OBJECT_ID('oneroster12.sp_refresh_academicsessions', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_academicsessions;
GO

CREATE PROCEDURE oneroster12.sp_refresh_academicsessions
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('academicsessions', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_academicsessions') IS NOT NULL
            DROP TABLE #staging_academicsessions;

        SELECT TOP 0 * INTO #staging_academicsessions FROM oneroster12.academicsessions;

        WITH sessions AS (
            SELECT
                ses.[School_SchoolId] AS schoolId,
                ses.[SchoolYear_SchoolYear] AS schoolYear,
                ses.[SessionName] AS sessionName,
                ses.[TermDescriptor_DescriptorId] AS termDescriptorId,
                ses.[BeginDate] AS beginDate,
                ses.[EndDate] AS endDate,
                ses.[ContentLastModifiedAt] AS lastModifiedDate,
                sch.[LocalEducationAgency_LocalEducationAgencyId] AS localEducationAgencyId
            FROM edfi.[Session] ses
            JOIN edfi.[School] sch
                ON ses.[School_DocumentId] = sch.[DocumentId]
        ),
        -- First and last instructional day per school and school year. The PostgreSQL view also
        -- groups by calendar code (grouping sets), but only these school-level rows are used.
        calendar_school_level AS (
            SELECT
                cd.[Calendar_SchoolId] AS schoolId,
                cd.[Calendar_SchoolYear] AS schoolYear,
                MIN(cd.[Date]) AS first_school_day,
                MAX(cd.[Date]) AS last_school_day
            FROM edfi.[CalendarDate] cd
            JOIN edfi.[CalendarDateCalendarEvent] cdce
                ON cdce.[CalendarDate_DocumentId] = cd.[DocumentId]
            JOIN dms.[Descriptor] eventdescriptor
                ON cdce.[CalendarEventDescriptor_DescriptorId] = eventdescriptor.[DescriptorId]
            JOIN edfi.[DescriptorMapping] mappedeventdescriptor
                ON mappedeventdescriptor.[Value] = eventdescriptor.[CodeValue]
                AND mappedeventdescriptor.[Namespace] = eventdescriptor.[Namespace]
                AND mappedeventdescriptor.[MappedNamespace] = 'uri://1edtech.org/oneroster12/CalendarEventDescriptor'
            WHERE mappedeventdescriptor.[MappedValue] = 'TRUE' -- IS a school/instructional day
            GROUP BY cd.[Calendar_SchoolId], cd.[Calendar_SchoolYear]
        ),
        calendar_lea_level AS (
            SELECT
                sch.[LocalEducationAgency_LocalEducationAgencyId] AS localEducationAgencyId,
                cal.schoolYear,
                cal.first_school_day,
                cal.last_school_day
            FROM calendar_school_level cal
            JOIN edfi.[School] sch
                ON cal.schoolId = sch.[SchoolId]
        ),
        -- School years are global in OneRoster but start and end on different days in practice, so
        -- they are defined per district with the modal first/last day across its schools. Ties go
        -- to the earliest day, as PostgreSQL mode() WITHIN GROUP (ORDER BY day) does.
        first_day_ranked AS (
            SELECT
                localEducationAgencyId,
                schoolYear,
                first_school_day,
                ROW_NUMBER() OVER (
                    PARTITION BY localEducationAgencyId, schoolYear
                    ORDER BY COUNT(*) DESC, first_school_day ASC) AS rn
            FROM calendar_lea_level
            GROUP BY localEducationAgencyId, schoolYear, first_school_day
        ),
        last_day_ranked AS (
            SELECT
                localEducationAgencyId,
                schoolYear,
                last_school_day,
                ROW_NUMBER() OVER (
                    PARTITION BY localEducationAgencyId, schoolYear
                    ORDER BY COUNT(*) DESC, last_school_day ASC) AS rn
            FROM calendar_lea_level
            GROUP BY localEducationAgencyId, schoolYear, last_school_day
        ),
        summarize_school_year AS (
            SELECT
                f.localEducationAgencyId,
                f.schoolYear,
                f.first_school_day,
                l.last_school_day
            FROM first_day_ranked f
            JOIN last_day_ranked l
                ON (l.localEducationAgencyId = f.localEducationAgencyId
                    OR (l.localEducationAgencyId IS NULL AND f.localEducationAgencyId IS NULL))
                AND l.schoolYear = f.schoolYear
                AND l.rn = 1
            WHERE f.rn = 1
        ),
        create_school_year AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(CONCAT(CAST(ssy.localEducationAgencyId AS VARCHAR(20)), '-', CAST(ssy.schoolYear AS VARCHAR(10))) AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                'active' AS status,
                MAX(ses.lastModifiedDate) AS dateLastModified,
                CONCAT(CAST(ssy.schoolYear - 1 AS NVARCHAR(11)), '-', CAST(ssy.schoolYear AS NVARCHAR(11))) AS title,
                'schoolYear' AS type,
                CONVERT(NVARCHAR(32), ssy.first_school_day, 23) AS startDate, -- ISO format YYYY-MM-DD
                CONVERT(NVARCHAR(32), ssy.last_school_day, 23) AS endDate,
                CAST(NULL AS NVARCHAR(MAX)) AS parent,
                CAST(ssy.schoolYear AS NVARCHAR(16)) AS schoolYear,
                ssy.localEducationAgencyId AS educationOrganizationId,
                -- INCLUDE_NULL_VALUES keeps "educationOrganizationId": null for schools without an LEA
                (SELECT
                    'schoolYearTypes' AS [edfi.resource],
                    ssy.schoolYear AS [edfi.naturalKey.schoolYear],
                    ssy.localEducationAgencyId AS [edfi.educationOrganizationId]
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES) AS metadata
            FROM summarize_school_year ssy
            LEFT JOIN sessions ses
                ON ses.schoolYear = ssy.schoolYear
                AND ses.localEducationAgencyId = ssy.localEducationAgencyId
            GROUP BY ssy.localEducationAgencyId, ssy.schoolYear, ssy.first_school_day, ssy.last_school_day
        ),
        sessions_formatted AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(
                        CONCAT(CAST(sessions.schoolId AS VARCHAR(20)), '-', CAST(sessions.schoolYear AS VARCHAR(10)), '-', sessions.sessionName)
                        AS VARCHAR(MAX)
                    ) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                'active' AS status,
                sessions.lastModifiedDate AS dateLastModified,
                termdescriptor.[CodeValue] AS title,
                mappedtermdescriptor.[MappedValue] AS type,
                CONVERT(NVARCHAR(32), sessions.beginDate, 23) AS startDate,
                CONVERT(NVARCHAR(32), sessions.endDate, 23) AS endDate,
                (SELECT
                    CONCAT('/academicSessions/', LOWER(CONVERT(VARCHAR(32),
                        HASHBYTES('MD5', CAST(CONCAT(CAST(sessions.localEducationAgencyId AS VARCHAR(20)), '-', CAST(sessions.schoolYear AS VARCHAR(10))) AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(CONCAT(CAST(sessions.localEducationAgencyId AS VARCHAR(20)), '-', CAST(sessions.schoolYear AS VARCHAR(10))) AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                    'academicSession' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS parent,
                CAST(sessions.schoolYear AS NVARCHAR(16)) AS schoolYear,
                sessions.schoolId AS educationOrganizationId,
                (SELECT
                    'sessions' AS [edfi.resource],
                    sessions.schoolId AS [edfi.naturalKey.schoolId],
                    sessions.sessionName AS [edfi.naturalKey.sessionName]
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata
            FROM sessions
            JOIN dms.[Descriptor] termdescriptor
                ON sessions.termDescriptorId = termdescriptor.[DescriptorId]
            JOIN edfi.[DescriptorMapping] mappedtermdescriptor
                ON mappedtermdescriptor.[Value] = termdescriptor.[CodeValue]
                AND mappedtermdescriptor.[Namespace] = termdescriptor.[Namespace]
                AND mappedtermdescriptor.[MappedNamespace] = 'uri://1edtech.org/oneroster12/TermDescriptor'
        )
        INSERT INTO #staging_academicsessions
            (sourcedId, status, dateLastModified, title, type, startDate, endDate, parent, schoolYear, educationOrganizationId, metadata)
        SELECT sourcedId, status, dateLastModified, title, type, startDate, endDate, parent, schoolYear, educationOrganizationId, metadata
        FROM create_school_year
        UNION ALL
        SELECT sourcedId, status, dateLastModified, title, type, startDate, endDate, parent, schoolYear, educationOrganizationId, metadata
        FROM sessions_formatted;

        SET @RowCount = @@ROWCOUNT;

        -- Atomic swap
        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.academicsessions;
            INSERT INTO oneroster12.academicsessions SELECT * FROM #staging_academicsessions;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Success', row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_academicsessions;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT @ErrorMessage = ERROR_MESSAGE(), @ErrorSeverity = ERROR_SEVERITY(), @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('academicsessions', @ErrorMessage, @ErrorSeverity, @ErrorState, 'sp_refresh_academicsessions', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
