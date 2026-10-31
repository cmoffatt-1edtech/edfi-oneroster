// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

// seedData/*.jsonl seeds the OneRoster descriptors and descriptor mappings through
// the Ed-Fi API; core/01_descriptors.sql and core/02_descriptorMappings.sql insert the
// same rows directly into an ODS. Keep the two in step, and keep the JSONL within the
// Ed-Fi API's field lengths (the SQL path would fail on the column sizes instead).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from '@jest/globals';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const seedDir = path.join(repoRoot, 'seedData');
const standardDir = path.join(repoRoot, 'standard');

// Ed-Fi Descriptor and DescriptorMapping field lengths.
const MAX_CODE_VALUE = 50;
const MAX_SHORT_DESCRIPTION = 75;
const MAX_DESCRIPTION = 1024;
const MAX_MAPPING_VALUE = 50;

const versions = fs.readdirSync(standardDir)
  .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
  .sort();

function readJsonl(file) {
  return fs.readFileSync(path.join(seedDir, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

const mappingFile = 'descriptorMappings.jsonl';
const descriptorFiles = fs.readdirSync(seedDir)
  .filter((file) => file.endsWith('.jsonl') && file !== mappingFile);
const jsonDescriptors = descriptorFiles.flatMap(readJsonl);
const jsonMappings = readJsonl(mappingFile);

// Returns the values of every SQL VALUES tuple that starts with a 'uri://...' string,
// unescaping doubled quotes. Tuples may span several lines (mssql MERGE sources).
function uriTuples(sql) {
  const tupleStart = /\(\s*'(uri:\/\/(?:[^']|'')*)'/g;
  const nextValue = /\s*,\s*'((?:[^']|'')*)'/y;
  const tuples = [];
  let match;
  while ((match = tupleStart.exec(sql)) !== null) {
    const values = [match[1]];
    nextValue.lastIndex = match.index + match[0].length;
    let value;
    while ((value = nextValue.exec(sql)) !== null) {
      values.push(value[1]);
    }
    tuples.push(values.map((v) => v.replace(/''/g, "'")));
  }
  return tuples;
}

const byKey = (keys) => (a, b) => {
  const ka = keys.map((k) => a[k]).join('\u0000');
  const kb = keys.map((k) => b[k]).join('\u0000');
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};
const sortDescriptors = (rows) => [...rows].sort(byKey(['namespace', 'codeValue']));
const sortMappings = (rows) => [...rows].sort(byKey(['namespace', 'value', 'mappedNamespace']));

describe('seedData', () => {
  test('has descriptor and mapping rows', () => {
    expect(descriptorFiles.length).toBeGreaterThan(0);
    expect(jsonDescriptors.length).toBeGreaterThan(0);
    expect(jsonMappings.length).toBeGreaterThan(0);
  });

  test('descriptors fit the Ed-Fi field lengths', () => {
    const tooLong = jsonDescriptors.filter((d) =>
      d.codeValue.length > MAX_CODE_VALUE
      || d.shortDescription.length > MAX_SHORT_DESCRIPTION
      || d.description.length > MAX_DESCRIPTION);
    expect(tooLong).toEqual([]);
  });

  test('descriptor mappings fit the Ed-Fi field lengths', () => {
    const tooLong = jsonMappings.filter((m) =>
      m.value.length > MAX_MAPPING_VALUE || m.mappedValue.length > MAX_MAPPING_VALUE);
    expect(tooLong).toEqual([]);
  });

  test('every descriptor mapping targets a seeded 1EdTech descriptor', () => {
    const seeded = new Set(jsonDescriptors.map((d) => `${d.namespace}#${d.codeValue}`));
    const dangling = jsonMappings.filter((m) => !seeded.has(`${m.mappedNamespace}#${m.mappedValue}`));
    expect(dangling).toEqual([]);
  });

  describe.each(versions)('matches the Data Standard %s SQL seeds', (version) => {
    test.each(['mssql', 'pgsql'])('%s', (engine) => {
      const coreDir = path.join(standardDir, version, 'artifacts', engine, 'core');

      const sqlDescriptors = uriTuples(fs.readFileSync(path.join(coreDir, '01_descriptors.sql'), 'utf8'))
        .map(([namespace, codeValue, shortDescription, description]) =>
          ({ namespace, codeValue, shortDescription, description }));
      const sqlMappings = uriTuples(fs.readFileSync(path.join(coreDir, '02_descriptorMappings.sql'), 'utf8'))
        .map(([namespace, value, mappedNamespace, mappedValue]) =>
          ({ namespace, value, mappedNamespace, mappedValue }));

      expect(sortDescriptors(jsonDescriptors)).toEqual(sortDescriptors(sqlDescriptors));
      expect(sortMappings(jsonMappings)).toEqual(sortMappings(sqlMappings));
    });
  });
});
