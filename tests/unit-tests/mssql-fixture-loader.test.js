// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import { MSSQL_PLATFORMS, MssqlLoader } from '../mssql-fixture-loader.js';
import { fixtureDescriptors, FIXTURE } from '../dms-parity-fixture.js';

const IDENTIFICATION_CODES = 'StudentEducationOrganizationAssociationStudentIdentificationCode';

/** A knex transaction stand-in: answers the loader's catalog queries and records every statement. */
function fakeTrx({ columns = {}, foreignKeys = {}, descriptors = [] } = {}) {
  const tables = [
    { schema: 'edfi', name: 'Student' },
    { schema: 'edfi', name: 'Descriptor' },
    { schema: 'edfi', name: 'StudentEducationOrganizationAssociation' },
    { schema: 'edfi', name: IDENTIFICATION_CODES },
    { schema: 'dms', name: 'Descriptor' }
  ];
  const calls = [];
  return {
    calls,
    statements: () => calls.map(call => call.sql),
    raw: async (sql, bindings = []) => {
      calls.push({ sql, bindings });
      if (sql.includes('from sys.tables')) return tables.filter(t => t.schema.toLowerCase() === bindings[0].toLowerCase());
      if (sql.includes('from sys.columns')) return columns[bindings[0]] ?? [];
      if (sql.includes('from sys.foreign_keys')) return (foreignKeys[bindings[0]] ?? []).map(name => ({ name }));
      if (sql.includes('openjson')) return descriptors;
      if (sql.includes('dms.ResourceKey')) return [{ id: 7 }];
      return [];
    }
  };
}

const column = (name, extra = {}) => ({ name, identity: 0, computed: 0, sequence: 0, ...extra });
const STUDENT_COLUMNS = [
  column('StudentUSI', { identity: 1 }), column('StudentUniqueId'), column('FirstName'), column('CreateDate'),
  column('ChangeVersion', { sequence: 1 }), column('AggregateId', { sequence: 1 }), column('Discriminator')
];

describe('MssqlLoader.findTable', () => {
  test('matches a table without regard to case', async () => {
    const loader = new MssqlLoader(fakeTrx(), null);
    expect(await loader.findTable('edfi.student')).toEqual({ schema: 'edfi', name: 'Student' });
  });

  test('matches a PostgreSQL-truncated name to the one long table it starts', async () => {
    const loader = new MssqlLoader(fakeTrx(), null);
    expect(await loader.findTable('edfi.studenteducationorganizationassociationstudentidentifica_c15030'))
      .toEqual({ schema: 'edfi', name: IDENTIFICATION_CODES });
  });

  test('resolves a DMS placeholder through the name map', async () => {
    const nameMap = { tables: { 'Ed-Fi/Thing': { schema: 'edfi', name: 'Student' } } };
    const loader = new MssqlLoader(fakeTrx(), nameMap);
    expect(await loader.findTable('{{table:Ed-Fi/Thing}}')).toEqual({ schema: 'edfi', name: 'Student' });
  });

  test('refuses a name it cannot place', async () => {
    const loader = new MssqlLoader(fakeTrx(), null);
    await expect(loader.findTable('edfi.staff')).rejects.toThrow('No single SQL Server table for edfi.staff');
  });
});

describe('MssqlLoader.insert', () => {
  const columns = { '[edfi].[Student]': STUDENT_COLUMNS };

  test('gives identity and sequence columns negative explicit values, with IDENTITY_INSERT in the same batch', async () => {
    const trx = fakeTrx({ columns });
    const loader = new MssqlLoader(trx, null);
    await loader.insert({ table: 'edfi.student', values: { studentuniqueid: 'FX-STU-1', firstname: 'Ada' } });

    const insert = trx.calls.find(call => call.sql.includes('insert into'));
    expect(insert.sql).toBe(
      'set identity_insert [edfi].[Student] on; ' +
      'insert into [edfi].[Student] ([StudentUniqueId], [FirstName], [StudentUSI], [ChangeVersion], [AggregateId]) values (?, ?, ?, ?, ?); ' +
      'set identity_insert [edfi].[Student] off'
    );
    expect(insert.bindings.slice(0, 2)).toEqual(['FX-STU-1', 'Ada']);
    expect(insert.bindings.slice(2)).toEqual([-2_000_000_000, -1_999_999_999, -1_999_999_998]);
  });

  test('keeps an explicit identity value and leaves IDENTITY_INSERT out when no identity column is written', async () => {
    const trx = fakeTrx({ columns: { '[edfi].[StudentEducationOrganizationAssociation]': [column('StudentUSI'), column('EducationOrganizationId')] } });
    const loader = new MssqlLoader(trx, null);
    await loader.insert({ table: 'edfi.studenteducationorganizationassociation', values: { studentusi: -5, educationorganizationid: 990001 } });
    const insert = trx.calls.find(call => call.sql.includes('insert into'));
    expect(insert.sql).not.toContain('identity_insert');
    expect(insert.bindings).toEqual([-5, 990001]);
  });

  test('reads a Z timestamp as UTC wall-clock time and leaves other strings alone', async () => {
    const trx = fakeTrx({ columns });
    const loader = new MssqlLoader(trx, null);
    await loader.insert({ table: 'edfi.student', values: { studentusi: 1, createdate: '2026-02-01T08:00:00Z', firstname: 'Z' } });
    const insert = trx.calls.find(call => call.sql.includes('insert into'));
    expect(insert.bindings.slice(0, 3)).toEqual([1, '2026-02-01T08:00:00', 'Z']);
  });

  test('disables the foreign keys and triggers of each table it writes, once', async () => {
    const trx = fakeTrx({ columns, foreignKeys: { '[edfi].[Student]': ['FK_Student_Sex', 'FK_Student_Country'] } });
    const loader = new MssqlLoader(trx, null);
    await loader.insert({ table: 'edfi.student', values: { studentuniqueid: 'FX-STU-1' } });
    await loader.insert({ table: 'edfi.student', values: { studentuniqueid: 'FX-STU-2' } });
    const ddl = trx.statements().filter(sql => /^(alter|disable)/.test(sql));
    expect(ddl).toEqual([
      'alter table [edfi].[Student] nocheck constraint [FK_Student_Sex], [FK_Student_Country]',
      'disable trigger all on [edfi].[Student]'
    ]);
  });

  test('refuses an unknown or computed column', async () => {
    const trx = fakeTrx({ columns: { '[edfi].[Student]': [...STUDENT_COLUMNS, column('Uri', { computed: 1 })] } });
    const loader = new MssqlLoader(trx, null);
    await expect(loader.insert({ table: 'edfi.student', values: { nickname: 'x' } })).rejects.toThrow('edfi.Student has no column nickname');
    await expect(loader.insert({ table: 'edfi.student', values: { uri: 'x' } })).rejects.toThrow('edfi.Student.Uri is a computed column');
  });

  test('resolves descriptor references to the ids it looked up', async () => {
    const trx = fakeTrx({ columns: { '[edfi].[Student]': [column('StudentUSI'), column('BirthSexDescriptorId')] } });
    const loader = new MssqlLoader(trx, null);
    loader.descriptorIds.set('uri://ed-fi.org/SexDescriptor#Female', 12);
    await loader.insert({ table: 'edfi.student', values: { studentusi: 1, birthsexdescriptorid: { $descriptor: 'uri://ed-fi.org/SexDescriptor#Female' } } });
    expect(trx.calls.find(call => call.sql.includes('insert into')).bindings).toEqual([1, 12]);
    await expect(loader.insert({ table: 'edfi.student', values: { birthsexdescriptorid: { $descriptor: 'uri://x#y' } } }))
      .rejects.toThrow('Unresolved descriptor uri://x#y');
  });
});

describe('MssqlLoader.resolveDescriptors', () => {
  const uris = fixtureDescriptors(FIXTURE);

  test.each(MSSQL_PLATFORMS.map(platform => [platform.name, platform]))('%s: looks up every fixture descriptor and adds the missing ones', async (name, platform) => {
    const descriptorColumns = name === 'ods'
      ? [column('DescriptorId', { identity: 1 }), column('Namespace'), column('CodeValue'), column('ShortDescription'), column('Discriminator'), column('ChangeVersion', { sequence: 1 })]
      : [column('DescriptorId', { identity: 1 }), column('DocumentId'), column('ResourceKeyId'), column('Namespace'), column('CodeValue'), column('ShortDescription')];
    const table = name === 'ods' ? '[edfi].[Descriptor]' : '[dms].[Descriptor]';
    const trx = fakeTrx({ columns: { [table]: descriptorColumns }, descriptors: uris.slice(1).map((uri, i) => ({ uri, id: i + 1 })) });
    const loader = new MssqlLoader(trx, null);

    expect(await loader.resolveDescriptors(platform)).toEqual([uris[0]]);
    expect(JSON.parse(trx.calls.find(call => call.sql.includes('openjson')).bindings[0])).toEqual(uris);
    expect(loader.descriptorIds.get(uris[0])).toBe(-2_000_000_000);
    const insert = trx.calls.find(call => call.sql.includes('insert into'));
    expect(insert.sql).toContain(`set identity_insert ${table} on`);
    if (name === 'dms') expect(insert.bindings).toContain(7);
  });
});
