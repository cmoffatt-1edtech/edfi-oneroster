-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional): oneroster12.assessmentauthorgs on DMS (SQL Server). Same output as
-- standard/6.1.0/artifacts/mssql/core/assessment_auth_orgs.sql and dms-pgsql: the organizations each
-- assessment and offering is tied to, one row per (assessment, offering, organization, role). Not an
-- endpoint: the assessments and assessmentOfferings authorization filters read it.

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
    educationOrganizationId BIGINT NOT NULL,
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

        SELECT TOP 0 * INTO #staging_assessmentauthorgs FROM oneroster12.assessmentauthorgs;

        WITH organizations AS (
            -- defining: the assessment's own organization (no offering)
            SELECT a.[Namespace] AS namespace, a.[AssessmentIdentifier] AS assessmentIdentifier,
                CAST(NULL AS BIGINT) AS assigningEducationOrganizationId, CAST(NULL AS NVARCHAR(255)) AS administrationIdentifier,
                a.[EducationOrganization_EducationOrganizationId] AS educationOrganizationId, CAST('defining' AS NVARCHAR(16)) AS orgRole
            FROM edfi.[Assessment] a
            WHERE a.[EducationOrganization_EducationOrganizationId] IS NOT NULL
            UNION ALL
            -- assigning: the organization an offering belongs to
            SELECT aa.[Assessment_Namespace], aa.[Assessment_AssessmentIdentifier], aa.[AssigningEducationOrganization_EducationOrganizationId],
                aa.[AdministrationIdentifier], aa.[AssigningEducationOrganization_EducationOrganizationId], 'assigning'
            FROM edfi.[AssessmentAdministration] aa
            UNION ALL
            -- participating: schools and districts taking part
            SELECT p.[AssessmentAdministration_Namespace], p.[AssessmentAdministration_AssessmentIdentifier],
                p.[AssessmentAdministration_AssigningEducationOrganizationId], p.[AssessmentAdministration_AdministrationIdentifier],
                p.[ParticipatingEducationOrganization_EducationOrganizationId], 'participating'
            FROM edfi.[AssessmentAdministrationParticipation] p
            UNION ALL
            -- registration: schools with a student registered, so every visible enrollment's offering is visible
            SELECT DISTINCT r.[AssessmentAdministration_Namespace], r.[AssessmentAdministration_AssessmentIdentifier],
                r.[AssessmentAdministration_AssigningEducationOrganizationId], r.[AssessmentAdministration_AdministrationIdentifier],
                r.[StudentSchoolAssociation_SchoolId], 'registration'
            FROM edfi.[StudentAssessmentRegistration] r
        ),
        keyed AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT(REPLACE(REPLACE(LOWER(o.namespace), N'\', N'\\'), N'|', N'\|'),
                        N'|', REPLACE(REPLACE(LOWER(o.assessmentIdentifier), N'\', N'\\'), N'|', N'\|')) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
                ), 2)) AS assessment_sourcedid,
                CASE WHEN o.administrationIdentifier IS NOT NULL THEN LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT(REPLACE(REPLACE(LOWER(o.namespace), N'\', N'\\'), N'|', N'\|'),
                        N'|', REPLACE(REPLACE(LOWER(o.assessmentIdentifier), N'\', N'\\'), N'|', N'\|'),
                        N'|', CAST(o.assigningEducationOrganizationId AS NVARCHAR(20)),
                        N'|', REPLACE(REPLACE(LOWER(o.administrationIdentifier), N'\', N'\\'), N'|', N'\|')) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
                ), 2)) END AS offering_sourcedid,
                o.educationOrganizationId,
                o.orgRole
            FROM organizations o
        )
        INSERT INTO #staging_assessmentauthorgs
            (sourcedId, assessmentSourcedId, assessmentOfferingSourcedId, educationOrganizationId, orgRole)
        SELECT
            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                CAST(CONCAT(assessment_sourcedid, N'|', COALESCE(offering_sourcedid, N''), N'|', CAST(educationOrganizationId AS NVARCHAR(20)), N'|', orgRole)
                    COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
            ), 2)),
            assessment_sourcedid,
            offering_sourcedid,
            educationOrganizationId,
            orgRole
        FROM keyed;

        SET @RowCount = @@ROWCOUNT;

        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.assessmentauthorgs;
            INSERT INTO oneroster12.assessmentauthorgs SELECT * FROM #staging_assessmentauthorgs;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Success', row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_assessmentauthorgs;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT @ErrorMessage = ERROR_MESSAGE(), @ErrorSeverity = ERROR_SEVERITY(), @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('assessmentauthorgs', @ErrorMessage, @ErrorSeverity, @ErrorState, 'sp_refresh_assessmentauthorgs', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
