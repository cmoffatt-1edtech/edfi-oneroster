// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { ASSESSMENT_VIEWS } from '../../src/config/assessment-rostering.js';

// The assessment rostering artifacts as committed: every set that has them defines all four
// objects; Data Standard 4.0 has none (no assessment registration data).
const STANDARD = new URL('../../standard/', import.meta.url).pathname;
const FILES = ['assessments.sql', 'assessment_offerings.sql', 'assessment_enrollments.sql', 'assessment_auth_orgs.sql'];

const read = (version, set, file) => fs.readFileSync(path.join(STANDARD, version, 'artifacts', set, 'core', file), 'utf8');
const exists = (version, set, file) => fs.existsSync(path.join(STANDARD, version, 'artifacts', set, 'core', file));

describe.each([
  ['5.2.0', 'pgsql'],
  ['5.2.0', 'dms-pgsql'],
  ['5.2.0', 'mssql'],
  ['5.2.0', 'dms-mssql']
])('standard/%s/artifacts/%s', (version, set) => {
  const texts = FILES.map(file => read(version, set, file)).join('\n');
  const mssql = set.endsWith('mssql');

  test('defines the three views and the helper', () => {
    for (const view of ASSESSMENT_VIEWS) {
      const pattern = mssql
        ? new RegExp(`create\\s+table\\s+oneroster12\\.${view}\\s*\\(`, 'i')
        : new RegExp(`create\\s+materialized\\s+view\\s+if\\s+not\\s+exists\\s+oneroster12\\.${view}\\s+as`, 'i');
      expect([view, pattern.test(texts)]).toEqual([view, true]);
      if (mssql) expect(texts).toContain(`CREATE PROCEDURE oneroster12.sp_refresh_${view}`);
    }
  });

  test('escapes key parts before joining them with a pipe', () => {
    expect(texts).toMatch(mssql ? /REPLACE\(REPLACE\(LOWER\(/ : /replace\(replace\(lower\(/);
  });

  if (mssql) {
    test('hashes the new sourcedIds as UTF-8, as PostgreSQL does', () => {
      expect(texts).toContain('COLLATE Latin1_General_100_CI_AS_SC_UTF8 AS VARCHAR(MAX)');
    });

    test('sp_refresh_all refreshes the four tables and counts them', () => {
      const orchestration = fs.readFileSync(path.join(STANDARD, version, 'artifacts', set, 'orchestration', 'master_refresh.sql'), 'utf8');
      for (const view of ASSESSMENT_VIEWS) expect(orchestration).toContain(`('${view}')`);
      expect(orchestration).not.toMatch(/ORDER BY table_name\) < 7 THEN/);
    });
  }
});

describe.each(['pgsql', 'mssql'])('standard/4.0.0/artifacts/%s', set => {
  test('has no assessment rostering artifacts', () => {
    for (const file of FILES) expect([file, exists('4.0.0', set, file)]).toEqual([file, false]);
  });
});
