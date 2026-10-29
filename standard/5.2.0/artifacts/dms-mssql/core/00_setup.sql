-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- OneRoster 1.2 projections over an Ed-Fi API v8 (DMS) data store, Data Standard 5.2, SQL Server.
-- Deployed by standard/deploy-dms.js --db-type mssql, which resolves {{table:...}} placeholders
-- first and runs every file in one transaction.
--
-- Same pattern as standard/5.2.0/artifacts/mssql: each projection is a table filled by
-- oneroster12.sp_refresh_<name> (staging table, then a truncate-and-insert swap);
-- orchestration/ adds sp_refresh_all and the SQL Server Agent job. Rules shared by every file:
--   * DMS names are PascalCase and written bracketed (edfi.[School]); rows are keyed by
--     [DocumentId]. deploy-dms.js checks every bracketed edfi/dms/auth name exists.
--   * Descriptors are int FKs to dms.[Descriptor]; OneRoster mappings come from
--     edfi.[DescriptorMapping], seeded through the API by standard/seed-descriptors.js.
--   * dateLastModified is [ContentLastModifiedAt] (datetime2, UTC), as the ODS lastmodifieddate.
--   * Every sourcedId formula, column, and JSON shape matches standard/5.2.0/artifacts/mssql and
--     the PostgreSQL DMS set (dms-pgsql); person keys are participantDocumentId /
--     studentDocumentId instead of USIs.

IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'oneroster12')
    EXEC('CREATE SCHEMA oneroster12');
GO

-- Refresh logs. Kept across redeployments (the ODS script drops them), so history survives and
-- deploying one projection at a time doesn't contend for them.
IF OBJECT_ID('oneroster12.refresh_errors', 'U') IS NULL
CREATE TABLE oneroster12.refresh_errors (
    error_id INT IDENTITY(1,1) PRIMARY KEY,
    table_name NVARCHAR(128) NOT NULL,
    error_date DATETIME2 DEFAULT GETDATE(),
    error_message NVARCHAR(4000),
    error_severity INT,
    error_state INT,
    error_procedure NVARCHAR(128),
    error_line INT
);
GO

-- 'Partial Success' is what sp_refresh_all records when some tables failed (the DS 5.2 ODS script
-- leaves it out of the constraint; DS 6.1 has it).
IF OBJECT_ID('oneroster12.refresh_history', 'U') IS NULL
CREATE TABLE oneroster12.refresh_history (
    history_id INT IDENTITY(1,1) PRIMARY KEY,
    table_name NVARCHAR(128) NOT NULL,
    refresh_start DATETIME2 NOT NULL,
    refresh_end DATETIME2,
    row_count INT,
    status NVARCHAR(20) CHECK (status IN ('Running', 'Success', 'Partial Success', 'Failed')),
    duration_seconds AS DATEDIFF(SECOND, refresh_start, refresh_end)
);
GO

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE object_id = OBJECT_ID('oneroster12.refresh_history') AND name = 'IX_refresh_history_table_date')
    CREATE INDEX IX_refresh_history_table_date ON oneroster12.refresh_history(table_name, refresh_start DESC);
GO
