#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Deploy the OneRoster projections (schema oneroster12) into an Ed-Fi API v8 (DMS) data store.
 *
 * 1. Reads dms."EffectiveSchema" and dms."SchemaComponent" to pick the artifact set
 *    (standard/<Ed-Fi data standard>/artifacts/dms-pgsql) and the name map built for this exact
 *    effective schema (see dms/build-name-map.js). Refuses to deploy when none matches.
 * 2. Resolves {{table:...}} placeholders to physical (possibly hash-shortened) table names.
 * 3. Checks that every edfi/dms/auth table or view the artifacts name exists.
 * 4. Applies the artifacts in one transaction, so a bad reference (a renamed column, say) changes
 *    nothing, and primes the materialized views. Rerunning replaces the views.
 *
 * DMS provisioning drops and recreates a data store's database when its schema changes, which
 * removes oneroster12: rerun this script after every `ddl provision`.
 *
 * Usage:
 *   node standard/deploy-dms.js --connection "host=...;port=5432;username=...;password=...;database=..."
 *   Options:
 *     --check                 Validate only: resolve, check tables, apply in a rolled-back transaction.
 *     --only orgs,users       Deploy these projections only (file names without .sql).
 *     --jobs-database <name>  Also create this database for the pg-boss queue if it is missing.
 *   The connection string can come from DMS_DATA_STORE_CONNECTION instead of --connection.
 *   Statements run without a timeout unless DB_REQUEST_TIMEOUT is set.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { parseConnectionString } from '../src/config/multi-tenancy-config.js';
import { buildPostgresClientOptions } from '../src/config/db-connection.js';
import { buildRequestTimeoutOptions } from '../src/config/db-timeouts.js';
import { listArtifactFiles, nameMapFileName, PLACEHOLDER_PATTERN } from './dms/build-name-map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = 'dms-pgsql';
const SETUP_FILE = '00_setup.sql';
const REFERENCED_OBJECT_PATTERN = /\b(edfi|dms|auth|tpdm)\."([A-Za-z0-9_]+)"/g;
const VIEW_PATTERN = /create\s+materialized\s+view\s+(?:if\s+not\s+exists\s+)?oneroster12\.("?)([A-Za-z0-9_]+)\1/gi;

function parseArgs(argv) {
  const args = { connection: process.env.DMS_DATA_STORE_CONNECTION, check: false, only: null, jobsDatabase: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--connection': args.connection = argv[++i]; break;
      case '--check': args.check = true; break;
      case '--only': args.only = argv[++i].split(',').map(name => name.trim()).filter(Boolean); break;
      case '--jobs-database': args.jobsDatabase = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.connection) throw new Error('Set --connection or DMS_DATA_STORE_CONNECTION');
  return args;
}

function quotePg(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function resolvePlaceholders(sql, nameMap) {
  const unresolved = new Set();
  const resolved = sql.replace(PLACEHOLDER_PATTERN, (match, project, resource, scope) => {
    const table = nameMap.tables[`${project}/${resource}/${scope}`];
    if (!table) {
      unresolved.add(match);
      return match;
    }
    return `${table.schema}.${quotePg(table.name)}`;
  });
  if (unresolved.size > 0) {
    throw new Error(`No name-map entry for ${[...unresolved].join(', ')}`);
  }
  return resolved;
}

export function findReferencedObjects(sql) {
  const objects = new Set();
  const code = sql.replace(/--[^\n]*/g, '');
  for (const [, schema, name] of code.matchAll(REFERENCED_OBJECT_PATTERN)) {
    objects.add(`${schema}.${name}`);
  }
  return [...objects].sort();
}

export function findMaterializedViews(sql) {
  return [...sql.matchAll(VIEW_PATTERN)].map(match => match[2]);
}

async function readTargetSchema(client) {
  const effective = await client.query('select "EffectiveSchemaHash" as hash from dms."EffectiveSchema"');
  if (effective.rows.length !== 1) {
    throw new Error('dms."EffectiveSchema" has no single row: is this a provisioned DMS data store?');
  }
  const components = await client.query(
    'select "ProjectName" as project, "ProjectVersion" as version from dms."SchemaComponent" where "EffectiveSchemaHash" = $1',
    [effective.rows[0].hash]
  );
  const core = components.rows.find(row => row.project === 'Ed-Fi');
  if (!core) {
    throw new Error('dms."SchemaComponent" lists no Ed-Fi project');
  }
  return { hash: effective.rows[0].hash, dataStandard: core.version, components: components.rows };
}

function loadArtifacts(target, only) {
  const artifactsDir = path.join(__dirname, target.dataStandard, 'artifacts', ENGINE_DIR);
  if (!fs.existsSync(artifactsDir)) {
    throw new Error(`No DMS artifacts for Ed-Fi Data Standard ${target.dataStandard} (${artifactsDir})`);
  }

  const nameMapFile = path.join(artifactsDir, nameMapFileName(target.hash));
  if (!fs.existsSync(nameMapFile)) {
    throw new Error(
      `No name map for effective schema ${target.hash} in ${artifactsDir}. ` +
      'Build one from this data store\'s relational-model manifest with standard/dms/build-name-map.js.'
    );
  }
  const nameMap = JSON.parse(fs.readFileSync(nameMapFile, 'utf8'));
  if (nameMap.effectiveSchemaHash !== target.hash || nameMap.dialect !== 'pgsql') {
    throw new Error(`${nameMapFile} does not match effective schema ${target.hash} (pgsql)`);
  }

  let files = listArtifactFiles(artifactsDir);
  if (only) {
    const wanted = new Set([SETUP_FILE, ...only.map(name => `${name}.sql`)]);
    const unknown = only.filter(name => !files.some(file => path.basename(file) === `${name}.sql`));
    if (unknown.length > 0) throw new Error(`Unknown projection(s): ${unknown.join(', ')}`);
    files = files.filter(file => wanted.has(path.basename(file)));
  }

  return files.map(file => ({ file: path.basename(file), sql: resolvePlaceholders(fs.readFileSync(file, 'utf8'), nameMap) }));
}

async function checkReferencedObjects(client, artifacts) {
  const referenced = [...new Set(artifacts.flatMap(({ sql }) => findReferencedObjects(sql)))];
  const { rows } = await client.query(
    `select table_schema || '.' || table_name as name from information_schema.tables
      where table_schema = any($1)`,
    [[...new Set(referenced.map(name => name.split('.')[0]))]]
  );
  const existing = new Set(rows.map(row => row.name));
  const missing = referenced.filter(name => !existing.has(name));
  if (missing.length > 0) {
    throw new Error(`Referenced objects missing from the data store: ${missing.join(', ')}`);
  }
  return referenced.length;
}

async function applyArtifacts(client, artifacts, { commit }) {
  const timings = [];
  await client.query('begin');
  try {
    for (const { file, sql } of artifacts) {
      const started = Date.now();
      try {
        await client.query(sql);
      } catch (error) {
        throw new Error(`${file}: ${error.message}`);
      }
      timings.push({ file, ms: Date.now() - started });
    }

    const counts = {};
    for (const { sql } of artifacts) {
      for (const view of findMaterializedViews(sql)) {
        const { rows } = await client.query(`select count(*)::int as n from oneroster12.${quotePg(view)}`);
        counts[view] = rows[0].n;
      }
    }

    await client.query(commit ? 'commit' : 'rollback');
    return { timings, counts };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

async function ensureJobsDatabase(client, name) {
  const { rows } = await client.query('select 1 from pg_database where datname = $1', [name]);
  if (rows.length > 0) return false;
  await client.query(`create database ${quotePg(name)}`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // A deploy builds every view from scratch, which can exceed the API's per-query timeout.
  process.env.DB_REQUEST_TIMEOUT ??= '0';

  const connectionConfig = parseConnectionString(args.connection, 'postgres');
  const client = new pg.Client({
    ...buildPostgresClientOptions(connectionConfig),
    ...buildRequestTimeoutOptions('postgres')
  });
  await client.connect();

  try {
    const target = await readTargetSchema(client);
    console.log(`Data store ${connectionConfig.database}: Ed-Fi ${target.dataStandard} ` +
      `(${target.components.map(c => `${c.project} ${c.version}`).join(', ')}), effective schema ${target.hash.slice(0, 12)}…`);

    const artifacts = loadArtifacts(target, args.only);
    const objectCount = await checkReferencedObjects(client, artifacts);
    console.log(`${artifacts.length} artifact file(s); ${objectCount} referenced edfi/dms/auth objects exist`);

    const { timings, counts } = await applyArtifacts(client, artifacts, { commit: !args.check });
    for (const { file, ms } of timings) console.log(`  ${file.padEnd(24)} ${String(ms).padStart(6)} ms`);
    for (const [view, n] of Object.entries(counts)) console.log(`  oneroster12.${view.padEnd(18)} ${n} rows`);
    console.log(args.check ? 'Check passed; nothing was changed.' : 'Deployed.');

    if (args.jobsDatabase && !args.check) {
      const created = await ensureJobsDatabase(client, args.jobsDatabase);
      console.log(`pg-boss database ${args.jobsDatabase}: ${created ? 'created' : 'exists'}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`deploy-dms: ${error.message}`);
    process.exit(1);
  });
}
