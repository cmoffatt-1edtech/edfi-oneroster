-- =============================================
-- MS SQL Server Refresh Procedure for Enrollments
-- Refreshes the oneroster12.enrollments table
-- Based on PostgreSQL enrollments materialized view
-- =============================================

-- Set required options for Ed-Fi database operations
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('oneroster12.sp_refresh_enrollments', 'P') IS NOT NULL
    DROP PROCEDURE oneroster12.sp_refresh_enrollments;
GO

CREATE PROCEDURE oneroster12.sp_refresh_enrollments
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @StartTime DATETIME2 = GETDATE();
    DECLARE @RowCount INT;
    DECLARE @ErrorMessage NVARCHAR(4000);
    DECLARE @ErrorSeverity INT;
    DECLARE @ErrorState INT;
    
    -- Log start of refresh
    INSERT INTO oneroster12.refresh_history (table_name, refresh_start, status)
    VALUES ('enrollments', @StartTime, 'Running');
    
    DECLARE @HistoryID INT = SCOPE_IDENTITY();
    
    BEGIN TRY
        -- Create staging table
        IF OBJECT_ID('tempdb..#staging_enrollments') IS NOT NULL
            DROP TABLE #staging_enrollments;
            
        CREATE TABLE #staging_enrollments (
            sourcedId NVARCHAR(64) NOT NULL PRIMARY KEY,
            status NVARCHAR(16) NOT NULL,
            dateLastModified DATETIME2 NULL,
            class NVARCHAR(MAX) NULL,
            school NVARCHAR(MAX) NULL,
            [user] NVARCHAR(MAX) NULL,
            role NVARCHAR(32) NULL,
            [primary] BIT NULL,
            beginDate NVARCHAR(32) NULL,
            endDate NVARCHAR(32) NULL,
            metadata NVARCHAR(MAX) NULL
        );
        
        -- Insert data into staging table following PostgreSQL pattern exactly
        WITH staff_section_associations AS (
            SELECT * FROM edfi.StaffSectionAssociation
        ),
        student_section_associations AS (
            SELECT * FROM edfi.StudentSectionAssociation
        ),
        sections AS (
            SELECT * FROM edfi.Section
        ),
        staff_enrollments_formatted AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', 
                    CONCAT(LOWER(staff.StaffUniqueId), '-', LOWER(sections.LocalCourseCode), '-', 
                           CAST(sections.SchoolId AS VARCHAR(50)), '-', LOWER(sections.SectionIdentifier), '-', 
                           LOWER(sections.SessionName), '-', CONVERT(VARCHAR(32), ssa.BeginDate, 23))), 2)) AS sourcedId,
                'active' AS status,
                ssa.LastModifiedDate AS dateLastModified,
                (SELECT 
                    CONCAT('/classes/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', 
                        CONCAT(LOWER(sections.LocalCourseCode), '-', CAST(sections.SchoolId AS VARCHAR(50)), 
                               '-', LOWER(sections.SectionIdentifier), '-', LOWER(sections.SessionName))), 2))) AS href,
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', 
                        CONCAT(LOWER(sections.LocalCourseCode), '-', CAST(sections.SchoolId AS VARCHAR(50)), 
                               '-', LOWER(sections.SectionIdentifier), '-', LOWER(sections.SessionName))), 2)) AS sourcedId,
                    'class' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS class,
                (SELECT 
                    CONCAT('/users/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', staff.StaffUniqueId), 2))) AS href,
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', staff.StaffUniqueId), 2)) AS sourcedId,
                    'user' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS [user],
                (SELECT 
                    CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(sections.SchoolId AS VARCHAR(50))), 2))) AS href,
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(sections.SchoolId AS VARCHAR(50))), 2)) AS sourcedId,
                    'org' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS school,
                'teacher' AS role,
                CAST(0 AS BIT) AS [primary],
                CONVERT(NVARCHAR(32), ssa.BeginDate, 23) AS beginDate,
                CONVERT(NVARCHAR(32), ssa.EndDate, 23) AS endDate,
                (SELECT 
                    'staffSectionAssociations' AS [edfi.resource],
                    staff.StaffUniqueId AS [edfi.naturalKey.staffUniqueId],
                    sections.LocalCourseCode AS [edfi.naturalKey.localCourseCode],
                    sections.SchoolId AS [edfi.naturalKey.schoolId],
                    sections.SectionIdentifier AS [edfi.naturalKey.sectionIdentifier],
                    sections.SessionName AS [edfi.naturalKey.sessionName],
                    ssa.BeginDate AS [edfi.naturalKey.beginDate]
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata
            FROM staff_section_associations ssa
            JOIN edfi.Staff staff ON ssa.StaffUSI = staff.StaffUSI
            JOIN sections ON ssa.SectionIdentifier = sections.SectionIdentifier
                AND ssa.LocalCourseCode = sections.LocalCourseCode
                AND ssa.SchoolId = sections.SchoolId
                AND ssa.SchoolYear = sections.SchoolYear
                AND ssa.SessionName = sections.SessionName
        ),
        student_enrollments_formatted AS (
            SELECT
                LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', 
                    CONCAT(LOWER(student.StudentUniqueId), '-', LOWER(sections.LocalCourseCode), '-', 
                           CAST(sections.SchoolId AS VARCHAR(50)), '-', LOWER(sections.SectionIdentifier), '-', 
                           LOWER(sections.SessionName), '-', CONVERT(VARCHAR(32), ssa.BeginDate, 23))), 2)) AS sourcedId,
                'active' AS status,
                ssa.LastModifiedDate AS dateLastModified,
                (SELECT 
                    CONCAT('/classes/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', 
                        CONCAT(LOWER(sections.LocalCourseCode), '-', CAST(sections.SchoolId AS VARCHAR(50)), 
                               '-', LOWER(sections.SectionIdentifier), '-', LOWER(sections.SessionName))), 2))) AS href,
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', 
                        CONCAT(LOWER(sections.LocalCourseCode), '-', CAST(sections.SchoolId AS VARCHAR(50)), 
                               '-', LOWER(sections.SectionIdentifier), '-', LOWER(sections.SessionName))), 2)) AS sourcedId,
                    'class' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS class,
                (SELECT 
                    CONCAT('/users/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', student.StudentUniqueId), 2))) AS href,
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', student.StudentUniqueId), 2)) AS sourcedId,
                    'user' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS [user],
                (SELECT 
                    CONCAT('/orgs/', LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(sections.SchoolId AS VARCHAR(50))), 2))) AS href,
                    LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', CAST(sections.SchoolId AS VARCHAR(50))), 2)) AS sourcedId,
                    'org' AS type
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS school,
                'student' AS role,
                CAST(0 AS BIT) AS [primary],
                CONVERT(NVARCHAR(32), ssa.BeginDate, 23) AS beginDate,
                CONVERT(NVARCHAR(32), ssa.EndDate, 23) AS endDate,
                (SELECT 
                    'studentSectionAssociations' AS [edfi.resource],
                    student.StudentUniqueId AS [edfi.naturalKey.studentUniqueId],
                    sections.LocalCourseCode AS [edfi.naturalKey.localCourseCode],
                    sections.SchoolId AS [edfi.naturalKey.schoolId],
                    sections.SectionIdentifier AS [edfi.naturalKey.sectionIdentifier],
                    sections.SessionName AS [edfi.naturalKey.sessionName],
                    ssa.BeginDate AS [edfi.naturalKey.beginDate]
                 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS metadata
            FROM student_section_associations ssa
            JOIN edfi.Student student ON ssa.StudentUSI = student.StudentUSI
            JOIN sections ON ssa.SectionIdentifier = sections.SectionIdentifier
                AND ssa.LocalCourseCode = sections.LocalCourseCode
                AND ssa.SchoolId = sections.SchoolId
                AND ssa.SchoolYear = sections.SchoolYear
                AND ssa.SessionName = sections.SessionName
        )
        INSERT INTO #staging_enrollments
        SELECT * FROM staff_enrollments_formatted
        UNION ALL
        SELECT * FROM student_enrollments_formatted;
        
        SET @RowCount = @@ROWCOUNT;
        
        -- Atomic swap
        BEGIN TRANSACTION;
            TRUNCATE TABLE oneroster12.enrollments;
            
            INSERT INTO oneroster12.enrollments
            SELECT * FROM #staging_enrollments;
        COMMIT TRANSACTION;
        
        -- Update history with success
        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(),
            status = 'Success',
            row_count = @RowCount
        WHERE history_id = @HistoryID;
        
        -- Clean up
        DROP TABLE #staging_enrollments;
        
        PRINT CONCAT('Enrollments refresh completed successfully. Rows: ', @RowCount);
        
    END TRY
    BEGIN CATCH
        -- Rollback if transaction is open
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
            
        SELECT 
            @ErrorMessage = ERROR_MESSAGE(),
            @ErrorSeverity = ERROR_SEVERITY(),
            @ErrorState = ERROR_STATE();
        
        -- Log error
        INSERT INTO oneroster12.refresh_errors 
            (table_name, error_message, error_severity, error_state, error_procedure, error_line)
        VALUES 
            ('enrollments', @ErrorMessage, @ErrorSeverity, @ErrorState, 
             'sp_refresh_enrollments', ERROR_LINE());
        
        -- Update history with failure
        UPDATE oneroster12.refresh_history
        SET refresh_end = GETDATE(),
            status = 'Failed'
        WHERE history_id = @HistoryID;
        
        -- Re-raise error
        RAISERROR (@ErrorMessage, @ErrorSeverity, @ErrorState);
    END CATCH
END
GO

PRINT 'Stored procedure oneroster12.sp_refresh_enrollments created successfully';
GO