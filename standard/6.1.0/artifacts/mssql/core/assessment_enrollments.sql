-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- =============================================
-- Assessment rostering (provisional): assessmentenrollments
-- Same output as standard/6.1.0/artifacts/pgsql/core/assessment_enrollments.sql. One student enrollment
-- per Ed-Fi StudentAssessmentRegistration; Ed-Fi registers students only. The new sourcedIds hash
-- UTF-8, as in assessments.sql; the user and school references keep the users and orgs formulas.
-- Mapping: docs/design/assessment-rostering-mappings.md
-- =============================================

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
    educationOrganizationId INT NULL, -- authorization: the registration's school
    participantUSI INT NULL, -- authorization: the student
    assessmentOfferingSourcedId NVARCHAR(64) NOT NULL -- sub-collection /assessmentOfferings/{id}/assessmentEnrollments
);
GO

ALTER TABLE oneroster12.assessmentenrollments ADD CONSTRAINT PK_assessmentenrollments PRIMARY KEY (sourcedId);
GO

-- Authorization filters: org and participant lookups
CREATE INDEX IX_assessmentenrollments_educationOrganizationId ON oneroster12.assessmentenrollments (educationOrganizationId);
CREATE INDEX IX_assessmentenrollments_participantUSI ON oneroster12.assessmentenrollments (participantUSI);
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

        CREATE TABLE #staging_assessmentenrollments (
            sourcedId NVARCHAR(64) NOT NULL,
            status NVARCHAR(16) NOT NULL,
            dateLastModified DATETIME2 NULL,
            [user] NVARCHAR(MAX) NOT NULL,
            assessmentOffering NVARCHAR(MAX) NOT NULL,
            school NVARCHAR(MAX) NOT NULL,
            role NVARCHAR(16) NOT NULL,
            beginDate NVARCHAR(10) NULL,
            endDate NVARCHAR(10) NULL,
            metadata NVARCHAR(MAX) NULL,
            educationOrganizationId INT NULL,
            participantUSI INT NULL,
            assessmentOfferingSourcedId NVARCHAR(64) NOT NULL
        );

        WITH registration AS (
            -- Key parts for sourcedIds: lower case, then '\' and '|' escaped
            SELECT
                r.*,
                student.StudentUniqueId,
                REPLACE(REPLACE(LOWER(r.Namespace), N'\', N'\\'), N'|', N'\|') AS k_namespace,
                REPLACE(REPLACE(LOWER(r.AssessmentIdentifier), N'\', N'\\'), N'|', N'\|') AS k_assessmentidentifier,
                REPLACE(REPLACE(LOWER(r.AdministrationIdentifier), N'\', N'\\'), N'|', N'\|') AS k_administrationidentifier,
                REPLACE(REPLACE(LOWER(student.StudentUniqueId), N'\', N'\\'), N'|', N'\|') AS k_studentuniqueid
            FROM edfi.StudentAssessmentRegistration r
            JOIN edfi.Student student ON student.StudentUSI = r.StudentUSI
        ),
        keyed AS (
            SELECT
                r.*,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT(r.k_namespace, N'|', r.k_assessmentidentifier, N'|', CAST(r.AssigningEducationOrganizationId AS NVARCHAR(20)),
                        N'|', r.k_administrationidentifier) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
                ), 2)) AS offering_sourcedid,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT(r.k_namespace, N'|', r.k_assessmentidentifier, N'|', CAST(r.AssigningEducationOrganizationId AS NVARCHAR(20)),
                        N'|', r.k_administrationidentifier, N'|', CAST(r.EducationOrganizationId AS NVARCHAR(20)),
                        N'|', r.k_studentuniqueid) COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX))
                ), 2)) AS enrollment_sourcedid,
                -- The users formula, unchanged
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                    CAST(CONCAT('STU-', CAST(r.StudentUniqueId AS VARCHAR(256)), '-', CAST(r.SchoolId AS VARCHAR(20))) AS VARCHAR(MAX)) COLLATE Latin1_General_BIN
                ), 2)) AS user_sourcedid,
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(r.SchoolId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS school_sourcedid
            FROM registration r
        ),
        published_orgs AS (
            -- The organizations the orgs table publishes; a reference to any other is left null
            SELECT SchoolId AS EducationOrganizationId FROM edfi.School
            UNION
            SELECT LocalEducationAgencyId FROM edfi.LocalEducationAgency
            UNION
            SELECT StateEducationAgencyId FROM edfi.StateEducationAgency
        )
        INSERT INTO #staging_assessmentenrollments
        SELECT
            r.enrollment_sourcedid AS sourcedId,
            'active' AS status,
            r.LastModifiedDate AS dateLastModified,
            (SELECT CONCAT('/users/', r.user_sourcedid) AS href, r.user_sourcedid AS sourcedId, 'user' AS type
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS [user],
            (SELECT CONCAT('/assessmentOfferings/', r.offering_sourcedid) AS href, r.offering_sourcedid AS sourcedId, 'assessmentOffering' AS type
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS assessmentOffering,
            (SELECT CONCAT('/orgs/', r.school_sourcedid) AS href, r.school_sourcedid AS sourcedId, 'org' AS type
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS school,
            'student' AS role,
            NULL AS beginDate,
            NULL AS endDate,
            (SELECT
                'studentAssessmentRegistrations' AS [edfi.resource],
                r.Namespace AS [edfi.naturalKey.namespace],
                r.AssessmentIdentifier AS [edfi.naturalKey.assessmentIdentifier],
                r.AssigningEducationOrganizationId AS [edfi.naturalKey.assigningEducationOrganizationId],
                r.AdministrationIdentifier AS [edfi.naturalKey.administrationIdentifier],
                r.EducationOrganizationId AS [edfi.naturalKey.educationOrganizationId],
                r.StudentUniqueId AS [edfi.naturalKey.studentUniqueId],
                grade.CodeValue AS [edfi.assessmentGradeLevel],
                platform.CodeValue AS [edfi.platformType],
                JSON_QUERY(CASE WHEN r.TestingEducationOrganizationId IS NOT NULL THEN
                    (SELECT
                        r.TestingEducationOrganizationId AS educationOrganizationId,
                        JSON_QUERY(CASE WHEN testing_org.EducationOrganizationId IS NOT NULL THEN
                            (SELECT
                                CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(r.TestingEducationOrganizationId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(r.TestingEducationOrganizationId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                                'org' AS type
                             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                        END) AS org
                     FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                END) AS [edfi.testingEducationOrganization],
                JSON_QUERY(CASE WHEN r.ReportingEducationOrganizationId IS NOT NULL THEN
                    (SELECT
                        r.ReportingEducationOrganizationId AS educationOrganizationId,
                        JSON_QUERY(CASE WHEN reporting_org.EducationOrganizationId IS NOT NULL THEN
                            (SELECT
                                CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(r.ReportingEducationOrganizationId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2))) AS href,
                                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(r.ReportingEducationOrganizationId AS VARCHAR(MAX)) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
                                'org' AS type
                             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                        END) AS org
                     FOR JSON PATH, WITHOUT_ARRAY_WRAPPER)
                END) AS [edfi.reportingEducationOrganization]
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata,
            r.SchoolId AS educationOrganizationId,
            r.StudentUSI AS participantUSI,
            r.offering_sourcedid AS assessmentOfferingSourcedId
        FROM keyed r
        LEFT JOIN edfi.Descriptor grade ON grade.DescriptorId = r.AssessmentGradeLevelDescriptorId
        LEFT JOIN edfi.Descriptor platform ON platform.DescriptorId = r.PlatformTypeDescriptorId
        LEFT JOIN published_orgs testing_org ON testing_org.EducationOrganizationId = r.TestingEducationOrganizationId
        LEFT JOIN published_orgs reporting_org ON reporting_org.EducationOrganizationId = r.ReportingEducationOrganizationId;

        SET @RowCount = @@ROWCOUNT;

        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.assessmentenrollments;

            INSERT INTO oneroster12.assessmentenrollments
                (sourcedId, status, dateLastModified, [user], assessmentOffering, school, role, beginDate, endDate,
                 metadata, educationOrganizationId, participantUSI, assessmentOfferingSourcedId)
            SELECT
                sourcedId, status, dateLastModified, [user], assessmentOffering, school, role, beginDate, endDate,
                metadata, educationOrganizationId, participantUSI, assessmentOfferingSourcedId
            FROM #staging_assessmentenrollments;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(),
            status = 'Success',
            row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_assessmentenrollments;

        PRINT CONCAT('Assessment enrollments refresh completed successfully. Rows: ', @RowCount);
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
            ('assessmentenrollments', @ErrorMessage, @ErrorSeverity, @ErrorState,
             'sp_refresh_assessmentenrollments', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(),
            status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO

PRINT 'Stored procedure oneroster12.sp_refresh_assessmentenrollments created successfully';
GO
