#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Cross-engine parity: compare every oneroster12 projection on a DMS SQL Server data store (tables
 * filled by sp_refresh_*) with the same projection on a DMS PostgreSQL data store (materialized
 * views) loaded with the same data and the same data standard.
 *
 * The two drivers return the same value in different shapes, so values are normalized before the
 * comparison of tests/compare-dms-database.js: numbers and booleans become strings (node-postgres
 * returns int8 as a string, tedious int as a number), SQL Server JSON text is parsed, a date column
 * becomes YYYY-MM-DD and a timestamp an ISO string. Not compared: dateLastModified values (load
 * times differ) and the person keys (each data store generates its own DocumentIds); every column
 * must still exist on both sides. Array order differences are reported but don't fail, as in the
 * ODS comparison; the API comparison (compare-api.js dms-vs-recording) checks the order the API
 * returns. Column types aren't compared, since the engines have different type systems.
 *
 * The local DMS stacks run one engine at a time, so the PostgreSQL side can be saved first and
 * compared later:
 *   DMS_PG="host=localhost;port=5435;username=postgres;password=...;database=edfi_datamanagementservice" \
 *     node tests/compare-dms-engines.js --save-pg tests/.dms-compare/pg-ds52
 *   DMS_MSSQL="Server=localhost,1435;Database=edfi_datamanagementservice;User Id=sa;Password=...;TrustServerCertificate=true" \
 *     node tests/compare-dms-engines.js --pg-snapshot tests/.dms-compare/pg-ds52
 * Or both live: set DMS_PG and DMS_MSSQL and pass neither option.
 * Options: --views orgs,users  --samples 5  --json out.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import sql from 'mssql';
import { parseConnectionString } from '../src/config/multi-tenancy-config.js';
import { buildPostgresClientOptions } from '../src/config/db-connection.js';
import { buildMssqlTlsOptions } from '../src/config/mssql-tls.js';
import { compareRows, unexplainedCount } from './compare-dms-database.js';

const VIEWS = ['orgs', 'academicsessions', 'courses', 'classes', 'users', 'enrollments', 'demographics'];
const PG_DATE_OID = 1082;
const PG_TIMESTAMP_OID = 1114;

// node-postgres reads a date as local midnight and a timestamp without time zone as local time;
// tedious reads both as UTC. Read the date as written and the timestamp as UTC, as SQL Server does.
const PG_TYPE_PARSERS = {
  [PG_DATE_OID]: value => value,
  [PG_TIMESTAMP_OID]: value => new Date(`${value.replace(' ', 'T')}Z`)
};

function parseArgs(argv) {
  const args = { views: VIEWS, samples: 5, json: null, savePg: null, pgSnapshot: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--views': args.views = argv[++i].split(',').map(v => v.trim()).filter(Boolean); break;
      case '--samples': args.samples = Number(argv[++i]); break;
      case '--json': args.json = argv[++i]; break;
      case '--save-pg': args.savePg = argv[++i]; break;
      case '--pg-snapshot': args.pgSnapshot = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

const looksJson = value => /^\s*[[{]/.test(value) && /[\]}]\s*$/.test(value);

/**
 * One value in an engine-neutral shape.
 * @param {*} value
 * @param {boolean} [isDate] - The column is a date (no time of day)
 */
export function normalizeValue(value, isDate = false) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return isDate ? value.toISOString().slice(0, 10) : value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string' && looksJson(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** @param {Set<string>} [dateColumns] */
export function normalizeRow(row, dateColumns = new Set()) {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, normalizeValue(value, dateColumns.has(column))]));
}

/**
 * Compare one projection; each side is { columns, rows } with normalized rows. Every column must
 * exist on both sides.
 */
export function compareEngines(pgSide, mssqlSide, { samples = 5 } = {}) {
  return compareRows(pgSide.rows, mssqlSide.rows, {
    samples, columns: { ods: pgSide.columns, dms: mssqlSide.columns }, schemaIgnored: new Set()
  });
}

async function readPostgres(connection, views) {
  const client = new pg.Client({
    ...buildPostgresClientOptions(parseConnectionString(connection, 'postgres')),
    types: { getTypeParser: (oid, format) => PG_TYPE_PARSERS[oid] || pg.types.getTypeParser(oid, format) }
  });
  await client.connect();
  try {
    const result = {};
    for (const view of views) {
      const { rows: columns } = await client.query(
        `select a.attname as name from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'oneroster12' and c.relname = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [view]);
      const { rows } = await client.query(`select * from oneroster12.${view}`);
      result[view] = { columns: columns.map(c => c.name), rows: rows.map(row => normalizeRow(row)) };
    }
    return result;
  } finally {
    await client.end();
  }
}

async function readMssql(connection, views) {
  const config = parseConnectionString(connection, 'mssql');
  const pool = await new sql.ConnectionPool({
    server: config.server, port: config.port, database: config.database, user: config.user, password: config.password,
    options: { ...buildMssqlTlsOptions(config), enableArithAbort: true }, requestTimeout: 0
  }).connect();
  try {
    const result = {};
    for (const view of views) {
      const { recordset: columns } = await pool.request().input('view', sql.NVarChar, view).query(
        `select c.name from sys.columns c join sys.objects o on o.object_id = c.object_id join sys.schemas s on s.schema_id = o.schema_id
          where s.name = 'oneroster12' and o.name = @view order by c.column_id`);
      const { recordset } = await pool.request().query(`select * from oneroster12.[${view}]`);
      const dateColumns = new Set(Object.values(recordset.columns || {}).filter(c => c.type === sql.Date).map(c => c.name));
      result[view] = { columns: columns.map(c => c.name), rows: recordset.map(row => normalizeRow(row, dateColumns)) };
    }
    return result;
  } finally {
    await pool.close();
  }
}

function readSnapshot(dir, views) {
  return Object.fromEntries(views.map(view => [view, JSON.parse(fs.readFileSync(path.join(dir, `${view}.json`), 'utf8'))]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.savePg) {
    if (!process.env.DMS_PG) throw new Error('Set DMS_PG');
    fs.mkdirSync(args.savePg, { recursive: true });
    for (const [view, side] of Object.entries(await readPostgres(process.env.DMS_PG, args.views))) {
      fs.writeFileSync(path.join(args.savePg, `${view}.json`), `${JSON.stringify(side)}\n`);
      console.log(`${view}: ${side.rows.length} rows saved`);
    }
    return;
  }

  if (!process.env.DMS_MSSQL) throw new Error('Set DMS_MSSQL');
  if (!args.pgSnapshot && !process.env.DMS_PG) throw new Error('Set DMS_PG, or pass --pg-snapshot');
  const [pgViews, mssqlViews] = await Promise.all([
    args.pgSnapshot ? readSnapshot(args.pgSnapshot, args.views) : readPostgres(process.env.DMS_PG, args.views),
    readMssql(process.env.DMS_MSSQL, args.views)
  ]);

  const report = { views: {} };
  let unexplained = 0;
  for (const view of args.views) {
    const result = compareEngines(pgViews[view], mssqlViews[view], args);
    report.views[view] = result;
    unexplained += unexplainedCount(result);
    console.log(`\n${view}: PostgreSQL ${result.odsRows}, SQL Server ${result.dmsRows}; matched ${result.matched}, ` +
      `identical ${result.identical}, only PostgreSQL ${result.onlyOds.length}, only SQL Server ${result.onlyDms.length}`);
    if (result.duplicateSourcedIds.ods || result.duplicateSourcedIds.dms) {
      console.log(`  duplicate sourcedIds: PostgreSQL ${result.duplicateSourcedIds.ods}, SQL Server ${result.duplicateSourcedIds.dms}`);
    }
    if (result.columnsOnlyOds.length) console.log(`  columns only on PostgreSQL: ${result.columnsOnlyOds.join(', ')}`);
    if (result.columnsOnlyDms.length) console.log(`  columns only on SQL Server: ${result.columnsOnlyDms.join(', ')}`);
    for (const [column, n] of Object.entries(result.orderOnly)) console.log(`  order-only ${column}: ${n}`);
    for (const [column, n] of Object.entries(result.columnDiffs)) {
      console.log(`  differs ${column}: ${n}`);
      for (const sample of result.samples[column]) {
        console.log(`    ${sample.sourcedId}\n      pg    ${JSON.stringify(sample.ods).slice(0, 160)}\n      mssql ${JSON.stringify(sample.dms).slice(0, 160)}`);
      }
    }
    for (const id of result.onlyOds.slice(0, args.samples)) console.log(`  only PostgreSQL: ${id}`);
    for (const id of result.onlyDms.slice(0, args.samples)) console.log(`  only SQL Server: ${id}`);
  }

  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${unexplained === 0 ? 'PARITY' : 'DIFFERENCES'}: ${unexplained} row/column difference(s) across ${args.views.length} view(s)`);
  process.exitCode = unexplained === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`compare-dms-engines: ${error.message}`);
    process.exit(2);
  });
}
