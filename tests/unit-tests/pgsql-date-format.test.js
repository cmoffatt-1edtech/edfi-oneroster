// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

// On PostgreSQL a date cast to text follows the session DateStyle ('SQL, MDY' renders 08/23/2024),
// so the views format dates with to_char(..., 'YYYY-MM-DD') instead. The materialized views keep the
// text built at refresh time, so a non-ISO DateStyle on the refreshing role would change API output
// and any sourcedId hashed from a date.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from '@jest/globals';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const standardDir = path.join(repoRoot, 'standard');

// Every PostgreSQL artifact file, as [relative path, sql]
const pgsqlFiles = fs.readdirSync(standardDir)
  .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
  .flatMap((version) => fs.readdirSync(path.join(standardDir, version, 'artifacts'))
    .filter((engine) => /pgsql$/.test(engine))
    .map((engine) => path.join(version, 'artifacts', engine, 'core')))
  .filter((dir) => fs.existsSync(path.join(standardDir, dir)))
  .flatMap((dir) => fs.readdirSync(path.join(standardDir, dir))
    .filter((file) => file.endsWith('.sql'))
    .map((file) => path.join(dir, file)))
  .sort()
  .map((file) => [file, fs.readFileSync(path.join(standardDir, file), 'utf8')]);

// A column whose name contains "date" or "day" cast straight to text, e.g. birthdate::text,
// ssa."BeginDate"::varchar, first_school_day::date::text
const dateToText = /[\w."]*(?:date|day)"?(?:::date)?::(?:text|varchar)\b/gi;

function withoutComments(sql) {
  return sql.replace(/--.*$/gm, '');
}

describe('PostgreSQL artifacts format dates explicitly', () => {
  test('finds the PostgreSQL artifacts', () => {
    expect(pgsqlFiles.length).toBeGreaterThan(0);
  });

  test.each(pgsqlFiles)('%s has no date-to-text casts', (file, sql) => {
    expect(withoutComments(sql).match(dateToText) ?? []).toEqual([]);
  });
});
