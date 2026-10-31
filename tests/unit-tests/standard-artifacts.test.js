// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

// Guards for invariants that must hold in every standard/<version> artifact tree.
// Each data standard has its own copy of the SQL, so a fix applied to one tree
// (or lost in a merge) is easy to miss in the others.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from '@jest/globals';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const standardDir = path.join(repoRoot, 'standard');

const versions = fs.readdirSync(standardDir)
  .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
  .sort();

function readArtifact(version, ...parts) {
  return fs.readFileSync(path.join(standardDir, version, 'artifacts', ...parts), 'utf8');
}

// Returns every VALUES tuple whose first value is a 1EdTech OneRoster namespace,
// as { type, values }, where type is e.g. 'SexDescriptor'. Handles tuples that
// span several lines (mssql) and quoted strings that contain parentheses.
function oneRosterDescriptorTuples(sql) {
  const tupleStart = /\(\s*'uri:\/\/1edtech\.org\/oneroster12\/(\w+)'/g;
  const nextValue = /\s*,\s*'((?:[^']|'')*)'/y;
  const tuples = [];
  let match;
  while ((match = tupleStart.exec(sql)) !== null) {
    const values = [];
    nextValue.lastIndex = match.index + match[0].length;
    let value;
    while ((value = nextValue.exec(sql)) !== null) {
      values.push(value[1]);
    }
    tuples.push({ type: match[1], values });
  }
  return tuples;
}

describe('standard artifacts', () => {
  test('finds the data standard trees', () => {
    expect(versions).toEqual(expect.arrayContaining(['4.0.0', '5.2.0', '6.1.0']));
  });

  describe.each(versions)('Data Standard %s', (version) => {
    test.each(['mssql', 'pgsql'])('%s 01_descriptors.sql uses the discriminator that matches each namespace', (engine) => {
      const tuples = oneRosterDescriptorTuples(readArtifact(version, engine, 'core', '01_descriptors.sql'));

      expect(tuples.length).toBeGreaterThan(0);
      for (const { type, values } of tuples) {
        // (namespace,) codevalue, shortdescription, description, discriminator
        expect(values).toHaveLength(4);
        expect({ type, codeValue: values[0], discriminator: values[3] })
          .toEqual({ type, codeValue: values[0], discriminator: `edfi.${type}` });
      }
    });

    test('mssql refresh_history.status allows every status the master refresh writes', () => {
      const setup = readArtifact(version, 'mssql', 'core', '00_setup.sql');
      const constraint = /status\s+NVARCHAR\(\d+\)\s+CHECK\s*\(status\s+IN\s*\(([^)]*)\)\)/i.exec(setup);
      expect(constraint).not.toBeNull();
      const allowed = [...constraint[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);

      const orchestrationDir = path.join(standardDir, version, 'artifacts', 'mssql', 'orchestration');
      const masterRefresh = fs.readdirSync(orchestrationDir).find((f) => /^master_refresh.*\.sql$/.test(f));
      expect(masterRefresh).toBeDefined();
      const written = [...readArtifact(version, 'mssql', 'orchestration', masterRefresh)
        .matchAll(/SET\s+@OverallStatus\s*=\s*'([^']*)'/gi)].map((m) => m[1]);

      expect(written).toContain('Partial Success');
      expect(allowed).toEqual(expect.arrayContaining(written));
    });
  });
});
