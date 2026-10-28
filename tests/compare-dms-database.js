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
 * holding the same digits differ, because the API would serialize them differently). Ignored:
 * dateLastModified (load times differ) and the platform person keys (participantUSI/studentUSI on
 * the ODS, participantDocumentId/studentDocumentId on DMS). Arrays that hold the same elements in
 * another order are reported separately as order-only differences.
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
const PERSON_KEY_COLUMNS = new Set(['participantUSI', 'studentUSI', 'participantDocumentId', 'studentDocumentId']);
const IGNORED_COLUMNS = new Set(['dateLastModified', ...PERSON_KEY_COLUMNS]);
const DEFAULT_EXCLUDED_EDORGS = ['5', '6', '7'];

// int8 and numeric arrive as strings from node-postgres; the API sees exactly these values.
function parseArgs(argv) {
  const args = { views: VIEWS, excluded: DEFAULT_EXCLUDED_EDORGS, json: null, samples: 5 };
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

export function compareRows(odsRows, dmsRows, { excluded = [], samples = 5 } = {}) {
  const excludedSet = new Set(excluded.map(String));
  const kept = odsRows.filter(row => !excludedSet.has(String(row.educationOrganizationId)));
  const ods = new Map(kept.map(row => [row.sourcedId, row]));
  const dms = new Map(dmsRows.map(row => [row.sourcedId, row]));

  const odsColumns = Object.keys(odsRows[0] || {});
  const dmsColumns = Object.keys(dmsRows[0] || {});
  const columns = odsColumns.filter(column => dmsColumns.includes(column) && !IGNORED_COLUMNS.has(column));

  const result = {
    odsRows: odsRows.length,
    excludedRows: odsRows.length - kept.length,
    dmsRows: dmsRows.length,
    duplicateSourcedIds: { ods: kept.length - ods.size, dms: dmsRows.length - dms.size },
    columnsOnlyOds: odsColumns.filter(c => !dmsColumns.includes(c) && !IGNORED_COLUMNS.has(c)),
    columnsOnlyDms: dmsColumns.filter(c => !odsColumns.includes(c) && !IGNORED_COLUMNS.has(c)),
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

async function connect(connectionString) {
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
    for (const view of args.views) {
      const [odsRows, dmsRows, odsTypes, dmsTypes] = await Promise.all([
        ods.query(`select * from oneroster12.${view}`).then(r => r.rows),
        dms.query(`select * from oneroster12.${view}`).then(r => r.rows),
        columnTypes(ods, view),
        columnTypes(dms, view)
      ]);
      const result = compareRows(odsRows, dmsRows, args);
      result.typeDiffs = Object.keys(odsTypes)
        .filter(column => dmsTypes[column] && dmsTypes[column] !== odsTypes[column] && !PERSON_KEY_COLUMNS.has(column))
        .map(column => `${column}: ${odsTypes[column]} -> ${dmsTypes[column]}`);
      report.views[view] = result;

      const diffRows = result.matched - result.identical;
      unexplained += result.onlyOds.length + result.onlyDms.length + diffRows + result.typeDiffs.length;
      console.log(`\n${view}: ODS ${result.odsRows} (excluded ${result.excludedRows}), DMS ${result.dmsRows}; ` +
        `matched ${result.matched}, identical ${result.identical}, only ODS ${result.onlyOds.length}, only DMS ${result.onlyDms.length}`);
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
