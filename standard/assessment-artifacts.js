// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import path from 'path';

/**
 * The assessment rostering artifacts (core/assessment*.sql) read the Assessment Registration
 * domain, new in Data Standard 5.2, and on SQL Server hash with a UTF-8 collation, new in SQL
 * Server 2019. Data Standard 5.0 and 5.1 deploy the 5.2.0 artifacts too, so the deploy scripts
 * leave these files out where the database can't take them. The rostering views deploy as
 * before, the refresh skips what isn't there, and the endpoints answer "not available".
 */
export const ASSESSMENT_MIN_SQL_SERVER_MAJOR_VERSION = 15;

// Whether the ODS has the Assessment Registration tables, one row with a 0/1 column `present`
export const ASSESSMENT_REGISTRATION_QUERY = {
    pgsql: "SELECT (to_regclass('edfi.assessmentadministration') IS NOT NULL)::int AS present",
    mssql: "SELECT CASE WHEN OBJECT_ID('edfi.AssessmentAdministration', 'U') IS NULL THEN 0 ELSE 1 END AS present"
};

export const isAssessmentArtifact = file => path.basename(file).startsWith('assessment');

/**
 * @param {string[]} files - SQL files in deploy order
 * @param {{ hasAssessmentRegistration: boolean, sqlServerMajorVersion?: number }} target
 * @returns {{ files: string[], skipped: string[], reason: string|null }}
 */
export function selectArtifactFiles(files, { hasAssessmentRegistration, sqlServerMajorVersion } = {}) {
    let reason = null;
    if (!hasAssessmentRegistration) {
        reason = 'the database has no Assessment Registration tables (Data Standard before 5.2)';
    } else if (sqlServerMajorVersion !== undefined && sqlServerMajorVersion < ASSESSMENT_MIN_SQL_SERVER_MAJOR_VERSION) {
        reason = `SQL Server ${sqlServerMajorVersion} is older than 2019`;
    }

    const skipped = reason ? files.filter(isAssessmentArtifact) : [];
    return { files: files.filter(file => !skipped.includes(file)), skipped, reason: skipped.length ? reason : null };
}
