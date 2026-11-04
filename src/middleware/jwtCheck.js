// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { getLogger } from '../utils/logger.js';

const logger = getLogger('JwtCheck');

/**
 * Middleware that requires a bearer token and verifies it with the given token verifier
 * (see src/platform/token-verifier.js). On success the verified claims are at req.auth.payload.
 * @param {{ verify: (token: string) => Promise<Object> }} verifier
 * @returns Express middleware
 */
function createJwtCheck(verifier) {
  return async function (req, res, next) {
    const authHeader = req.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        imsx_codeMajor: 'failure',
        imsx_severity: 'error',
        imsx_description: 'Missing or invalid Authorization header.'
      });
    }
    const token = authHeader.substring(7).trim();
    if (!token) {
      return res.status(401).json({
        imsx_codeMajor: 'failure',
        imsx_severity: 'error',
        imsx_description: 'Missing or invalid Authorization header.'
      });
    }
    try {
      const payload = await verifier.verify(token);
      req.auth = { payload };
      next();
    } catch (err) {
      logger.warn({ name: err?.name || 'UnknownError', message: err?.message }, 'JWT verification error');
      return res.status(401).json({
        imsx_codeMajor: 'failure',
        imsx_severity: 'error',
        imsx_description: 'Invalid or expired token.'
      });
    }
  };
}

export { createJwtCheck };
