-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.orgs on DMS (SQL Server). Same output as standard/6.1.0/artifacts/mssql/core/orgs.sql;
-- DMS has no edfi.EducationOrganization base table, so names come from the School,
-- LocalEducationAgency and StateEducationAgency tables directly (as in dms-pgsql/core/orgs.sql).

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.orgs', 'U') IS NOT NULL
    DROP TABLE oneroster12.orgs;
GO

CREATE TABLE oneroster12.orgs (
    sourcedId NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    name NVARCHAR(256) NOT NULL,
    type NVARCHAR(32) NOT NULL,
    identifier NVARCHAR(256) NULL,
    parent NVARCHAR(MAX) NULL, -- JSON
    children NVARCHAR(MAX) NULL, -- JSON array
    educationOrganizationId BIGINT NULL,
    metadata NVARCHAR(MAX) NULL, -- JSON
    CONSTRAINT PK_orgs PRIMARY KEY (sourcedId)
);
GO

CREATE NONCLUSTERED INDEX IX_orgs_type_status ON oneroster12.orgs (type, status) INCLUDE (name, identifier);
CREATE NONCLUSTERED INDEX IX_orgs_identifier ON oneroster12.orgs (identifier) WHERE identifier IS NOT NULL;
CREATE INDEX IX_orgs_lastmodified ON oneroster12.orgs (dateLastModified) WHERE dateLastModified IS NOT NULL;
-- Authorization filters: org id lookups
CREATE INDEX IX_orgs_educationOrganizationId ON oneroster12.orgs (educationOrganizationId) WHERE educationOrganizationId IS NOT NULL;
GO

IF OBJECT_ID('oneroster12.sp_refresh_orgs', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_orgs;
GO

CREATE PROCEDURE oneroster12.sp_refresh_orgs
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('orgs', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_orgs') IS NOT NULL
            DROP TABLE #staging_orgs;

        SELECT TOP 0 * INTO #staging_orgs FROM oneroster12.orgs;

        WITH schools AS (
            SELECT
                s.[SchoolId] AS schoolId,
                s.[NameOfInstitution] AS nameOfInstitution,
                s.[LocalEducationAgency_LocalEducationAgencyId] AS localEducationAgencyId,
                s.[ContentLastModifiedAt] AS lastModifiedDate
            FROM edfi.[School] s
        ),
        leas AS (
            SELECT
                l.[LocalEducationAgencyId] AS localEducationAgencyId,
                l.[NameOfInstitution] AS nameOfInstitution,
                l.[StateEducationAgency_StateEducationAgencyId] AS stateEducationAgencyId,
                l.[ContentLastModifiedAt] AS lastModifiedDate
            FROM edfi.[LocalEducationAgency] l
        ),
        seas AS (
            SELECT
                e.[StateEducationAgencyId] AS stateEducationAgencyId,
                e.[NameOfInstitution] AS nameOfInstitution,
                e.[ContentLastModifiedAt] AS lastModifiedDate
            FROM edfi.[StateEducationAgency] e
        ),
        schools_formatted AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(schools.schoolId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                'active' AS status,
                lastModifiedDate AS dateLastModified,
                nameOfInstitution AS name,
                'school' AS type,
                CAST(schoolId AS VARCHAR(256)) AS identifier,
                CASE WHEN localEducationAgencyId IS NOT NULL THEN
                    (SELECT
                        CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(localEducationAgencyId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                        LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(localEducationAgencyId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                        'org' AS type
                     FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                ELSE NULL END AS parent,
                NULL AS children,
                schoolId AS educationOrganizationId,
                (SELECT
                    'schools' AS [edfi.resource],
                    schoolId AS [edfi.naturalKey.schoolId]
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata
            FROM schools
        ),
        leas_formatted AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(leas.localEducationAgencyId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                'active' AS status,
                lastModifiedDate AS dateLastModified,
                nameOfInstitution AS name,
                'district' AS type,
                CAST(localEducationAgencyId AS VARCHAR(256)) AS identifier,
                CASE WHEN stateEducationAgencyId IS NOT NULL THEN
                    (SELECT
                        CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(stateEducationAgencyId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                        LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(stateEducationAgencyId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                        'org' AS type
                     FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                ELSE NULL END AS parent,
                CASE WHEN EXISTS (
                        SELECT 1 FROM schools s WHERE s.localEducationAgencyId = leas.localEducationAgencyId
                    ) THEN (
                        SELECT
                            CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(s.schoolId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(s.schoolId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                            'org' AS type
                        FROM schools s
                        WHERE s.localEducationAgencyId = leas.localEducationAgencyId
                        ORDER BY s.schoolId
                        FOR JSON PATH
                    )
                    ELSE NULL
                END AS children,
                localEducationAgencyId AS educationOrganizationId,
                (SELECT
                    'localEducationAgencies' AS [edfi.resource],
                    localEducationAgencyId AS [edfi.naturalKey.localEducationAgencyId]
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata
            FROM leas
        ),
        seas_formatted AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(seas.stateEducationAgencyId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                'active' AS status,
                lastModifiedDate AS dateLastModified,
                nameOfInstitution AS name,
                'state' AS type,
                CAST(stateEducationAgencyId AS VARCHAR(256)) AS identifier,
                NULL AS parent,
                CASE WHEN EXISTS (
                        SELECT 1 FROM leas l WHERE l.stateEducationAgencyId = seas.stateEducationAgencyId
                    ) THEN (
                        SELECT
                            CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(l.localEducationAgencyId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(l.localEducationAgencyId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                            'org' AS type
                        FROM leas l
                        WHERE l.stateEducationAgencyId = seas.stateEducationAgencyId
                        ORDER BY l.localEducationAgencyId
                        FOR JSON PATH
                    )
                    ELSE NULL
                END AS children,
                stateEducationAgencyId AS educationOrganizationId,
                (SELECT
                    'stateEducationAgencies' AS [edfi.resource],
                    stateEducationAgencyId AS [edfi.naturalKey.stateEducationAgencyId]
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata
            FROM seas
        )
        INSERT INTO #staging_orgs
            (sourcedId, status, dateLastModified, name, type, identifier, parent, children, educationOrganizationId, metadata)
        SELECT sourcedId, status, dateLastModified, name, type, identifier, parent, children, educationOrganizationId, metadata
        FROM (
            SELECT * FROM schools_formatted
            UNION ALL
            SELECT * FROM leas_formatted
            UNION ALL
            SELECT * FROM seas_formatted
        ) AS combined_orgs;

        SET @RowCount = @@ROWCOUNT;

        -- Atomic swap
        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.orgs;
            INSERT INTO oneroster12.orgs SELECT * FROM #staging_orgs;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Success', row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_orgs;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT @ErrorMessage = ERROR_MESSAGE(), @ErrorSeverity = ERROR_SEVERITY(), @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('orgs', @ErrorMessage, @ErrorSeverity, @ErrorState, 'sp_refresh_orgs', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
