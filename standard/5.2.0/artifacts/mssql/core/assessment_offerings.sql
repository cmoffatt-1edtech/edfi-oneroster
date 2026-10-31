-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- =============================================
-- Assessment rostering (provisional): assessmentofferings
-- Same output as standard/5.2.0/artifacts/pgsql/core/assessment_offerings.sql. One offering per Ed-Fi
-- AssessmentAdministration, offered by its assigning organization. sourcedIds hash UTF-8, as in
-- assessments.sql. Mapping: docs/design/assessment-rostering-mappings.md
-- =============================================

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.assessmentofferings', 'U') IS NOT NULL
    DROP TABLE oneroster12.assessmentofferings;
GO

CREATE TABLE oneroster12.assessmentofferings (
    sourcedId NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    title NVARCHAR(256) NOT NULL,
    assessment NVARCHAR(MAX) NOT NULL, -- JSON GUIDRef
    org NVARCHAR(MAX) NULL, -- JSON GUIDRef, only when the org is published
    testingWindows NVARCHAR(MAX) NOT NULL, -- JSON array, [] when none
    class NVARCHAR(MAX) NULL, -- always null (open question Q4)
    academicSession NVARCHAR(MAX) NULL, -- always null (open question Q5)
    metadata NVARCHAR(MAX) NULL, -- JSON
    assessmentSourcedId NVARCHAR(64) NOT NULL -- sub-collection /assessments/{id}/assessmentOfferings
);
GO

ALTER TABLE oneroster12.assessmentofferings ADD CONSTRAINT PK_assessmentofferings PRIMARY KEY (sourcedId);
GO

-- Sub-collection lookups
CREATE INDEX IX_assessmentofferings_assessmentSourcedId ON oneroster12.assessmentofferings (assessmentSourcedId);
GO

IF OBJECT_ID('oneroster12.sp_refresh_assessmentofferings', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_assessmentofferings;
GO

CREATE PROCEDURE oneroster12.sp_refresh_assessmentofferings
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('assessmentofferings', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_assessmentofferings') IS NOT NULL
            DROP TABLE #staging_assessmentofferings;

        CREATE TABLE #staging_assessmentofferings (
            sourcedId NVARCHAR(64) NOT NULL,
            status NVARCHAR(16) NOT NULL,
            dateLastModified DATETIME2 NULL,
            title NVARCHAR(256) NOT NULL,
            assessment NVARCHAR(MAX) NOT NULL,
            org NVARCHAR(MAX) NULL,
            testingWindows NVARCHAR(MAX) NOT NULL,
            class NVARCHAR(MAX) NULL,
            academicSession NVARCHAR(MAX) NULL,
            metadata NVARCHAR(MAX) NULL,
            assessmentSourcedId NVARCHAR(64) NOT NULL
        );

        WITH administration AS (
            -- Key parts for sourcedIds: lower case, then '\' and '|' escaped
            SELECT
                aa.*,
                REPLACE(REPLACE(LOWER(aa.Namespace), N'\', N'\\'), N'|', N'\|') AS k_namespace,
                REPLACE(REPLACE(LOWER(aa.AssessmentIdentifier), N'\', N'\\'), N'|', N'\|') AS k_assessmentidentifier,
                REPLACE(REPLACE(LOWER(aa.AdministrationIdentifier), N'\', N'\\'), N'|', N'\|') AS k_administrationidentifier
            FROM edfi.AssessmentAdministration aa
        ),
        keyed AS (
            SELECT
                aa.*,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT(aa.k_namespace, N'|', aa.k_assessmentidentifier) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
                ), 2)) AS assessment_sourcedid,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT(aa.k_namespace, N'|', aa.k_assessmentidentifier, N'|', CAST(aa.AssigningEducationOrganizationId AS NVARCHAR(20)),
                        N'|', aa.k_administrationidentifier) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
                ), 2)) AS offering_sourcedid
            FROM administration aa
        ),
        published_orgs AS (
            -- The organizations the orgs table publishes; a reference to any other is left null
            SELECT SchoolId AS EducationOrganizationId FROM edfi.School
            UNION
            SELECT LocalEducationAgencyId FROM edfi.LocalEducationAgency
            UNION
            SELECT StateEducationAgencyId FROM edfi.StateEducationAgency
        ),
        participation AS (
            SELECT
                p.Namespace, p.AssessmentIdentifier, p.AssigningEducationOrganizationId, p.AdministrationIdentifier,
                MAX(p.LastModifiedDate) AS LastModifiedDate
            FROM edfi.AssessmentAdministrationParticipation p
            GROUP BY p.Namespace, p.AssessmentIdentifier, p.AssigningEducationOrganizationId, p.AdministrationIdentifier
        )
        INSERT INTO #staging_assessmentofferings
        SELECT
            aa.offering_sourcedid AS sourcedId,
            'active' AS status,
            -- The participation rows are separate resources; periods are part of the administration
            CASE WHEN participation.LastModifiedDate > aa.LastModifiedDate THEN participation.LastModifiedDate ELSE aa.LastModifiedDate END AS dateLastModified,
            aa.AdministrationIdentifier AS title,
            (SELECT
                CONCAT('/assessments/', aa.assessment_sourcedid) AS href,
                aa.assessment_sourcedid AS sourcedId,
                'assessment' AS type
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS assessment,
            CASE WHEN assigning_org.EducationOrganizationId IS NOT NULL THEN
                (SELECT
                    CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(aa.AssigningEducationOrganizationId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(aa.AssigningEducationOrganizationId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                    'org' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
            END AS org,
            -- One window per Ed-Fi period, never merged; an open-ended window keeps a null end date
            COALESCE((
                SELECT
                    CONVERT(VARCHAR(10), period.BeginDate, 23) AS startDate,
                    CONVERT(VARCHAR(10), period.EndDate, 23) AS endDate
                FROM edfi.AssessmentAdministrationPeriod period
                WHERE period.Namespace = aa.Namespace
                    AND period.AssessmentIdentifier = aa.AssessmentIdentifier
                    AND period.AssigningEducationOrganizationId = aa.AssigningEducationOrganizationId
                    AND period.AdministrationIdentifier = aa.AdministrationIdentifier
                ORDER BY period.BeginDate, CASE WHEN period.EndDate IS NULL THEN 1 ELSE 0 END, period.EndDate
                FOR JSON PATH, INCLUDE_NULL_VALUES
            ), '[]') AS testingWindows,
            NULL AS class,
            NULL AS academicSession,
            (SELECT
                'assessmentAdministrations' AS [edfi.resource],
                aa.Namespace AS [edfi.naturalKey.namespace],
                aa.AssessmentIdentifier AS [edfi.naturalKey.assessmentIdentifier],
                aa.AssigningEducationOrganizationId AS [edfi.naturalKey.assigningEducationOrganizationId],
                aa.AdministrationIdentifier AS [edfi.naturalKey.administrationIdentifier],
                JSON_QUERY((
                    SELECT
                        p.ParticipatingEducationOrganizationId AS educationOrganizationId,
                        JSON_QUERY(CASE WHEN participating_org.EducationOrganizationId IS NOT NULL THEN
                            (SELECT
                                CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(p.ParticipatingEducationOrganizationId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(p.ParticipatingEducationOrganizationId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                                'org' AS type
                             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                        END) AS org
                    FROM edfi.AssessmentAdministrationParticipation p
                    LEFT JOIN published_orgs participating_org ON participating_org.EducationOrganizationId = p.ParticipatingEducationOrganizationId
                    WHERE p.Namespace = aa.Namespace
                        AND p.AssessmentIdentifier = aa.AssessmentIdentifier
                        AND p.AssigningEducationOrganizationId = aa.AssigningEducationOrganizationId
                        AND p.AdministrationIdentifier = aa.AdministrationIdentifier
                    ORDER BY p.ParticipatingEducationOrganizationId
                    FOR JSON PATH
                )) AS [edfi.participatingEducationOrganizations]
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata,
            aa.assessment_sourcedid AS assessmentSourcedId
        FROM keyed aa
        LEFT JOIN published_orgs assigning_org ON assigning_org.EducationOrganizationId = aa.AssigningEducationOrganizationId
        LEFT JOIN participation
            ON participation.Namespace = aa.Namespace
            AND participation.AssessmentIdentifier = aa.AssessmentIdentifier
            AND participation.AssigningEducationOrganizationId = aa.AssigningEducationOrganizationId
            AND participation.AdministrationIdentifier = aa.AdministrationIdentifier;

        SET @RowCount = @@ROWCOUNT;

        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.assessmentofferings;

            INSERT INTO oneroster12.assessmentofferings
                (sourcedId, status, dateLastModified, title, assessment, org, testingWindows,
                 class, academicSession, metadata, assessmentSourcedId)
            SELECT
                sourcedId, status, dateLastModified, title, assessment, org, testingWindows,
                class, academicSession, metadata, assessmentSourcedId
            FROM #staging_assessmentofferings;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(),
            status = 'Success',
            row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_assessmentofferings;

        PRINT CONCAT('Assessment offerings refresh completed successfully. Rows: ', @RowCount);
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT
            @ErrorMessage = ERROR_MESSAGE(),
            @ErrorSeverity = ERROR_SEVERITY(),
            @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('assessmentofferings', @ErrorMessage, @ErrorSeverity, @ErrorState,
             'sp_refresh_assessmentofferings', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(),
            status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO

PRINT 'Stored procedure oneroster12.sp_refresh_assessmentofferings created successfully';
GO
