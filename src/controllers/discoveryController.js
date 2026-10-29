// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { isMultiTenancyEnabled } from '../config/multi-tenancy-config.js';
import {
  getOdsContextConfig,
  buildUrlTemplate,
  populateUrlTemplate
} from '../config/ods-context-config.js';
import { getExternalBaseUrl } from '../utils/urlHelper.js';
import { isSwaggerUiEnabled, isOpenApiMetadataEnabled } from '../config/api-docs.js';
import { isDmsPlatform } from '../config/platform.js';
import { getRouteContextConfig } from '../config/route-context-config.js';
import { getDmsTokenUrl } from '../config/dms-config.js';

/**
 * Ed-Fi API v8 (DMS): the route prefix is the tenant and the ROUTE_QUALIFIER_SEGMENTS values, each
 * taken from the request or left as a {placeholder}, as in the DMS discovery document. Tokens come
 * from the one OAUTH2_TOKEN_URL.
 */
function getDmsDiscovery(req) {
  const value = (name, placeholder) => (req.params[name] ? encodeURIComponent(req.params[name]) : `{${placeholder}}`);
  const segments = [];
  if (isMultiTenancyEnabled()) {
    segments.push(value('tenantId', 'tenantIdentifier'));
  }
  for (const name of getRouteContextConfig()?.parameterNames || []) {
    segments.push(value(name, name));
  }
  const prefix = [getExternalBaseUrl(req).replace(/\/$/, ''), ...segments].join('/');

  const urls = {};
  if (isOpenApiMetadataEnabled()) {
    urls.openApiMetadata = `${prefix}/swagger.json`;
  }
  if (isSwaggerUiEnabled()) {
    urls.swaggerUI = `${prefix}/docs`;
  }
  urls.oauth = getDmsTokenUrl();
  urls.dataManagementApi = `${prefix}/ims/oneroster/rostering/v1p2/`;

  return { version: '1.0.0', urls };
}

/**
 * Get discovery response with populated URLs
 */
export function getDiscovery(req, res) {
  if (isDmsPlatform()) {
    return res.json(getDmsDiscovery(req));
  }

  const baseUrl = getExternalBaseUrl(req);
  const multiTenancyEnabled = isMultiTenancyEnabled();
  const contextConfig = getOdsContextConfig();

  // Extract tenant and context from request params (may be null if not in route)
  const tenantId = req.params.tenantId || null;
  const contextValue = contextConfig?.parameterName ? req.params[contextConfig.parameterName] : null;

  // Build URL templates with all placeholders
  const oauthTemplate = buildUrlTemplate(process.env.OAUTH2_ISSUERBASEURL, multiTenancyEnabled, contextConfig, '/oauth/token');
  const apiTemplate = buildUrlTemplate(baseUrl, multiTenancyEnabled, contextConfig, '/ims/oneroster/rostering/v1p2/');

  // Populate templates with actual values (leaves placeholders for null values)
  // Each documentation URL is advertised only while its endpoint is mounted; see
  // ENABLE_OPEN_API_METADATA and ENABLE_SWAGGER_UI.
  const urls = {};

  if (isOpenApiMetadataEnabled()) {
    const swaggerTemplate = buildUrlTemplate(baseUrl, multiTenancyEnabled, contextConfig, '/swagger.json');
    urls.openApiMetadata = populateUrlTemplate(swaggerTemplate, tenantId, contextValue, contextConfig);
  }

  if (isSwaggerUiEnabled()) {
    const docsTemplate = buildUrlTemplate(baseUrl, multiTenancyEnabled, contextConfig, '/docs');
    urls.swaggerUI = populateUrlTemplate(docsTemplate, tenantId, contextValue, contextConfig);
  }

  urls.oauth = populateUrlTemplate(oauthTemplate, tenantId, contextValue, contextConfig);
  urls.dataManagementApi = populateUrlTemplate(apiTemplate, tenantId, contextValue, contextConfig);

  const response = {
    version: '1.0.0',
    urls: urls
  };

  res.json(response);
}
