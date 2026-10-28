#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Build the physical-name map for a DMS artifact set from a DMS relational-model manifest.
 *
 * DMS shortens identifiers longer than the engine allows to `prefix_<10 hex>`, so the DMS artifacts
 * name those tables by placeholder instead:
 *   {{table:<Project>/<Resource>/<JSON path>}}
 *   e.g. {{table:Ed-Fi/StudentEducationOrganizationAssociation/$.studentIdentificationCodes[*]}}
 * This script finds every placeholder in the artifact set, looks each one up in the manifest that
 * `api-schema-tools ddl emit --ddl-manifest` writes (relational-model.<dialect>.manifest.json), and
 * writes name-map.<first 12 of the effective schema hash>.json next to the artifacts. deploy-dms.js
 * uses the map whose hash matches the target data store's dms."EffectiveSchema".
 *
 * Usage:
 *   node standard/dms/build-name-map.js --manifest <relational-model.pgsql.manifest.json> \
 *     --artifacts standard/5.2.0/artifacts/dms-pgsql
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const PLACEHOLDER_PATTERN = /\{\{table:([^/}]+)\/([^/}]+)\/([^}]+)\}\}/g;

/** Every SQL file under the artifact directory, in deploy order (see deploy-dms.js). */
export function listArtifactFiles(artifactsDir) {
  const coreDir = path.join(artifactsDir, 'core');
  return fs.readdirSync(coreDir)
    .filter(file => file.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map(file => path.join(coreDir, file));
}

/** The distinct placeholder keys ("Project/Resource/scope") used in the given SQL texts. */
export function findPlaceholders(sqlTexts) {
  const keys = new Set();
  for (const sql of sqlTexts) {
    for (const [, project, resource, scope] of sql.matchAll(PLACEHOLDER_PATTERN)) {
      keys.add(`${project}/${resource}/${scope}`);
    }
  }
  return [...keys].sort();
}

/** Resolve placeholder keys against a parsed relational-model manifest. */
export function buildNameMap(manifest, placeholderKeys) {
  const tables = {};
  const missing = [];

  for (const key of placeholderKeys) {
    const [project, resource, ...scopeParts] = key.split('/');
    const scope = scopeParts.join('/');
    const details = manifest.resource_details.find(entry =>
      entry.resource.project_name === project && entry.resource.resource_name === resource);
    const table = details?.tables.find(candidate => candidate.scope === scope);

    if (table) {
      tables[key] = { schema: table.schema, name: table.name };
    } else {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Not in the manifest: ${missing.join(', ')}`);
  }

  return {
    effectiveSchemaHash: manifest.effective_schema_hash,
    relationalMappingVersion: manifest.relational_mapping_version,
    dialect: manifest.dialect,
    tables
  };
}

export function nameMapFileName(effectiveSchemaHash) {
  return `name-map.${effectiveSchemaHash.slice(0, 12)}.json`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') args.manifest = argv[++i];
    else if (argv[i] === '--artifacts') args.artifacts = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.manifest || !args.artifacts) {
    throw new Error('Usage: build-name-map.js --manifest <relational-model manifest> --artifacts <artifact dir>');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(args.manifest, 'utf8'));
  const sqlTexts = listArtifactFiles(args.artifacts).map(file => fs.readFileSync(file, 'utf8'));
  const nameMap = buildNameMap(manifest, findPlaceholders(sqlTexts));

  const outFile = path.join(args.artifacts, nameMapFileName(nameMap.effectiveSchemaHash));
  fs.writeFileSync(outFile, `${JSON.stringify(nameMap, null, 2)}\n`);
  console.log(`Wrote ${outFile}: ${Object.keys(nameMap.tables).length} placeholder(s), effective schema ${nameMap.effectiveSchemaHash.slice(0, 12)}…`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`build-name-map: ${error.message}`);
    process.exit(1);
  }
}
