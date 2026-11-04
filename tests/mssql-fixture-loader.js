// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Loads tests/dms-parity-fixture.js into a SQL Server ODS or DMS data store, inside a caller's
 * transaction, as tests/compare-dms-fixture.js's Loader does on PostgreSQL.
 *
 * SQL Server has no session_replication_role, so each table the fixture writes gets its foreign keys
 * and triggers disabled in the transaction (ALTER TABLE ... NOCHECK, DISABLE TRIGGER); the rollback
 * restores them. Check, unique and not-null constraints still apply.
 *
 * Identity values and sequence values are not transactional on SQL Server, so every identity column
 * and every column defaulting to NEXT VALUE FOR gets an explicit value, and the values are negative:
 * an explicit identity value below the current one leaves the identity where it was. readIdentities
 * and readMssqlSequences let a caller check that nothing moved.
 *
 * The fixture's rows use the PostgreSQL ODS names (lower case, long names truncated with a hash
 * suffix) and the DMS names; table and column names are matched without regard to case, and a
 * PostgreSQL-truncated table name matches the one SQL Server table it is a prefix of.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nameMapFileName } from '../standard/dms/build-name-map.js';
import { FIXTURE, fixtureDescriptors, parseDescriptorUri, toDmsRows, toOdsRows } from './dms-parity-fixture.js';
import { resolveTable } from './compare-dms-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Explicit ids count up from here: below any identity a sample database has issued
const FIRST_ID = -2_000_000_000;
// PostgreSQL truncates identifiers longer than 63 bytes to 56 characters, '_' and a 6-character hash
const PG_TRUNCATED = /^(.{56})_[0-9a-f]{6}$/;

const bracket = identifier => `[${identifier.replace(/]/g, ']]')}]`;

/** Rows of a raw query on knex's mssql client. */
const rowsOf = result => (Array.isArray(result) ? result : result?.recordset ?? []);

export const MSSQL_PLATFORMS = [
  {
    name: 'ods',
    label: 'ODS (SQL Server)',
    env: 'ODS_MSSQL',
    toRows: toOdsRows,
    lookupDescriptors: `select j.value as uri, d.DescriptorId as id
                          from openjson(?) j join edfi.Descriptor d on d.Namespace + '#' + d.CodeValue = j.value`,
    descriptorRow: async (uri, { alloc }) => {
      const { namespace, codeValue, type } = parseDescriptorUri(uri);
      const id = alloc();
      return {
        id,
        row: { table: 'edfi.descriptor', values: { descriptorid: id, namespace, codevalue: codeValue, shortdescription: codeValue, discriminator: `edfi.${type}` } }
      };
    },
    fixtureStudents: `select count(*) as n from edfi.Student where StudentUniqueId like 'FX-%'`
  },
  {
    name: 'dms',
    label: 'DMS (SQL Server)',
    env: 'DMS_MSSQL',
    toRows: toDmsRows,
    lookupDescriptors: `select j.value as uri, d.DescriptorId as id
                          from openjson(?) j join dms.Descriptor d on d.Namespace + '#' + d.CodeValue = j.value`,
    descriptorRow: async (uri, { alloc, trx }) => {
      const { namespace, codeValue, type } = parseDescriptorUri(uri);
      const rows = rowsOf(await trx.raw(
        `select ResourceKeyId as id from dms.ResourceKey where ProjectName = 'Ed-Fi' and ResourceName = ?`, [type]
      ));
      if (rows.length !== 1) throw new Error(`dms.ResourceKey has no Ed-Fi ${type}`);
      const id = alloc();
      return {
        id,
        row: {
          table: 'dms.Descriptor',
          values: { DescriptorId: id, DocumentId: alloc(), ResourceKeyId: rows[0].id, Namespace: namespace, CodeValue: codeValue, ShortDescription: codeValue }
        }
      };
    },
    fixtureStudents: `select count(*) as n from edfi.Student where StudentUniqueId like 'FX-%'`
  }
];

/** The dms-mssql name map for this data store's effective schema. */
export async function loadMssqlNameMap(trx) {
  const effective = rowsOf(await trx.raw('select EffectiveSchemaHash as hash from dms.EffectiveSchema'));
  if (effective.length !== 1) throw new Error('dms.EffectiveSchema has no single row');
  const { hash } = effective[0];
  const core = rowsOf(await trx.raw(
    `select ProjectVersion as version from dms.SchemaComponent where EffectiveSchemaHash = ? and ProjectName = 'Ed-Fi'`, [hash]
  ));
  if (core.length !== 1) throw new Error('dms.SchemaComponent lists no Ed-Fi project');
  const file = path.join(__dirname, '..', 'standard', core[0].version, 'artifacts', 'dms-mssql', nameMapFileName(hash));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Identity last values by table, as text. */
export async function readIdentities(trx) {
  const rows = rowsOf(await trx.raw(
    `select object_schema_name(object_id) + '.' + object_name(object_id) as name, cast(last_value as nvarchar(40)) as value
       from sys.identity_columns`
  ));
  return new Map(rows.map(row => [row.name, row.value]));
}

/** Sequence current values, as text. */
export async function readMssqlSequences(trx) {
  const rows = rowsOf(await trx.raw(
    `select schema_name(schema_id) + '.' + name as name, cast(current_value as nvarchar(40)) as value from sys.sequences`
  ));
  return new Map(rows.map(row => [row.name, row.value]));
}

/** A PostgreSQL-style timestamp with a Z suffix, read as UTC wall-clock time as PostgreSQL does. */
const toMssqlValue = value =>
  (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(value) ? value.slice(0, -1) : value);

export class MssqlLoader {
  constructor(trx, nameMap) {
    this.trx = trx;
    this.nameMap = nameMap;
    this.nextId = FIRST_ID;
    this.schemaTables = new Map();
    this.tables = new Map();
    this.prepared = new Set();
    this.descriptorIds = new Map();
    this.alloc = () => this.nextId++;
  }

  /** { schema, name } of the SQL Server table a fixture table name refers to. */
  async findTable(table) {
    const { schema, name } = resolveTable(table, this.nameMap);
    const key = schema.toLowerCase();
    if (!this.schemaTables.has(key)) {
      const rows = rowsOf(await this.trx.raw(
        `select s.name as [schema], t.name as name from sys.tables t join sys.schemas s on s.schema_id = t.schema_id where s.name = ?`, [schema]
      ));
      this.schemaTables.set(key, rows);
    }
    const tables = this.schemaTables.get(key);
    const exact = tables.filter(t => t.name.toLowerCase() === name.toLowerCase());
    if (exact.length === 1) return exact[0];
    const truncated = PG_TRUNCATED.exec(name);
    if (truncated) {
      const prefix = truncated[1].toLowerCase();
      const matches = tables.filter(t => t.name.length > 63 && t.name.toLowerCase().startsWith(prefix));
      if (matches.length === 1) return matches[0];
    }
    throw new Error(`No single SQL Server table for ${table}`);
  }

  /** Columns by lower-case name, with how each gets its value. */
  async tableColumns({ schema, name }) {
    const key = `${schema}.${name}`;
    if (!this.tables.has(key)) {
      const rows = rowsOf(await this.trx.raw(
        `select c.name, c.is_identity as [identity], c.is_computed as computed,
                case when d.definition like '%next value for%' then 1 else 0 end as sequence
           from sys.columns c left join sys.default_constraints d on d.object_id = c.default_object_id
          where c.object_id = object_id(?)`,
        [`${bracket(schema)}.${bracket(name)}`]
      ));
      this.tables.set(key, new Map(rows.map(row => [row.name.toLowerCase(), {
        name: row.name, identity: Boolean(row.identity), computed: Boolean(row.computed), sequence: Boolean(row.sequence)
      }])));
    }
    return this.tables.get(key);
  }

  /** Disable the table's foreign keys and triggers for the rest of the transaction. */
  async prepare({ schema, name }) {
    const key = `${schema}.${name}`;
    if (this.prepared.has(key)) return;
    const qualified = `${bracket(schema)}.${bracket(name)}`;
    const keys = rowsOf(await this.trx.raw(
      `select name from sys.foreign_keys where parent_object_id = object_id(?) and is_disabled = 0`, [qualified]
    ));
    if (keys.length) await this.trx.raw(`alter table ${qualified} nocheck constraint ${keys.map(k => bracket(k.name)).join(', ')}`);
    await this.trx.raw(`disable trigger all on ${qualified}`);
    this.prepared.add(key);
  }

  resolveValue(value) {
    if (value && typeof value === 'object' && '$descriptor' in value) {
      const id = this.descriptorIds.get(value.$descriptor);
      if (id === undefined) throw new Error(`Unresolved descriptor ${value.$descriptor}`);
      return id;
    }
    return toMssqlValue(value);
  }

  /** Insert one row: every column must exist and not be computed; identity and sequence columns get explicit ids. */
  async insert({ table, values }) {
    const target = await this.findTable(table);
    const columns = await this.tableColumns(target);
    if (columns.size === 0) throw new Error(`No table ${target.schema}.${target.name}`);
    const row = new Map();
    for (const [column, value] of Object.entries(values)) {
      const info = columns.get(column.toLowerCase());
      if (!info) throw new Error(`${target.schema}.${target.name} has no column ${column}`);
      if (info.computed) throw new Error(`${target.schema}.${target.name}.${info.name} is a computed column`);
      row.set(info.name, { info, value: this.resolveValue(value) });
    }
    for (const info of columns.values()) {
      if ((info.identity || info.sequence) && !row.has(info.name)) row.set(info.name, { info, value: this.alloc() });
    }
    await this.prepare(target);
    const qualified = `${bracket(target.schema)}.${bracket(target.name)}`;
    const names = [...row.keys()];
    const insert = `insert into ${qualified} (${names.map(bracket).join(', ')}) values (${names.map(() => '?').join(', ')})`;
    // A parameterized query runs in its own batch, so IDENTITY_INSERT goes in the same one
    const identity = [...row.values()].some(({ info }) => info.identity);
    await this.trx.raw(
      identity ? `set identity_insert ${qualified} on; ${insert}; set identity_insert ${qualified} off` : insert,
      names.map(column => row.get(column).value)
    );
  }

  /** Look up the fixture's descriptors; insert the ones this data store lacks. Returns the URIs added. */
  async resolveDescriptors(platform) {
    const uris = fixtureDescriptors(FIXTURE);
    for (const row of rowsOf(await this.trx.raw(platform.lookupDescriptors, [JSON.stringify(uris)]))) {
      this.descriptorIds.set(row.uri, row.id);
    }
    const added = uris.filter(uri => !this.descriptorIds.has(uri));
    for (const uri of added) {
      const { id, row } = await platform.descriptorRow(uri, { alloc: this.alloc, trx: this.trx });
      await this.insert(row);
      this.descriptorIds.set(uri, id);
    }
    return added;
  }
}
