-- SPDX-License-Identifier: Apache-2.0
-- Licensed to 1EdTech Consortium, Inc. under one or more agreements.
-- 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
-- See the LICENSE and NOTICES files in the project root for more information.

-- OneRoster 1.2 projections over an Ed-Fi API v8 (DMS) data store, Data Standard 5.2, PostgreSQL.
-- Deployed by standard/deploy-dms.js, which resolves {{table:...}} placeholders first.
--
-- Rules shared by every projection in this directory:
--   * DMS names are PascalCase and quoted; rows are keyed by "DocumentId".
--   * Descriptors are int FKs to dms."Descriptor"; OneRoster mappings come from
--     edfi."DescriptorMapping", seeded through the API by standard/seed-descriptors.js.
--   * dateLastModified is "ContentLastModifiedAt" converted to timestamp without time zone in
--     UTC, the same type and meaning as the ODS lastmodifieddate.
--   * Every sourcedId formula, column, and JSON shape matches standard/5.2.0/artifacts/pgsql;
--     person keys are participantDocumentId / studentDocumentId instead of USIs.
create schema if not exists oneroster12 authorization current_user;
