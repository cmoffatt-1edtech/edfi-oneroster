-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- SQL Server Agent job that runs oneroster12.sp_refresh_all daily at 02:00, as the ODS job does
-- (standard/6.1.0/artifacts/mssql/orchestration/sql_agent.sql). Differences on DMS:
--   * The job is named after the data store's database, so data stores on one server (one per
--     tenant or school year) each keep their own job.
--   * It stays in the data store's database (msdb procedures are called by name) and doesn't
--     start the job: deploy-dms.js runs sp_refresh_all itself, in the deployment transaction.
-- Needs SQL Server Agent running; deploy-dms.js warns when it isn't.

DECLARE @DatabaseName SYSNAME = DB_NAME();
DECLARE @JobName NVARCHAR(128) = N'OneRoster 1.2 Refresh (' + @DatabaseName + N')';
DECLARE @ScheduleName NVARCHAR(128) = @JobName + N' - Daily 2AM';
DECLARE @JobDescription NVARCHAR(512) = N'Daily refresh of the OneRoster 1.2 tables in Ed-Fi API v8 data store ' + @DatabaseName;

IF EXISTS (SELECT job_id FROM msdb.dbo.sysjobs WHERE name = @JobName)
    EXEC msdb.dbo.sp_delete_job @job_name = @JobName, @delete_unused_schedule = 1;

EXEC msdb.dbo.sp_add_job
    @job_name = @JobName,
    @enabled = 1,
    @description = @JobDescription,
    @start_step_id = 1,
    @category_name = N'Data Collector',
    @owner_login_name = NULL;

EXEC msdb.dbo.sp_add_jobstep
    @job_name = @JobName,
    @step_name = N'Refresh OneRoster Data',
    @step_id = 1,
    @on_success_action = 1, -- Quit with success
    @on_fail_action = 2,    -- Quit with failure
    @retry_attempts = 2,
    @retry_interval = 5,    -- minutes
    @subsystem = N'TSQL',
    @command = N'SET NOCOUNT ON; EXEC oneroster12.sp_refresh_all;',
    @database_name = @DatabaseName;

EXEC msdb.dbo.sp_add_schedule
    @schedule_name = @ScheduleName,
    @enabled = 1,
    @freq_type = 4,         -- Daily
    @freq_interval = 1,
    @freq_subday_type = 1,  -- At the specified time
    @freq_subday_interval = 0,
    @active_start_time = 020000;

EXEC msdb.dbo.sp_attach_schedule @job_name = @JobName, @schedule_name = @ScheduleName;
EXEC msdb.dbo.sp_add_jobserver @job_name = @JobName, @server_name = N'(LOCAL)';
GO
