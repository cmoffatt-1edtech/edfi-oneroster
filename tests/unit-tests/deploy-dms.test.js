// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, test, expect } from '@jest/globals';
import { ENGINES, findProjections, findReferencedObjects, resolvePlaceholders, splitBatches } from '../../standard/deploy-dms.js';
import { findPlaceholders, listArtifactFiles, listOrchestrationFiles } from '../../standard/dms/build-name-map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STANDARD = path.join(__dirname, '..', '..', 'standard');
const KEY = 'Ed-Fi/StudentEducationOrganizationAssociation/$.studentIdentificationCodes[*]';
const nameMap = name => ({ tables: { [KEY]: { schema: 'edfi', name } } });

describe('resolvePlaceholders', () => {
  const text = `select * from {{table:${KEY}}} c`;

  test('quotes the physical name the engine\'s way', () => {
    expect(resolvePlaceholders(text, nameMap('Short_c15030660d'))).toBe('select * from edfi."Short_c15030660d" c');
    expect(resolvePlaceholders(text, nameMap('LongName'), ENGINES.mssql.quote)).toBe('select * from edfi.[LongName] c');
  });

  test('fails on a placeholder the map lacks', () => {
    expect(() => resolvePlaceholders('{{table:Ed-Fi/Other/$.x[*]}}', nameMap('x'))).toThrow('No name-map entry');
  });
});

describe('findReferencedObjects', () => {
  test('finds quoted DMS names per engine, ignoring comments', () => {
    const pgsql = 'from edfi."School" s join dms."Descriptor" d -- edfi."NotUsed"\n join oneroster12."orgs" o';
    expect(findReferencedObjects(pgsql)).toEqual(['dms.Descriptor', 'edfi.School']);
    const mssql = 'FROM edfi.[School] s JOIN dms.[Descriptor] d -- edfi.[NotUsed]\n JOIN auth.[EducationOrganizationIdToStudentDocumentId] a ON s.[SchoolId] = 1';
    expect(findReferencedObjects(mssql, ENGINES.mssql.referencePattern))
      .toEqual(['auth.EducationOrganizationIdToStudentDocumentId', 'dms.Descriptor', 'edfi.School']);
  });
});

describe('findProjections', () => {
  test('materialized views on PostgreSQL, tables on SQL Server', () => {
    expect(findProjections('create materialized view if not exists oneroster12.orgs as select 1')).toEqual(['orgs']);
    expect(findProjections('CREATE TABLE oneroster12.orgs (x int);\nCREATE TABLE #staging_orgs (x int);', ENGINES.mssql.projectionPattern))
      .toEqual(['orgs']);
  });
});

describe('splitBatches', () => {
  test('splits on GO lines only', () => {
    expect(splitBatches("select 1;\nGO\n  go  \nselect 'GO' as category;\nGO\n")).toEqual(['select 1;', "select 'GO' as category;"]);
  });
});

// The artifact sets as committed: what deploy-dms.js will find and need
describe.each([
  ['5.2.0', 'dms-pgsql', ENGINES.postgres],
  ['5.2.0', 'dms-mssql', ENGINES.mssql],
  ['6.1.0', 'dms-pgsql', ENGINES.postgres],
  ['6.1.0', 'dms-mssql', ENGINES.mssql]
])('standard/%s/artifacts/%s', (version, directory, engine) => {
  const dir = path.join(STANDARD, version, 'artifacts', directory);
  const files = [...listArtifactFiles(dir), ...listOrchestrationFiles(dir)];
  const texts = files.map(file => fs.readFileSync(file, 'utf8'));

  test('creates the seven projections', () => {
    const projections = texts.flatMap(text => findProjections(text, engine.projectionPattern)).filter(name => !name.startsWith('refresh_'));
    expect(projections.sort()).toEqual(['academicsessions', 'classes', 'courses', 'demographics', 'enrollments', 'orgs', 'users']);
  });

  test('has a name map for its engine covering every placeholder', () => {
    const maps = fs.readdirSync(dir).filter(file => /^name-map\.[0-9a-f]{12}\.json$/.test(file));
    expect(maps.length).toBeGreaterThan(0);
    for (const file of maps) {
      const map = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      expect(map.dialect).toBe(engine.dialect);
      for (const text of texts) expect(() => resolvePlaceholders(text, map, engine.quote)).not.toThrow();
      expect(Object.keys(map.tables).sort()).toEqual(findPlaceholders(texts));
    }
  });

  test('names DMS objects only in the quoted form the reference check sees', () => {
    // An unquoted edfi.Name would slip past the check that every referenced object exists
    // ([edfi.resource] is a FOR JSON path, not an object)
    const unquoted = /(?<!\[)\b(edfi|dms|auth|tpdm)\.(?!["[])([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const [i, text] of texts.entries()) {
      const code = text.replace(/--[^\n]*/g, '');
      expect([path.basename(files[i]), [...code.matchAll(unquoted)].map(m => m[0])]).toEqual([path.basename(files[i]), []]);
    }
  });
});
