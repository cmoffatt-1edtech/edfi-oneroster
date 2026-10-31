// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';

// The optional roster fields prototype (docs/design/roster-fields-prototype.md): which metadata keys
// the PostgreSQL views add, on the ODS and DMS sets for Data Standard 5.2.
const STANDARD = new URL('../../standard/', import.meta.url).pathname;
const read = (set, file) => fs.readFileSync(path.join(STANDARD, '5.2.0', 'artifacts', set, 'core', file), 'utf8');

describe.each(['pgsql', 'dms-pgsql'])('standard/5.2.0/artifacts/%s', set => {
  test('orgs add the identifiers, address and phone, leaving out empty values', () => {
    const sql = read(set, 'orgs.sql');
    for (const key of ['NCESId', 'orgStateId', 'address1', 'address2', 'city', 'state', 'postalCode', 'phone']) {
      expect([key, sql.includes(`'${key}'`)]).toEqual([key, true]);
    }
    expect(sql).toContain('jsonb_strip_nulls');
    // every org type merges them into its metadata
    expect(sql.match(/\|\| coalesce\(x\.extras, '\{\}'::jsonb\)\)::json as metadata/g)).toHaveLength(3);
  });

  test('courses add the state course code', () => {
    const sql = read(set, 'courses.sql');
    expect(sql).toContain("'State course code'");
    expect(sql).toContain("jsonb_build_object('courseStateId', state_codes.state_code)");
  });
});
