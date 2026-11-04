#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Synthetic-data parity: load tests/dms-parity-fixture.js into an ODS and into a DMS data store, run
 * every oneroster12 projection's definition on each, and compare the rows the fixture adds. Nothing is
 * kept: each database gets one REPEATABLE READ transaction, which is rolled back.
 *
 * In that transaction, on each side:
 *   1. session_replication_role = replica, so triggers and foreign keys don't fire. The fixture fills
 *      only the tables the projections read, and ODS change tracking and the DMS referential-identity
 *      tables are left alone. Check, unique and not-null constraints still apply.
 *   2. Each projection's definition (pg_get_viewdef of the materialized view) runs before the load and
 *      after it. The materialized views are not refreshed, so readers of oneroster12 never wait.
 *   3. The rows the load adds are the fixture's rows. A row the load changes or removes means the
 *      fixture reached existing data, which fails the run.
 * Ids and columns with a sequence default get explicit values, so no sequence advances; the run
 * compares pg_sequences before and after.
 *
 * The ODS rows and the DMS rows are then compared as tests/compare-dms-database.js does, except that
 * dateLastModified is compared too (the fixture sets both platforms' timestamps), and both sides are
 * checked against the fixture's EXPECTATIONS.
 *
 * Usage:
 *   ODS_PG="host=...;port=5432;username=...;password=...;database=EdFi_Ods" \
 *   DMS_PG="host=...;port=5432;username=...;password=...;database=edfi_datamanagementservice" \
 *   node tests/compare-dms-fixture.js [--json out.json] [--samples 5] [--platforms ods]
 * The logins must be allowed to set session_replication_role (superuser). tests/compare-dms-fixture.sh
 * runs it in a container on both local stacks' Docker networks. --platforms ods (or dms) loads and
 * checks one platform against EXPECTATIONS without the comparison, for projections only one platform
 * has yet.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { canonical, compareRows, compareValues, connect, unexplainedCount, PERSON_KEY_COLUMNS } from './compare-dms-database.js';
import { nameMapFileName } from '../standard/dms/build-name-map.js';
import {
  EXPECTATIONS, EXPECTED_COUNTS, FIXTURE, fixtureDescriptors, md5, parseDescriptorUri, toDmsRows, toOdsRows
} from './dms-parity-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Explicit ids and sequence-column values start far above anything a sample database holds.
const FIRST_ID = 2_000_000_000;
const TIMESTAMP_WITHOUT_TIME_ZONE = 1114;

export const PLATFORMS = [
  {
    name: 'ods',
    label: 'ODS',
    env: 'ODS_PG',
    toRows: toOdsRows,
    lookupDescriptors: `select namespace || '#' || codevalue as uri, descriptorid as id
                          from edfi.descriptor where namespace || '#' || codevalue = any($1)`,
    descriptorRow: async (uri, { alloc }) => {
      const { namespace, codeValue, type } = parseDescriptorUri(uri);
      const id = alloc();
      return {
        id,
        row: { table: 'edfi.descriptor', values: { descriptorid: id, namespace, codevalue: codeValue, shortdescription: codeValue, discriminator: `edfi.${type}` } }
      };
    },
    fixtureStudents: `select count(*)::int as n from edfi.student where studentuniqueid like 'FX-%'`
  },
  {
    name: 'dms',
    label: 'DMS',
    env: 'DMS_PG',
    toRows: toDmsRows,
    lookupDescriptors: `select "Namespace" || '#' || "CodeValue" as uri, "DescriptorId" as id
                          from dms."Descriptor" where "Namespace" || '#' || "CodeValue" = any($1)`,
    descriptorRow: async (uri, { alloc, client }) => {
      const { namespace, codeValue, type } = parseDescriptorUri(uri);
      const { rows } = await client.query(
        `select "ResourceKeyId" as id from dms."ResourceKey" where "ProjectName" = 'Ed-Fi' and "ResourceName" = $1`,
        [type]
      );
      if (rows.length !== 1) throw new Error(`dms."ResourceKey" has no Ed-Fi ${type}`);
      const id = alloc();
      return {
        id,
        row: {
          table: 'dms.Descriptor',
          values: { DescriptorId: id, DocumentId: alloc(), ResourceKeyId: rows[0].id, Namespace: namespace, CodeValue: codeValue, ShortDescription: codeValue }
        }
      };
    },
    fixtureStudents: `select count(*)::int as n from edfi."Student" where "StudentUniqueId" like 'FX-%'`
  }
];

function parseArgs(argv) {
  const args = { json: null, samples: 5, platforms: PLATFORMS.map(platform => platform.name) };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--json': args.json = argv[++i]; break;
      case '--samples': args.samples = Number(argv[++i]); break;
      case '--platforms': {
        args.platforms = argv[++i].split(',').map(name => name.trim()).filter(Boolean);
        const unknown = args.platforms.filter(name => !PLATFORMS.some(platform => platform.name === name));
        if (unknown.length || args.platforms.length === 0) throw new Error(`--platforms takes ods, dms or both`);
        break;
      }
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

const quote = identifier => `"${identifier.replace(/"/g, '""')}"`;

/** { schema, name } of 'schema.Name' or of a {{table:...}} placeholder, through the DMS name map. */
export function resolveTable(table, nameMap) {
  const placeholder = /^\{\{table:(.+)\}\}$/.exec(table);
  if (placeholder) {
    const entry = nameMap?.tables?.[placeholder[1]];
    if (!entry) throw new Error(`No name-map entry for ${table}`);
    return { schema: entry.schema, name: entry.name };
  }
  const dot = table.indexOf('.');
  return { schema: table.slice(0, dot), name: table.slice(dot + 1) };
}

/**
 * The rows a load added to one projection, and how many rows it changed or removed. Rows are matched
 * as whole values; array order is ignored, since json_agg without ORDER BY may differ between runs.
 */
export function fixtureRows(beforeRows, afterRows) {
  const remaining = new Map();
  for (const row of beforeRows) {
    const key = canonical(row, { sortArrays: true });
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  const added = [];
  for (const row of afterRows) {
    const key = canonical(row, { sortArrays: true });
    const count = remaining.get(key) || 0;
    if (count > 0) remaining.set(key, count - 1);
    else added.push(row);
  }
  return { added, removed: [...remaining.values()].reduce((sum, count) => sum + count, 0) };
}

/** Failures of EXPECTED_COUNTS and EXPECTATIONS against one platform's fixture rows. */
export function checkExpectations(addedByView, expectations = EXPECTATIONS, counts = EXPECTED_COUNTS) {
  const failures = [];
  for (const [view, count] of Object.entries(counts)) {
    const actual = addedByView[view]?.length ?? 0;
    if (actual !== count) failures.push(`${view}: ${actual} fixture rows, expected ${count}`);
  }
  for (const expectation of expectations) {
    const label = `${expectation.view} ${expectation.key ?? expectation.id}`;
    const sourcedId = expectation.id ?? md5(expectation.key);
    const row = (addedByView[expectation.view] ?? []).find(candidate => candidate.sourcedId === sourcedId);
    if (expectation.absent) {
      if (row) failures.push(`${label}: present, expected no row`);
      continue;
    }
    if (!row) {
      failures.push(`${label}: no row`);
      continue;
    }
    for (const [column, expected] of Object.entries(expectation.values)) {
      const kind = compareValues(row[column], expected);
      if (kind === null || (kind === 'order' && expectation.unordered?.includes(column))) continue;
      failures.push(`${label} ${column}: ${JSON.stringify(row[column])}, expected ${JSON.stringify(expected)}`);
    }
  }
  return { checked: Object.keys(counts).length + expectations.length, failures };
}

/** Sequences whose last_value differs. */
export function changedSequences(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter(name => before.get(name) !== after.get(name)).sort();
}

export async function readSequences(client) {
  const { rows } = await client.query(`select schemaname || '.' || sequencename as name, last_value::text as value from pg_sequences`);
  return new Map(rows.map(row => [row.name, row.value]));
}

export async function readDefinitions(client) {
  const { rows } = await client.query(
    `select c.relname as view, pg_get_viewdef(c.oid, true) as sql
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'oneroster12' and c.relkind = 'm'
      order by c.relname`
  );
  if (rows.length === 0) throw new Error('No oneroster12 materialized views: deploy the projections first');
  return Object.fromEntries(rows.map(row => [row.view, row.sql]));
}

async function runDefinitions(client, definitions) {
  const results = {};
  for (const [view, sql] of Object.entries(definitions)) {
    const { rows, fields } = await client.query(sql);
    results[view] = { rows, fields };
  }
  return results;
}

async function typeNames(client, fieldsByView) {
  const oids = [...new Set(Object.values(fieldsByView).flatMap(fields => fields.map(field => field.dataTypeID)))];
  const { rows } = await client.query('select oid::int as oid, format_type(oid, null) as name from pg_type where oid = any($1)', [oids]);
  const names = new Map(rows.map(row => [row.oid, row.name]));
  return Object.fromEntries(Object.entries(fieldsByView).map(([view, fields]) =>
    [view, Object.fromEntries(fields.map(field => [field.name, names.get(field.dataTypeID)]))]
  ));
}

export async function loadNameMap(client) {
  const effective = await client.query('select "EffectiveSchemaHash" as hash from dms."EffectiveSchema"');
  if (effective.rows.length !== 1) throw new Error('dms."EffectiveSchema" has no single row');
  const { hash } = effective.rows[0];
  const core = await client.query(
    `select "ProjectVersion" as version from dms."SchemaComponent" where "EffectiveSchemaHash" = $1 and "ProjectName" = 'Ed-Fi'`,
    [hash]
  );
  if (core.rows.length !== 1) throw new Error('dms."SchemaComponent" lists no Ed-Fi project');
  const file = path.join(__dirname, '..', 'standard', core.rows[0].version, 'artifacts', 'dms-pgsql', nameMapFileName(hash));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export class Loader {
  constructor(client, nameMap) {
    this.client = client;
    this.nameMap = nameMap;
    this.nextId = FIRST_ID;
    this.columns = new Map();
    this.descriptorIds = new Map();
    this.alloc = () => this.nextId++;
  }

  async tableColumns(schema, name) {
    const key = `${schema}.${name}`;
    if (!this.columns.has(key)) {
      const { rows } = await this.client.query(
        `select a.attname as name, a.attgenerated <> '' as generated, a.attidentity as identity,
                coalesce(pg_get_expr(d.adbin, d.adrelid), '') like 'nextval(%' as sequence
           from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
          where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped`,
        [`${quote(schema)}.${quote(name)}`]
      );
      this.columns.set(key, new Map(rows.map(row => [row.name, row])));
    }
    return this.columns.get(key);
  }

  resolveValue(value) {
    if (value && typeof value === 'object' && '$descriptor' in value) {
      const id = this.descriptorIds.get(value.$descriptor);
      if (id === undefined) throw new Error(`Unresolved descriptor ${value.$descriptor}`);
      return id;
    }
    return value;
  }

  /** Insert one row: every column must exist and not be generated; sequence columns get explicit ids. */
  async insert({ table, values }) {
    const { schema, name } = resolveTable(table, this.nameMap);
    const columns = await this.tableColumns(schema, name);
    if (columns.size === 0) throw new Error(`No table ${schema}.${name}`);
    const row = {};
    for (const [column, value] of Object.entries(values)) {
      const info = columns.get(column);
      if (!info) throw new Error(`${schema}.${name} has no column ${column}`);
      if (info.generated) throw new Error(`${schema}.${name}.${column} is a generated column`);
      row[column] = this.resolveValue(value);
    }
    for (const [column, info] of columns) {
      if ((info.sequence || info.identity) && !(column in row)) row[column] = this.alloc();
    }
    const names = Object.keys(row);
    const overriding = names.some(column => columns.get(column).identity === 'a') ? ' overriding system value' : '';
    await this.client.query(
      `insert into ${quote(schema)}.${quote(name)} (${names.map(quote).join(', ')})${overriding} values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
      names.map(column => row[column])
    );
  }

  /** Look up the fixture's descriptors; insert the ones this data store lacks. Returns the URIs added. */
  async resolveDescriptors(platform) {
    const uris = fixtureDescriptors(FIXTURE);
    const { rows } = await this.client.query(platform.lookupDescriptors, [uris]);
    for (const row of rows) this.descriptorIds.set(row.uri, row.id);
    const added = uris.filter(uri => !this.descriptorIds.has(uri));
    for (const uri of added) {
      const { id, row } = await platform.descriptorRow(uri, { alloc: this.alloc, client: this.client });
      await this.insert(row);
      this.descriptorIds.set(uri, id);
    }
    return added;
  }
}

async function runPlatform(platform, connectionString) {
  const client = await connect(connectionString);
  try {
    const nameMap = platform.name === 'dms' ? await loadNameMap(client) : null;
    const sequencesBefore = await readSequences(client);
    const result = { added: {}, removed: {}, types: {}, descriptorsAdded: [], rowsLoaded: 0 };

    await client.query('begin isolation level repeatable read');
    try {
      await client.query('set local session_replication_role = replica');
      await client.query(`set local lock_timeout = '5s'`);
      await client.query(`set local statement_timeout = '120s'`);
      const definitions = await readDefinitions(client);
      const before = await runDefinitions(client, definitions);

      const loader = new Loader(client, nameMap);
      result.descriptorsAdded = await loader.resolveDescriptors(platform);
      const rows = platform.toRows(FIXTURE, loader.alloc);
      for (const row of rows) await loader.insert(row);
      result.rowsLoaded = rows.length;

      const after = await runDefinitions(client, definitions);
      for (const view of Object.keys(definitions)) {
        const delta = fixtureRows(before[view].rows, after[view].rows);
        result.added[view] = delta.added;
        result.removed[view] = delta.removed;
      }
      result.types = await typeNames(client, Object.fromEntries(Object.entries(after).map(([view, { fields }]) => [view, fields])));
    } finally {
      await client.query('rollback').catch(() => {});
    }

    result.sequencesChanged = changedSequences(sequencesBefore, await readSequences(client));
    result.fixtureStudentsAfterRollback = (await client.query(platform.fixtureStudents)).rows[0].n;
    return result;
  } finally {
    await client.end();
  }
}

function truncate(value) {
  const text = JSON.stringify(value);
  return text && text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Both platforms project timestamps as timestamp without time zone in UTC: read them as UTC.
  pg.types.setTypeParser(TIMESTAMP_WITHOUT_TIME_ZONE, text => new Date(`${text.replace(' ', 'T')}Z`));

  const platforms = PLATFORMS.filter(platform => args.platforms.includes(platform.name));
  const results = {};
  for (const platform of platforms) {
    if (!process.env[platform.env]) throw new Error(`Set ${platform.env}`);
    results[platform.name] = await runPlatform(platform, process.env[platform.env]);
  }

  let failures = 0;
  const report = { platforms: {}, views: {}, expectations: {} };
  for (const platform of platforms) {
    const result = results[platform.name];
    const removed = Object.values(result.removed).reduce((sum, n) => sum + n, 0);
    failures += removed + result.sequencesChanged.length + result.fixtureStudentsAfterRollback;
    report.platforms[platform.name] = {
      rowsLoaded: result.rowsLoaded, descriptorsAdded: result.descriptorsAdded, rowsChangedOutsideFixture: result.removed,
      sequencesChanged: result.sequencesChanged, fixtureStudentsAfterRollback: result.fixtureStudentsAfterRollback
    };
    console.log(`${platform.label}: loaded ${result.rowsLoaded} rows and ${result.descriptorsAdded.length} descriptor(s), then rolled back`);
    for (const uri of result.descriptorsAdded) console.log(`  descriptor added for the run: ${uri}`);
    console.log(`  existing projection rows changed by the load: ${removed}`);
    console.log(`  sequences changed: ${result.sequencesChanged.length ? result.sequencesChanged.join(', ') : 'none'}`);
    console.log(`  fixture students left after rollback: ${result.fixtureStudentsAfterRollback}`);
  }

  const ignored = new Set(PERSON_KEY_COLUMNS);
  const compared = platforms.length === PLATFORMS.length;
  const views = compared ? [...new Set([...Object.keys(results.ods.added), ...Object.keys(results.dms.added)])].sort() : [];
  if (!compared) console.log(`\n${platforms[0].label} only: no ODS/DMS comparison`);
  for (const view of views) {
    const odsRows = results.ods.added[view] ?? [];
    const dmsRows = results.dms.added[view] ?? [];
    const odsTypes = results.ods.types[view] ?? {};
    const dmsTypes = results.dms.types[view] ?? {};
    const result = compareRows(odsRows, dmsRows, {
      samples: args.samples, ignored, columns: { ods: Object.keys(odsTypes), dms: Object.keys(dmsTypes) }
    });
    result.typeDiffs = Object.keys(odsTypes)
      .filter(column => dmsTypes[column] && dmsTypes[column] !== odsTypes[column] && !ignored.has(column))
      .map(column => `${column}: ${odsTypes[column]} -> ${dmsTypes[column]}`);
    report.views[view] = result;
    failures += unexplainedCount(result);

    console.log(`\n${view}: fixture rows ODS ${result.odsRows}, DMS ${result.dmsRows}; matched ${result.matched}, identical ${result.identical}, ` +
      `only ODS ${result.onlyOds.length}, only DMS ${result.onlyDms.length}`);
    if (result.duplicateSourcedIds.ods || result.duplicateSourcedIds.dms) {
      console.log(`  duplicate sourcedIds: ODS ${result.duplicateSourcedIds.ods}, DMS ${result.duplicateSourcedIds.dms}`);
    }
    if (result.columnsOnlyOds.length) console.log(`  columns only on ODS: ${result.columnsOnlyOds.join(', ')}`);
    if (result.columnsOnlyDms.length) console.log(`  columns only on DMS: ${result.columnsOnlyDms.join(', ')}`);
    for (const diff of result.typeDiffs) console.log(`  type differs: ${diff}`);
    for (const [column, n] of Object.entries(result.orderOnly)) console.log(`  order-only ${column}: ${n}`);
    for (const [column, n] of Object.entries(result.columnDiffs)) {
      console.log(`  differs ${column}: ${n}`);
      for (const sample of result.samples[column]) {
        console.log(`    ${sample.sourcedId}\n      ods ${truncate(sample.ods)}\n      dms ${truncate(sample.dms)}`);
      }
    }
    for (const id of result.onlyOds.slice(0, args.samples)) console.log(`  only ODS: ${id}`);
    for (const id of result.onlyDms.slice(0, args.samples)) console.log(`  only DMS: ${id}`);
  }

  console.log('');
  for (const platform of platforms) {
    const { checked, failures: failed } = checkExpectations(results[platform.name].added);
    report.expectations[platform.name] = { checked, failures: failed };
    failures += failed.length;
    console.log(`expectations on ${platform.label}: ${checked - failed.length}/${checked} met`);
    for (const failure of failed) console.log(`  ${failure}`);
  }

  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  const scope = compared ? `across ${views.length} view(s)` : `on ${platforms[0].label} only`;
  console.log(`\n${failures === 0 ? 'FIXTURE PARITY' : 'DIFFERENCES'}: ${failures} problem(s) ${scope}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`compare-dms-fixture: ${error.message}`);
    process.exit(2);
  });
}
