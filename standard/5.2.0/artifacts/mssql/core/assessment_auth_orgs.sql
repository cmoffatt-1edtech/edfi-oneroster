-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- =============================================
-- Assessment rostering (provisional): assessmentauthorgs
-- Same output as standard/5.2.0/artifacts/pgsql/core/assessment_auth_orgs.sql: the organizations each
-- assessment and offering is tied to, one row per (assessment, offering, organization, role). Not an
-- endpoint: the assessments and assessmentOfferings authorization filters read it.
-- =============================================

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.assessmentauthorgs', 'U') IS NOT NULL
    DROP TABLE oneroster12.assessmentauthorgs;
GO

CREATE TABLE oneroster12.assessmentauthorgs (
    sourcedId NVARCHAR(64) NOT NULL, -- a row key for the parity tools, not a OneRoster id
    assessmentSourcedId NVARCHAR(64) NOT NULL,
    assessmentOfferingSourcedId NVARCHAR(64) NULL,
    educationOrganizationId INT NOT NULL,
    orgRole NVARCHAR(16) NOT NULL
);
GO

ALTER TABLE oneroster12.assessmentauthorgs ADD CONSTRAINT PK_assessmentauthorgs PRIMARY KEY (sourcedId);
GO

-- Authorization filters: org id lookups
CREATE INDEX IX_assessmentauthorgs_educationOrganizationId ON oneroster12.assessmentauthorgs (educationOrganizationId)
    INCLUDE (assessmentSourcedId, assessmentOfferingSourcedId);
GO

IF OBJECT_ID('oneroster12.sp_refresh_assessmentauthorgs', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_assessmentauthorgs;
GO

CREATE PROCEDURE oneroster12.sp_refresh_assessmentauthorgs
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('assessmentauthorgs', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_assessmentauthorgs') IS NOT NULL
            DROP TABLE #staging_assessmentauthorgs;

        CREATE TABLE #staging_assessmentauthorgs (
            sourcedId NVARCHAR(64) NOT NULL,
            assessmentSourcedId NVARCHAR(64) NOT NULL,
            assessmentOfferingSourcedId NVARCHAR(64) NULL,
            educationOrganizationId INT NOT NULL,
            orgRole NVARCHAR(16) NOT NULL
        );

        WITH organizations AS (
            -- defining: the assessment's own organization (no offering)
            SELECT a.Namespace, a.AssessmentIdentifier, CAST(NULL AS INT) AS AssigningEducationOrganizationId,
                CAST(NULL AS NVARCHAR(255)) AS AdministrationIdentifier, a.EducationOrganizationId, 'defining' AS OrgRole
            FROM edfi.Assessment a
            WHERE a.EducationOrganizationId IS NOT NULL
            UNION ALL
            -- assigning: the organization an offering belongs to
            SELECT aa.Namespace, aa.AssessmentIdentifier, aa.AssigningEducationOrganizationId,
                aa.AdministrationIdentifier, aa.AssigningEducationOrganizationId, 'assigning'
            FROM edfi.AssessmentAdministration aa
            UNION ALL
            -- participating: schools and districts taking part
            SELECT p.Namespace, p.AssessmentIdentifier, p.AssigningEducationOrganizationId,
                p.AdministrationIdentifier, p.ParticipatingEducationOrganizationId, 'participating'
            FROM edfi.AssessmentAdministrationParticipation p
            UNION ALL
            -- registration: schools with a student registered, so every visible enrollment's offering is visible
            SELECT DISTINCT r.Namespace, r.AssessmentIdentifier, r.AssigningEducationOrganizationId,
                r.AdministrationIdentifier, r.SchoolId, 'registration'
            FROM edfi.StudentAssessmentRegistration r
        ),
        keyed AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT(REPLACE(REPLACE(LOWER(o.Namespace), N'\', N'\\'), N'|', N'\|'),
                        N'|', REPLACE(REPLACE(LOWER(o.AssessmentIdentifier), N'\', N'\\'), N'|', N'\|')) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
                ), 2)) AS assessment_sourcedid,
                CASE WHEN o.AdministrationIdentifier IS NOT NULL THEN LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT(REPLACE(REPLACE(LOWER(o.Namespace), N'\', N'\\'), N'|', N'\|'),
                        N'|', REPLACE(REPLACE(LOWER(o.AssessmentIdentifier), N'\', N'\\'), N'|', N'\|'),
                        N'|', CAST(o.AssigningEducationOrganizationId AS NVARCHAR(20)),
                        N'|', REPLACE(REPLACE(LOWER(o.AdministrationIdentifier), N'\', N'\\'), N'|', N'\|')) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
                ), 2)) END AS offering_sourcedid,
                o.EducationOrganizationId,
                o.OrgRole
            FROM organizations o
            -- An administration's assessment always exists; the join keeps the rows the PostgreSQL view keeps
            JOIN edfi.Assessment a ON a.Namespace = o.Namespace AND a.AssessmentIdentifier = o.AssessmentIdentifier
        )
        INSERT INTO #staging_assessmentauthorgs
        SELECT
            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                CAST(CONCAT(assessment_sourcedid, N'|', COALESCE(offering_sourcedid, N''), N'|', CAST(EducationOrganizationId AS NVARCHAR(20)), N'|', OrgRole)
                    COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
            ), 2)) AS sourcedId,
            assessment_sourcedid,
            offering_sourcedid,
            EducationOrganizationId,
            OrgRole
        FROM keyed;

        SET @RowCount = @@ROWCOUNT;

        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.assessmentauthorgs;

            INSERT INTO oneroster12.assessmentauthorgs
                (sourcedId, assessmentSourcedId, assessmentOfferingSourcedId, educationOrganizationId, orgRole)
            SELECT sourcedId, assessmentSourcedId, assessmentOfferingSourcedId, educationOrganizationId, orgRole
            FROM #staging_assessmentauthorgs;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(),
            status = 'Success',
            row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_assessmentauthorgs;

        PRINT CONCAT('Assessment authorization organizations refresh completed successfully. Rows: ', @RowCount);
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
            ('assessmentauthorgs', @ErrorMessage, @ErrorSeverity, @ErrorState,
             'sp_refresh_assessmentauthorgs', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(),
            status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO

PRINT 'Stored procedure oneroster12.sp_refresh_assessmentauthorgs created successfully';
GO
