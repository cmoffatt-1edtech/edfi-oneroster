-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- Assessment rostering (provisional): oneroster12.assessmentenrollments on DMS (SQL Server). Same output as
-- standard/6.1.0/artifacts/mssql/core/assessment_enrollments.sql and dms-pgsql: one student enrollment
-- per Ed-Fi StudentAssessmentRegistration. On Data Standard 6.1 the registration references a StudentDemographic
-- (same key) instead of a StudentEducationOrganizationAssociation. The registration carries the student's unique id and school
-- but not the student's DocumentId, which the auth views return: that comes from its
-- StudentSchoolAssociation. Mapping: docs/design/assessment-rostering-mappings.md

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.assessmentenrollments', 'U') IS NOT NULL
    DROP TABLE oneroster12.assessmentenrollments;
GO

CREATE TABLE oneroster12.assessmentenrollments (
    sourcedId NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    [user] NVARCHAR(MAX) NOT NULL, -- JSON GUIDRef
    assessmentOffering NVARCHAR(MAX) NOT NULL, -- JSON GUIDRef
    school NVARCHAR(MAX) NOT NULL, -- JSON GUIDRef
    role NVARCHAR(16) NOT NULL,
    beginDate NVARCHAR(10) NULL, -- always null: Ed-Fi registrations have no dates
    endDate NVARCHAR(10) NULL,
    metadata NVARCHAR(MAX) NULL, -- JSON
    educationOrganizationId BIGINT NULL, -- authorization: the registration's school
    participantDocumentId BIGINT NULL, -- authorization: the student
    assessmentOfferingSourcedId NVARCHAR(64) NOT NULL -- sub-collection /assessmentOfferings/{id}/assessmentEnrollments
);
GO

ALTER TABLE oneroster12.assessmentenrollments ADD CONSTRAINT PK_assessmentenrollments PRIMARY KEY (sourcedId);
GO

-- Authorization filters: org and participant lookups
CREATE INDEX IX_assessmentenrollments_educationOrganizationId ON oneroster12.assessmentenrollments (educationOrganizationId);
CREATE INDEX IX_assessmentenrollments_participantDocumentId ON oneroster12.assessmentenrollments (participantDocumentId);
-- Sub-collection lookups
CREATE INDEX IX_assessmentenrollments_assessmentOfferingSourcedId ON oneroster12.assessmentenrollments (assessmentOfferingSourcedId);
GO

IF OBJECT_ID('oneroster12.sp_refresh_assessmentenrollments', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_assessmentenrollments;
GO

CREATE PROCEDURE oneroster12.sp_refresh_assessmentenrollments
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('assessmentenrollments', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_assessmentenrollments') IS NOT NULL
            DROP TABLE #staging_assessmentenrollments;

        SELECT TOP 0 * INTO #staging_assessmentenrollments FROM oneroster12.assessmentenrollments;

        WITH registration AS (
            -- Key parts for sourcedIds: lower case, then '\' and '|' escaped
            SELECT
                r.*,
                ssa.[Student_DocumentId] AS studentDocumentId,
                REPLACE(REPLACE(LOWER(r.[AssessmentAdministration_Namespace]), N'\', N'\\'), N'|', N'\|') AS k_namespace,
                REPLACE(REPLACE(LOWER(r.[AssessmentAdministration_AssessmentIdentifier]), N'\', N'\\'), N'|', N'\|') AS k_assessmentidentifier,
                REPLACE(REPLACE(LOWER(r.[AssessmentAdministration_AdministrationIdentifier]), N'\', N'\\'), N'|', N'\|') AS k_administrationidentifier,
                REPLACE(REPLACE(LOWER(r.[StudentUniqueId_Unified]), N'\', N'\\'), N'|', N'\|') AS k_studentuniqueid
            FROM edfi.[StudentAssessmentRegistration] r
            JOIN edfi.[StudentSchoolAssociation] ssa ON ssa.[DocumentId] = r.[StudentSchoolAssociation_DocumentId]
        ),
        keyed AS (
            SELECT
                r.*,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT(r.k_namespace, N'|', r.k_assessmentidentifier,
                        N'|', CAST(r.[AssessmentAdministration_AssigningEducationOrganizationId] AS NVARCHAR(20)),
                        N'|', r.k_administrationidentifier) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
                ), 2)) AS offering_sourcedid,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT(r.k_namespace, N'|', r.k_assessmentidentifier,
                        N'|', CAST(r.[AssessmentAdministration_AssigningEducationOrganizationId] AS NVARCHAR(20)),
                        N'|', r.k_administrationidentifier,
                        N'|', CAST(r.[StudentDemographic_EducationOrganizationId] AS NVARCHAR(20)),
                        N'|', r.k_studentuniqueid) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
                ), 2)) AS enrollment_sourcedid,
                -- The users formula, unchanged
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT('STU-', CAST(r.[StudentUniqueId_Unified] AS VARCHAR(256)), '-', CAST(r.[StudentSchoolAssociation_SchoolId] AS VARCHAR(20))) AS VARCHAR(MAX)) COLLATE Latin1_General_BIN
                ), 2)) AS user_sourcedid,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(r.[StudentSchoolAssociation_SchoolId] AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS school_sourcedid
            FROM registration r
        ),
        published_orgs AS (
            -- The organizations the orgs table publishes; a reference to any other is left null
            SELECT [SchoolId] AS educationOrganizationId FROM edfi.[School]
            UNION
            SELECT [LocalEducationAgencyId] FROM edfi.[LocalEducationAgency]
            UNION
            SELECT [StateEducationAgencyId] FROM edfi.[StateEducationAgency]
        )
        INSERT INTO #staging_assessmentenrollments
            (sourcedId, status, dateLastModified, [user], assessmentOffering, school, role, beginDate, endDate,
             metadata, educationOrganizationId, participantDocumentId, assessmentOfferingSourcedId)
        SELECT
            r.enrollment_sourcedid,
            'active',
            r.[ContentLastModifiedAt],
            (SELECT CONCAT('/users/', r.user_sourcedid) AS href, r.user_sourcedid AS sourcedId, 'user' AS type
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
            (SELECT CONCAT('/assessmentOfferings/', r.offering_sourcedid) AS href, r.offering_sourcedid AS sourcedId, 'assessmentOffering' AS type
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
            (SELECT CONCAT('/orgs/', r.school_sourcedid) AS href, r.school_sourcedid AS sourcedId, 'org' AS type
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
            'student',
            NULL,
            NULL,
            (SELECT
                'studentAssessmentRegistrations' AS [edfi.resource],
                r.[AssessmentAdministration_Namespace] AS [edfi.naturalKey.namespace],
                r.[AssessmentAdministration_AssessmentIdentifier] AS [edfi.naturalKey.assessmentIdentifier],
                r.[AssessmentAdministration_AssigningEducationOrganizationId] AS [edfi.naturalKey.assigningEducationOrganizationId],
                r.[AssessmentAdministration_AdministrationIdentifier] AS [edfi.naturalKey.administrationIdentifier],
                r.[StudentDemographic_EducationOrganizationId] AS [edfi.naturalKey.educationOrganizationId],
                r.[StudentUniqueId_Unified] AS [edfi.naturalKey.studentUniqueId],
                grade.[CodeValue] AS [edfi.assessmentGradeLevel],
                platform.[CodeValue] AS [edfi.platformType],
                JSON_QUERY(CASE WHEN r.[TestingEducationOrganization_EducationOrganizationId] IS NOT NULL THEN
                    (SELECT
                        r.[TestingEducationOrganization_EducationOrganizationId] AS educationOrganizationId,
                        JSON_QUERY(CASE WHEN testing_org.educationOrganizationId IS NOT NULL THEN
                            (SELECT
                                CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(r.[TestingEducationOrganization_EducationOrganizationId] AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(r.[TestingEducationOrganization_EducationOrganizationId] AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                                'org' AS type
                             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                        END) AS org
                     FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                END) AS [edfi.testingEducationOrganization],
                JSON_QUERY(CASE WHEN r.[ReportingEducationOrganization_EducationOrganizationId] IS NOT NULL THEN
                    (SELECT
                        r.[ReportingEducationOrganization_EducationOrganizationId] AS educationOrganizationId,
                        JSON_QUERY(CASE WHEN reporting_org.educationOrganizationId IS NOT NULL THEN
                            (SELECT
                                CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(r.[ReportingEducationOrganization_EducationOrganizationId] AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(r.[ReportingEducationOrganization_EducationOrganizationId] AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                                'org' AS type
                             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                        END) AS org
                     FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                END) AS [edfi.reportingEducationOrganization]
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER),
            r.[StudentSchoolAssociation_SchoolId],
            r.studentDocumentId,
            r.offering_sourcedid
        FROM keyed r
        LEFT JOIN dms.[Descriptor] grade ON grade.[DescriptorId] = r.[AssessmentGradeLevelDescriptor_DescriptorId]
        LEFT JOIN dms.[Descriptor] platform ON platform.[DescriptorId] = r.[PlatformTypeDescriptor_DescriptorId]
        LEFT JOIN published_orgs testing_org ON testing_org.educationOrganizationId = r.[TestingEducationOrganization_EducationOrganizationId]
        LEFT JOIN published_orgs reporting_org ON reporting_org.educationOrganizationId = r.[ReportingEducationOrganization_EducationOrganizationId];

        SET @RowCount = @@ROWCOUNT;

        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.assessmentenrollments;
            INSERT INTO oneroster12.assessmentenrollments SELECT * FROM #staging_assessmentenrollments;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Success', row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_assessmentenrollments;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT @ErrorMessage = ERROR_MESSAGE(), @ErrorSeverity = ERROR_SEVERITY(), @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('assessmentenrollments', @ErrorMessage, @ErrorSeverity, @ErrorState, 'sp_refresh_assessmentenrollments', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
