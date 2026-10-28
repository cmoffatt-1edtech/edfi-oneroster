#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Seed the OneRoster descriptors and descriptor mappings through the Ed-Fi API.
 *
 * Posts the six uri://1edtech.org/oneroster12/* descriptor families, then the descriptorMappings,
 * from seedData/*.jsonl. Works against Ed-Fi API v8 (DMS) and the ODS/API: the data and token
 * URLs come from the API's discovery document. Safe to rerun: the Ed-Fi API upserts on POST
 * (201 created, 200 updated), and 409 on an existing resource is treated as already seeded.
 *
 * On DMS this replaces 01_descriptors.sql and 02_descriptorMappings.sql, which write ODS tables.
 * The client needs Create on these resources and uri://1edtech.org in its namespace prefixes
 * (the SeedLoader claim set works).
 *
 * Usage:
 *   SEED_CLIENT_ID=... SEED_CLIENT_SECRET=... node standard/seed-descriptors.js --api-url http://localhost:8080
 * Options:
 *   --api-url <url>    Ed-Fi API root (discovery document). Or EDFI_API_URL.
 *   --seed-dir <dir>   Directory with the *.jsonl files. Default: seedData/ in this repository.
 *   --dry-run          Read and validate the files, post nothing.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Descriptors first: mappings name them as mappedNamespace/mappedValue.
const SEED_FILES = [
  { file: 'calendarEventDescriptors.jsonl', resource: 'calendarEventDescriptors' },
  { file: 'classroomPositionDescriptors.jsonl', resource: 'classroomPositionDescriptors' },
  { file: 'raceDescriptors.jsonl', resource: 'raceDescriptors' },
  { file: 'sexDescriptors.jsonl', resource: 'sexDescriptors' },
  { file: 'staffClassificationDescriptors.jsonl', resource: 'staffClassificationDescriptors' },
  { file: 'termDescriptor.jsonl', resource: 'termDescriptors' },
  { file: 'descriptorMappings.jsonl', resource: 'descriptorMappings' }
];

const SUCCESS_STATUSES = new Set([200, 201, 204, 409]);

function parseArgs(argv) {
  const args = { apiUrl: process.env.EDFI_API_URL, seedDir: path.resolve(__dirname, '..', 'seedData'), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--api-url': args.apiUrl = argv[++i]; break;
      case '--seed-dir': args.seedDir = path.resolve(argv[++i]); break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function joinUrl(base, suffix) {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

export function readSeedFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path.basename(filePath)} line ${index + 1}: ${error.message}`);
      }
    });
}

async function discover(apiUrl) {
  const res = await fetch(apiUrl);
  if (!res.ok) {
    throw new Error(`Discovery request to ${apiUrl} returned ${res.status}`);
  }
  const { urls } = await res.json();
  if (!urls?.oauth || !urls?.dataManagementApi) {
    throw new Error('Discovery document has no urls.oauth or urls.dataManagementApi');
  }
  return urls;
}

/** One token for the whole run: the DMS self-contained identity provider limits active tokens. */
async function getToken(tokenUrl, clientId, clientSecret) {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  });
  if (!res.ok) {
    throw new Error(`Token request returned ${res.status}`);
  }
  return (await res.json()).access_token;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const batches = SEED_FILES.map(({ file, resource }) => ({
    resource,
    items: readSeedFile(path.join(args.seedDir, file))
  }));
  const total = batches.reduce((sum, batch) => sum + batch.items.length, 0);

  if (args.dryRun) {
    for (const { resource, items } of batches) console.log(`${resource}: ${items.length}`);
    console.log(`Dry run: ${total} records read, nothing posted.`);
    return;
  }

  if (!args.apiUrl) throw new Error('Set --api-url or EDFI_API_URL');
  const clientId = process.env.SEED_CLIENT_ID;
  const clientSecret = process.env.SEED_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Set SEED_CLIENT_ID and SEED_CLIENT_SECRET');

  const urls = await discover(args.apiUrl);
  const token = await getToken(urls.oauth, clientId, clientSecret);

  let failures = 0;
  for (const { resource, items } of batches) {
    const url = joinUrl(urls.dataManagementApi, `ed-fi/${resource}`);
    const counts = {};
    for (const item of items) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(item)
      });
      counts[res.status] = (counts[res.status] || 0) + 1;
      if (!SUCCESS_STATUSES.has(res.status)) {
        failures++;
        const detail = (await res.text()).slice(0, 300);
        console.error(`${resource} ${item.namespace}#${item.codeValue ?? item.value}: ${res.status} ${detail}`);
      }
    }
    console.log(`${resource}: ${items.length} posted (${Object.entries(counts).map(([s, n]) => `${s}x${n}`).join(', ')})`);
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${total} records failed`);
  }
  console.log(`Seeded ${total} records.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`seed-descriptors: ${error.message}`);
    process.exit(1);
  });
}
