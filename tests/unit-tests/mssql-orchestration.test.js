// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

// stack/setup-oneroster-data.psm1 deploys orchestration/master_refresh.sql by name and then runs
// oneroster12.sp_refresh_all for the first data load. If a data standard ships the procedure under
// another file name, the stack only warns, and the OneRoster tables stay empty.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from '@jest/globals';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const standardDir = path.join(repoRoot, 'standard');

const versions = fs.readdirSync(standardDir)
  .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
  .filter((version) => fs.existsSync(path.join(standardDir, version, 'artifacts', 'mssql', 'orchestration')))
  .sort();

describe('SQL Server orchestration scripts', () => {
  test('finds the data standard trees', () => {
    expect(versions).toEqual(expect.arrayContaining(['4.0.0', '5.2.0', '6.1.0']));
  });

  test('setup-oneroster-data.psm1 deploys master_refresh.sql', () => {
    const setup = fs.readFileSync(path.join(repoRoot, 'stack', 'setup-oneroster-data.psm1'), 'utf8');
    expect(setup).toContain("-ChildPath 'master_refresh.sql'");
  });

  test.each(versions)('Data Standard %s creates sp_refresh_all in orchestration/master_refresh.sql', (version) => {
    const file = path.join(standardDir, version, 'artifacts', 'mssql', 'orchestration', 'master_refresh.sql');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/CREATE\s+(OR\s+ALTER\s+)?PROCEDURE\s+\[?oneroster12\]?\.\[?sp_refresh_all\b/i);
  });
});
