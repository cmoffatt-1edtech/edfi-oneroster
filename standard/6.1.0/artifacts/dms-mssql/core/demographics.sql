-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- oneroster12.demographics on DMS (SQL Server). Same output as standard/6.1.0/artifacts/mssql/core/demographics.sql.
-- Students are keyed by [DocumentId] (studentUSI becomes studentDocumentId, the Student_DocumentId the
-- auth views return). DS 6.1 moved ethnicity and race off StudentEducationOrganizationAssociation onto
-- the StudentDemographic resource, keyed the same way (education organization, student); race is its
-- child collection, so race rows reach the student through their parent StudentDemographic row.

SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.demographics', 'U') IS NOT NULL
    DROP TABLE oneroster12.demographics;
GO

CREATE TABLE oneroster12.demographics (
    sourcedId NVARCHAR(64) NOT NULL,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    birthDate NVARCHAR(32) NULL,
    sex NVARCHAR(32) NULL,
    americanIndianOrAlaskaNative NVARCHAR(8) NULL,
    asian NVARCHAR(8) NULL,
    blackOrAfricanAmerican NVARCHAR(8) NULL,
    nativeHawaiianOrOtherPacificIslander NVARCHAR(8) NULL,
    white NVARCHAR(8) NULL,
    demographicRaceTwoOrMoreRaces NVARCHAR(8) NULL,
    hispanicOrLatinoEthnicity NVARCHAR(8) NULL,
    countryOfBirthCode NVARCHAR(8) NULL,
    stateOfBirthAbbreviation NVARCHAR(8) NULL,
    cityOfBirth NVARCHAR(256) NULL,
    publicSchoolResidenceStatus NVARCHAR(256) NULL,
    studentDocumentId BIGINT NULL,
    educationOrganizationId BIGINT NULL,
    metadata NVARCHAR(MAX) NULL, -- JSON
    CONSTRAINT PK_demographics PRIMARY KEY (sourcedId)
);
GO

-- Primary access patterns: by birthDate, by sex, by race fields
CREATE INDEX IX_demographics_birthdate_sex ON oneroster12.demographics (birthDate, sex) WHERE birthDate IS NOT NULL;
CREATE INDEX IX_demographics_race_flags ON oneroster12.demographics (
    americanIndianOrAlaskaNative, asian, blackOrAfricanAmerican,
    nativeHawaiianOrOtherPacificIslander, white, hispanicOrLatinoEthnicity
) WHERE americanIndianOrAlaskaNative = 'true';
-- Authorization filters: org and student lookups
CREATE INDEX IX_demographics_educationOrganizationId ON oneroster12.demographics (educationOrganizationId);
CREATE INDEX IX_demographics_studentDocumentId ON oneroster12.demographics (studentDocumentId);
GO

IF OBJECT_ID('oneroster12.sp_refresh_demographics', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_demographics;
GO

CREATE PROCEDURE oneroster12.sp_refresh_demographics
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;

    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('demographics', @StartTime, 'Running');

    DECLARE @HistoryID INT = SCOPE_IDENTITY();

    BEGIN TRY
        IF OBJECT_ID('tempdb..#staging_demographics') IS NOT NULL
            DROP TABLE #staging_demographics;

        SELECT TOP 0 * INTO #staging_demographics FROM oneroster12.demographics;

        -- One row per (student, school), mirroring the users view's anchor so the
        -- school-keyed sourcedId always matches a user. Race/ethnicity is resolved
        -- per-student (below) and replicated onto each of the student's school rows.
        WITH student_school AS (
            SELECT DISTINCT
                ssa.[Student_DocumentId] AS studentDocumentId,
                ssa.[School_SchoolId] AS schoolId
            FROM edfi.[StudentSchoolAssociation] ssa
            JOIN edfi.[School] s ON ssa.[School_SchoolId] = s.[SchoolId]
        ),
        -- Hispanic/ethnicity is a person-level fact, not an org-level one. Aggregate
        -- across ALL of the student's demographic records regardless of the org level
        -- (school, LEA, ESC, SEA) they were recorded at, so higher-org data is never dropped.
        student_edorg AS (
            SELECT
                se.[Student_DocumentId] AS studentDocumentId,
                CAST(MAX(CAST(se.[HispanicLatinoEthnicity] AS INT)) AS BIT) AS hispanicLatinoEthnicity,
                MAX(se.[ContentLastModifiedAt]) AS edorg_lmdate
            FROM edfi.[StudentDemographic] se
            GROUP BY se.[Student_DocumentId]
        ),
        -- Race is likewise person-level: union the mapped race descriptors across all
        -- of the student's demographic records.
        student_race AS (
            SELECT
                se.[Student_DocumentId] AS studentDocumentId,
                MAX(CASE WHEN mappedracedescriptor.[MappedValue] = 'americanIndianOrAlaskaNative' THEN 1 ELSE 0 END) AS americanIndianOrAlaskaNative,
                MAX(CASE WHEN mappedracedescriptor.[MappedValue] = 'asian' THEN 1 ELSE 0 END) AS asian,
                MAX(CASE WHEN mappedracedescriptor.[MappedValue] = 'blackOrAfricanAmerican' THEN 1 ELSE 0 END) AS blackOrAfricanAmerican,
                MAX(CASE WHEN mappedracedescriptor.[MappedValue] = 'nativeHawaiianOrOtherPacificIslander' THEN 1 ELSE 0 END) AS nativeHawaiianOrOtherPacificIslander,
                MAX(CASE WHEN mappedracedescriptor.[MappedValue] = 'white' THEN 1 ELSE 0 END) AS white,
                COUNT(DISTINCT mappedracedescriptor.[MappedValue]) AS race_count
            FROM edfi.[StudentDemographicRace] seoar
            JOIN edfi.[StudentDemographic] se
                ON seoar.[StudentDemographic_DocumentId] = se.[DocumentId]
            JOIN dms.[Descriptor] racedescriptor
                ON seoar.[RaceDescriptor_DescriptorId] = racedescriptor.[DescriptorId]
            LEFT JOIN edfi.[DescriptorMapping] mappedracedescriptor
                ON mappedracedescriptor.[Value] = racedescriptor.[CodeValue]
                AND mappedracedescriptor.[Namespace] = racedescriptor.[Namespace]
                AND mappedracedescriptor.[MappedNamespace] = 'uri://1edtech.org/oneroster12/RaceDescriptor'
            GROUP BY se.[Student_DocumentId]
        )
        INSERT INTO #staging_demographics
            (sourcedId, status, dateLastModified, birthDate, sex,
             americanIndianOrAlaskaNative, asian, blackOrAfricanAmerican,
             nativeHawaiianOrOtherPacificIslander, white, demographicRaceTwoOrMoreRaces,
             hispanicOrLatinoEthnicity, countryOfBirthCode, stateOfBirthAbbreviation,
             cityOfBirth, publicSchoolResidenceStatus, studentDocumentId, educationOrganizationId, metadata)
        SELECT
            LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5',
                CONVERT(VARCHAR(4000),
                    CASE
                        WHEN ss.schoolId IS NULL THEN
                            'STU-' + CONVERT(VARCHAR(64), student.[StudentUniqueId])
                        ELSE
                            'STU-' + CONVERT(VARCHAR(64), student.[StudentUniqueId]) + '-' + CONVERT(VARCHAR(20), ss.schoolId)
                    END
                ) COLLATE Latin1_General_BIN), 2)) AS sourcedId,
            'active' AS status,
            CASE
                WHEN se.edorg_lmdate > student.[ContentLastModifiedAt] THEN se.edorg_lmdate
                ELSE student.[ContentLastModifiedAt]
            END AS dateLastModified,
            CONVERT(NVARCHAR(32), student.[BirthDate], 23) AS birthDate,
            mappedsexdescriptor.[MappedValue] AS sex,
            -- OneRoster spec expects the _string_ "true" or "false", not a JSON boolean value
            CASE WHEN ISNULL(sr.americanIndianOrAlaskaNative, 0) = 1 THEN 'true' ELSE 'false' END AS americanIndianOrAlaskaNative,
            CASE WHEN ISNULL(sr.asian, 0) = 1 THEN 'true' ELSE 'false' END AS asian,
            CASE WHEN ISNULL(sr.blackOrAfricanAmerican, 0) = 1 THEN 'true' ELSE 'false' END AS blackOrAfricanAmerican,
            CASE WHEN ISNULL(sr.nativeHawaiianOrOtherPacificIslander, 0) = 1 THEN 'true' ELSE 'false' END AS nativeHawaiianOrOtherPacificIslander,
            CASE WHEN ISNULL(sr.white, 0) = 1 THEN 'true' ELSE 'false' END AS white,
            CASE WHEN sr.race_count > 1 THEN 'true' ELSE 'false' END AS demographicRaceTwoOrMoreRaces,
            CASE WHEN ISNULL(se.hispanicLatinoEthnicity, 0) = 1 THEN 'true' ELSE 'false' END AS hispanicOrLatinoEthnicity,
            countrydescriptor.[CodeValue] AS countryOfBirthCode,
            statedescriptor.[CodeValue] AS stateOfBirthAbbreviation,
            student.[BirthCity] AS cityOfBirth,
            NULL AS publicSchoolResidenceStatus,
            student.[DocumentId] AS studentDocumentId,
            ss.schoolId AS educationOrganizationId,
            -- FOR JSON leaves out the null educationOrganizationId (dms-pgsql: jsonb_strip_nulls)
            (SELECT
                'students' AS [edfi.resource],
                student.[StudentUniqueId] AS [edfi.naturalKey.studentUniqueId],
                ss.schoolId AS [edfi.educationOrganizationId]
             FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata
        FROM edfi.[Student] student
        LEFT JOIN student_school ss ON student.[DocumentId] = ss.studentDocumentId
        LEFT JOIN student_edorg se ON student.[DocumentId] = se.studentDocumentId
        LEFT JOIN student_race sr ON student.[DocumentId] = sr.studentDocumentId
        LEFT JOIN dms.[Descriptor] sexdescriptor
            ON student.[BirthSexDescriptor_DescriptorId] = sexdescriptor.[DescriptorId]
        LEFT JOIN edfi.[DescriptorMapping] mappedsexdescriptor
            ON mappedsexdescriptor.[Value] = sexdescriptor.[CodeValue]
            AND mappedsexdescriptor.[Namespace] = sexdescriptor.[Namespace]
            AND mappedsexdescriptor.[MappedNamespace] = 'uri://1edtech.org/oneroster12/SexDescriptor'
        LEFT JOIN dms.[Descriptor] countrydescriptor
            ON student.[BirthCountryDescriptor_DescriptorId] = countrydescriptor.[DescriptorId]
        LEFT JOIN dms.[Descriptor] statedescriptor
            ON student.[BirthStateAbbreviationDescriptor_DescriptorId] = statedescriptor.[DescriptorId];

        SET @RowCount = @@ROWCOUNT;

        -- Atomic swap
        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.demographics;
            INSERT INTO oneroster12.demographics SELECT * FROM #staging_demographics;
        COMMIT TRANSACTION;

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Success', row_count = @RowCount
        WHERE history_id = @HistoryID;

        DROP TABLE #staging_demographics;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        SELECT @ErrorMessage = ERROR_MESSAGE(), @ErrorSeverity = ERROR_SEVERITY(), @ErrorState = ERROR_STATE();

        INSERT INTO oneroster12.refresh_errors
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES
            ('demographics', @ErrorMessage, @ErrorSeverity, @ErrorState, 'sp_refresh_demographics', ERROR_LINE());

        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(), status = 'Failed'
        WHERE history_id = @HistoryID;

        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO
