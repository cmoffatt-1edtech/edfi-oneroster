// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jwtVerify, importSPKI } from 'jose';
import { getPlatform, PLATFORMS } from '../config/platform.js';

/**
 * Token verifiers. Each one exposes verify(token) -> Promise<payload> and throws when the token is
 * not acceptable; src/middleware/jwtCheck.js turns a throw into the 401 envelope.
 */

function normalizeIssuer(iss) {
  return iss ? iss.replace(/\/+$/, '') : iss;
}

/**
 * Verify RS256 tokens against a PEM public key shared with the issuer (the ODS/API).
 * The issuer is compared after trailing-slash normalization; the audience must match exactly.
 * @param {Object} options
 * @param {string} options.publicKeyPem - PEM-encoded public key; "\n" escapes are accepted
 * @param {string} options.audience - Expected audience
 * @param {string} options.issuer - Expected issuer
 */
export function createPemTokenVerifier({ publicKeyPem, audience, issuer }) {
  // Replace escaped newlines with real newlines for PEM
  const fixedPem = publicKeyPem.replace(/\\n/g, '\n');
  let publicKeyPromise = null;

  function getPublicKey() {
    if (!publicKeyPromise) {
      publicKeyPromise = importSPKI(fixedPem, 'RS256').catch((err) => {
        // Reset the cached promise on failure to avoid permanently caching a rejected promise
        publicKeyPromise = null;
        throw err;
      });
    }
    return publicKeyPromise;
  }

  const normalizedIssuer = normalizeIssuer(issuer);

  return {
    mode: 'pem',
    async verify(token) {
      const publicKey = await getPublicKey();
      // Accept any issuer, validate manually after
      const { payload } = await jwtVerify(token, publicKey, {
        audience,
        issuer: undefined
      });
      // Normalize both configured and token issuer for comparison
      if (normalizeIssuer(payload.iss) !== normalizedIssuer) {
        throw new Error('Issuer claim mismatch');
      }
      return payload;
    }
  };
}

/**
 * The token verifier for the configured platform.
 * @param {string} [platform] - Defaults to the configured PLATFORM
 * @param {Object} [env] - Defaults to process.env
 */
export function createTokenVerifier(platform = getPlatform(), env = process.env) {
  if (platform === PLATFORMS.ODS) {
    return createPemTokenVerifier({
      publicKeyPem: env.OAUTH2_PUBLIC_KEY_PEM,
      audience: env.OAUTH2_AUDIENCE,
      issuer: env.OAUTH2_ISSUERBASEURL
    });
  }

  // DMS publishes its signing keys through OIDC metadata and a JWKS endpoint rather than a shared
  // PEM, and its self-contained tokens need a verifier that tolerates their claim types.
  throw new Error(`Token verification for PLATFORM=${platform} is not implemented yet`);
}
