// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

// The SQL Server Agent job script runs once per ODS database, and one server can hold several ODS
// databases (one per school year, or per tenant). With a fixed job name each deployment replaced the
// previous database's job, so only the last database deployed was refreshed on a schedule.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from '@jest/globals';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const standardDir = path.join(repoRoot, 'standard');

// [relative path, sql] for each data standard's Agent job script
const agentScripts = fs.readdirSync(standardDir)
  .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
  .map((version) => path.join(version, 'artifacts', 'mssql', 'orchestration'))
  .filter((dir) => fs.existsSync(path.join(standardDir, dir)))
  .flatMap((dir) => fs.readdirSync(path.join(standardDir, dir))
    .filter((file) => /^sql_agent(_job)?\.sql$/i.test(file))
    .map((file) => path.join(dir, file)))
  .sort()
  .map((file) => [file, fs.readFileSync(path.join(standardDir, file), 'utf8')]);

describe('SQL Server Agent job scripts', () => {
  test('finds one per data standard', () => {
    expect(agentScripts.length).toBeGreaterThanOrEqual(3);
  });

  describe.each(agentScripts)('%s', (file, sql) => {
    test('names the job after the ODS database', () => {
      expect(sql).toMatch(/DECLARE @DatabaseName SYSNAME = DB_NAME\(\);/);
      expect(sql).toMatch(/DECLARE @JobName NVARCHAR\(128\) = N'OneRoster 1\.2 Daily Refresh \(' \+ LEFT\(@DatabaseName, \d+\) \+ N'\)';/);
    });

    test('passes job names as variables, never a fixed name', () => {
      expect(sql.match(/@job_name\s*=\s*N?'[^']/gi) ?? []).toEqual([]);
    });

    test('uses @JobName only in the batch that declares it', () => {
      const batches = sql.split(/^\s*GO\s*$/im);
      const declaring = batches.findIndex((batch) => /DECLARE @JobName\b/.test(batch));
      expect(declaring).toBeGreaterThanOrEqual(0);
      batches.forEach((batch, index) => {
        if (index !== declaring) {
          expect({ batch: index, usesJobName: /@JobName\b/.test(batch) }).toEqual({ batch: index, usesJobName: false });
        }
      });
    });
  });
});
