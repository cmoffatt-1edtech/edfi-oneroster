#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Database-level parity: compare every oneroster12 projection on an ODS (PostgreSQL) with the same
 * projection on a DMS data store loaded with the same data.
 *
 * Rows are matched on sourcedId and compared column by column, strictly (a number and a string
 * holding the same digits differ, because the API would serialize them differently). Values not
 * compared: dateLastModified (load times differ) and the platform person keys (participantUSI/
 * studentUSI on the ODS, participantDocumentId/studentDocumentId on DMS). Arrays that hold the same
 * elements in another order are reported separately as order-only differences.
 *
 * The schemas are compared from the catalog, so an empty view is still checked: a column on one
 * side only, or with another type, is a difference. Only the person keys are left out of that
 * check, since each platform has its own; dateLastModified must exist on both sides. A sourcedId
 * that appears more than once on either side is also a difference, which matching by sourcedId
 * would otherwise hide.
 *
 * ODS rows of excluded education organizations (default 5,6,7: the TPDM sample schools the ODS
 * sandbox carries and the DMS Populated template does not) are dropped before comparing.
 *
 * Usage:
 *   ODS_PG="host=...;port=5432;username=...;password=...;database=EdFi_Ods" \
 *   DMS_PG="host=...;port=5432;username=...;password=...;database=edfi_datamanagementservice" \
 *   node tests/compare-dms-database.js [--views orgs,users] [--exclude-edorgs 5,6,7] [--json out.json] [--samples 5]
 * tests/compare-dms-database.sh runs it in a container on both local stacks' Docker networks.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { parseConnectionString } from '../src/config/multi-tenancy-config.js';
import { buildPostgresClientOptions } from '../src/config/db-connection.js';

const VIEWS = ['orgs', 'academicsessions', 'courses', 'classes', 'users', 'enrollments', 'demographics'];
// Assessment rostering (Data Standard 5.2 and later): compared when both data stores have them,
// skipped when neither does, a difference when only one does
const OPTIONAL_VIEWS = ['assessments', 'assessmentofferings', 'assessmentenrollments', 'assessmentauthorgs'];
export const PERSON_KEY_COLUMNS = new Set(['participantUSI', 'studentUSI', 'participantDocumentId', 'studentDocumentId']);
const IGNORED_COLUMNS = new Set(['dateLastModified', ...PERSON_KEY_COLUMNS]);
const DEFAULT_EXCLUDED_EDORGS = ['5', '6', '7'];

// int8 and numeric arrive as strings from node-postgres; the API sees exactly these values.
function parseArgs(argv) {
  const args = { views: [...VIEWS, ...OPTIONAL_VIEWS], excluded: DEFAULT_EXCLUDED_EDORGS, json: null, samples: 5 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--views': args.views = argv[++i].split(',').map(v => v.trim()).filter(Boolean); break;
      case '--exclude-edorgs': args.excluded = argv[++i].split(',').map(v => v.trim()).filter(Boolean); break;
      case '--json': args.json = argv[++i]; break;
      case '--samples': args.samples = Number(argv[++i]); break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

/** JSON text with object keys sorted, so key order never counts as a difference. */
export function canonical(value, { sortArrays = false } = {}) {
  const walk = v => {
    if (Array.isArray(v)) {
      const items = v.map(walk);
      return sortArrays ? items.map(item => JSON.stringify(item)).sort().map(text => JSON.parse(text)) : items;
    }
    if (v instanceof Date) return { $date: v.toISOString() };
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map(key => [key, walk(v[key])]));
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

/** Compare one value; returns null when equal, 'order' when only array order differs, else 'value'. */
export function compareValues(odsValue, dmsValue) {
  if (canonical(odsValue) === canonical(dmsValue)) return null;
  if (canonical(odsValue, { sortArrays: true }) === canonical(dmsValue, { sortArrays: true })) return 'order';
  return 'value';
}

/** sourcedIds that appear more than once. */
function duplicateIds(rows) {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows) {
    (seen.has(row.sourcedId) ? duplicates : seen).add(row.sourcedId);
  }
  return [...duplicates];
}

/** Every column name in the rows (not only the first row's), for callers without the catalog. */
function rowColumns(rows) {
  return [...new Set(rows.flatMap(row => Object.keys(row)))];
}

/**
 * @param {Object} [options]
 * @param {{ods: string[], dms: string[]}} [options.columns] - Column names from the catalog. Without
 *   them the columns found in the rows are used, which says nothing about an empty view.
 * @param {Set<string>} [options.ignored] - Columns whose values are not compared; dateLastModified
 *   and the person keys by default.
 * @param {Set<string>} [options.schemaIgnored] - Columns that may exist on one side only; the person
 *   keys by default.
 */
export function compareRows(odsRows, dmsRows, {
  excluded = [], samples = 5, columns: catalogColumns = null, ignored = IGNORED_COLUMNS, schemaIgnored = PERSON_KEY_COLUMNS
} = {}) {
  const excludedSet = new Set(excluded.map(String));
  const kept = odsRows.filter(row => !excludedSet.has(String(row.educationOrganizationId)));
  const ods = new Map(kept.map(row => [row.sourcedId, row]));
  const dms = new Map(dmsRows.map(row => [row.sourcedId, row]));

  const odsColumns = catalogColumns?.ods ?? rowColumns(odsRows);
  const dmsColumns = catalogColumns?.dms ?? rowColumns(dmsRows);
  const columns = odsColumns.filter(column => dmsColumns.includes(column) && !ignored.has(column));
  const duplicates = { ods: duplicateIds(kept), dms: duplicateIds(dmsRows) };

  const result = {
    odsRows: odsRows.length,
    excludedRows: odsRows.length - kept.length,
    dmsRows: dmsRows.length,
    duplicateSourcedIds: { ods: kept.length - ods.size, dms: dmsRows.length - dms.size },
    duplicateIds: { ods: duplicates.ods.slice(0, samples), dms: duplicates.dms.slice(0, samples) },
    columnsOnlyOds: odsColumns.filter(c => !dmsColumns.includes(c) && !schemaIgnored.has(c)),
    columnsOnlyDms: dmsColumns.filter(c => !odsColumns.includes(c) && !schemaIgnored.has(c)),
    onlyOds: [...ods.keys()].filter(id => !dms.has(id)),
    onlyDms: [...dms.keys()].filter(id => !ods.has(id)),
    matched: 0,
    identical: 0,
    columnDiffs: {},
    orderOnly: {},
    samples: {}
  };

  for (const [id, odsRow] of ods) {
    const dmsRow = dms.get(id);
    if (!dmsRow) continue;
    result.matched++;
    let same = true;
    for (const column of columns) {
      const kind = compareValues(odsRow[column], dmsRow[column]);
      if (!kind) continue;
      const bucket = kind === 'order' ? result.orderOnly : result.columnDiffs;
      bucket[column] = (bucket[column] || 0) + 1;
      if (kind === 'value') {
        same = false;
        result.samples[column] ??= [];
        if (result.samples[column].length < samples) {
          result.samples[column].push({ sourcedId: id, ods: odsRow[column], dms: dmsRow[column] });
        }
      }
    }
    if (same) result.identical++;
  }

  return result;
}

/**
 * Differences in one view's result that fail the run: rows on one side only, rows that differ,
 * repeated sourcedIds, columns on one side only and column type differences. Order-only array
 * differences are reported but don't count.
 */
export function unexplainedCount(result) {
  return result.onlyOds.length + result.onlyDms.length + (result.matched - result.identical) +
    result.duplicateSourcedIds.ods + result.duplicateSourcedIds.dms +
    result.columnsOnlyOds.length + result.columnsOnlyDms.length + (result.typeDiffs?.length || 0);
}

export async function connect(connectionString) {
  const client = new pg.Client(buildPostgresClientOptions(parseConnectionString(connectionString, 'postgres')));
  await client.connect();
  return client;
}

async function columnTypes(client, view) {
  const { rows } = await client.query(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type
       from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'oneroster12' and c.relname = $1 and a.attnum > 0 and not a.attisdropped`,
    [view]
  );
  return Object.fromEntries(rows.map(row => [row.name, row.type]));
}

function truncate(value) {
  const text = JSON.stringify(value);
  return text && text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.ODS_PG || !process.env.DMS_PG) throw new Error('Set ODS_PG and DMS_PG');

  const ods = await connect(process.env.ODS_PG);
  const dms = await connect(process.env.DMS_PG);
  const report = { excludedEducationOrganizations: args.excluded, views: {} };
  let unexplained = 0;

  try {
    const exists = (client, view) => client.query('select to_regclass($1) is not null as present', [`oneroster12.${view}`]).then(r => r.rows[0].present);
    for (const view of args.views) {
      if (OPTIONAL_VIEWS.includes(view)) {
        const [onOds, onDms] = await Promise.all([exists(ods, view), exists(dms, view)]);
        if (!onOds && !onDms) {
          console.log(`\n${view}: on neither data store, skipped`);
          continue;
        }
        if (onOds !== onDms) {
          console.log(`\n${view}: only on ${onOds ? 'the ODS' : 'DMS'}`);
          report.views[view] = { onlyOn: onOds ? 'ods' : 'dms' };
          unexplained++;
          continue;
        }
      }
      const [odsRows, dmsRows, odsTypes, dmsTypes] = await Promise.all([
        ods.query(`select * from oneroster12.${view}`).then(r => r.rows),
        dms.query(`select * from oneroster12.${view}`).then(r => r.rows),
        columnTypes(ods, view),
        columnTypes(dms, view)
      ]);
      const result = compareRows(odsRows, dmsRows, {
        ...args,
        columns: { ods: Object.keys(odsTypes), dms: Object.keys(dmsTypes) }
      });
      result.typeDiffs = Object.keys(odsTypes)
        .filter(column => dmsTypes[column] && dmsTypes[column] !== odsTypes[column] && !PERSON_KEY_COLUMNS.has(column))
        .map(column => `${column}: ${odsTypes[column]} -> ${dmsTypes[column]}`);
      report.views[view] = result;

      unexplained += unexplainedCount(result);
      console.log(`\n${view}: ODS ${result.odsRows} (excluded ${result.excludedRows}), DMS ${result.dmsRows}; ` +
        `matched ${result.matched}, identical ${result.identical}, only ODS ${result.onlyOds.length}, only DMS ${result.onlyDms.length}`);
      if (result.duplicateSourcedIds.ods || result.duplicateSourcedIds.dms) {
        console.log(`  duplicate sourcedIds: ODS ${result.duplicateSourcedIds.ods}, DMS ${result.duplicateSourcedIds.dms}`);
        for (const id of [...result.duplicateIds.ods, ...result.duplicateIds.dms]) console.log(`    ${id}`);
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
  } finally {
    await ods.end();
    await dms.end();
  }

  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${unexplained === 0 ? 'PARITY' : 'DIFFERENCES'}: ${unexplained} row/type difference(s) across ${args.views.length} view(s)`);
  process.exitCode = unexplained === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`compare-dms-database: ${error.message}`);
    process.exit(2);
  });
}
