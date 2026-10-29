// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jwtVerify, importSPKI, importJWK, compactVerify, decodeProtectedHeader, createRemoteJWKSet } from 'jose';
import { getPlatform, PLATFORMS } from '../config/platform.js';
import { DEFAULT_DMS_HTTP_TIMEOUT_MS, getDmsTokenSettings, TOKEN_PROFILES } from '../config/dms-config.js';

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

/** fetch with a timeout, so an unresponsive issuer fails the check instead of holding the request. */
async function fetchWithTimeout(fetchImpl, url, timeoutMs, what) {
  try {
    return await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new Error(`${what} request timed out after ${timeoutMs} ms`);
    }
    throw error;
  }
}

/** The JWKS URL: configured directly, or the jwks_uri of the OIDC metadata document. */
async function resolveJwksUrl({ jwksUrl, metadataUrl, timeoutMs = DEFAULT_DMS_HTTP_TIMEOUT_MS }, fetchImpl) {
  if (jwksUrl) return jwksUrl;
  const res = await fetchWithTimeout(fetchImpl, metadataUrl, timeoutMs, 'OIDC metadata');
  if (!res.ok) {
    throw new Error(`OIDC metadata request failed with ${res.status}`);
  }
  const { jwks_uri: uri } = await res.json();
  if (!uri) {
    throw new Error('OIDC metadata has no jwks_uri');
  }
  return uri;
}

const JWKS_TTL_MS = 10 * 60 * 1000;
const UNKNOWN_KID_REFETCH_MS = 30 * 1000;

/**
 * Verify tokens issued by the DMS Configuration Service's self-contained identity provider.
 *
 * Stock jose rejects them: the JWKS key carries empty key_ops/oth/x5c arrays (an empty key_ops
 * permits no operation), and iat/exp are JSON strings rather than NumericDate numbers. So the key
 * is picked by kid with the empty arrays dropped, the signature is checked with compactVerify,
 * and iss (exact), aud and exp/nbf/iat (coerced with Number(), with clock skew) are checked here.
 * The JWKS is cached and refetched on expiry, or once on an unknown kid.
 *
 * @param {Object} options
 * @param {string} options.issuer - Exact iss, e.g. http://ed-fi-api-config:8081
 * @param {string} options.audience - e.g. account
 * @param {string} [options.jwksUrl] - Overrides the metadata's jwks_uri (needed when it names a Docker-internal host)
 * @param {string} [options.metadataUrl] - OIDC metadata document
 * @param {number} [options.clockSkewSeconds=60]
 * @param {number} [options.timeoutMs] - For the metadata and JWKS requests
 */
export function createCmsSelfContainedTokenVerifier({
  issuer,
  audience,
  jwksUrl,
  metadataUrl,
  clockSkewSeconds = 60,
  timeoutMs = DEFAULT_DMS_HTTP_TIMEOUT_MS,
  fetchImpl = fetch,
  now = Date.now
}) {
  let jwks = null; // kid -> cleaned JWK
  let fetchedAt = 0;
  let refreshing = null;
  const importedKeys = new Map();

  async function refresh() {
    if (!refreshing) {
      refreshing = (async () => {
        const url = await resolveJwksUrl({ jwksUrl, metadataUrl, timeoutMs }, fetchImpl);
        const res = await fetchWithTimeout(fetchImpl, url, timeoutMs, 'JWKS');
        if (!res.ok) {
          throw new Error(`JWKS request failed with ${res.status}`);
        }
        const { keys = [] } = await res.json();
        jwks = new Map(keys
          .filter(jwk => !jwk.use || jwk.use === 'sig')
          .map(jwk => [jwk.kid ?? '', Object.fromEntries(Object.entries(jwk).filter(([, v]) => !(Array.isArray(v) && v.length === 0)))]));
        importedKeys.clear();
        fetchedAt = now();
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  async function getKey(kid = '') {
    if (!jwks || now() - fetchedAt > JWKS_TTL_MS) {
      await refresh();
    } else if (!jwks.has(kid) && now() - fetchedAt > UNKNOWN_KID_REFETCH_MS) {
      await refresh();
    }
    const jwk = jwks.get(kid);
    if (!jwk) {
      throw new Error('No JWKS key matches the token kid');
    }
    if (!importedKeys.has(kid)) {
      importedKeys.set(kid, importJWK(jwk, 'RS256'));
    }
    return importedKeys.get(kid);
  }

  return {
    mode: TOKEN_PROFILES.CMS_SELF_CONTAINED,
    async verify(token) {
      const header = decodeProtectedHeader(token);
      if (header.alg !== 'RS256') {
        throw new Error(`Unsupported token algorithm ${header.alg}`);
      }

      const { payload: bytes } = await compactVerify(token, await getKey(header.kid), { algorithms: ['RS256'] });
      const payload = JSON.parse(new TextDecoder().decode(bytes));

      if (payload.iss !== issuer) {
        throw new Error('Issuer claim mismatch');
      }
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!audiences.includes(audience)) {
        throw new Error('Audience claim mismatch');
      }

      const nowSeconds = now() / 1000;
      const exp = Number(payload.exp);
      if (!Number.isFinite(exp)) {
        throw new Error('Token has no valid exp claim');
      }
      if (nowSeconds > exp + clockSkewSeconds) {
        throw new Error('Token has expired');
      }
      if (payload.nbf !== undefined) {
        const nbf = Number(payload.nbf);
        if (!Number.isFinite(nbf) || nowSeconds < nbf - clockSkewSeconds) {
          throw new Error('Token is not yet valid');
        }
      }
      if (payload.iat !== undefined) {
        const iat = Number(payload.iat);
        if (!Number.isFinite(iat) || iat > nowSeconds + clockSkewSeconds) {
          throw new Error('Token iat claim is invalid');
        }
      }

      return payload;
    }
  };
}

/**
 * Verify standards-conforming tokens (Keycloak, or CMS once its tokens conform) with jose's
 * jwtVerify and a remote JWKS. iss must match exactly.
 */
export function createStandardJwksTokenVerifier({
  issuer, audience, jwksUrl, metadataUrl, clockSkewSeconds = 60, timeoutMs = DEFAULT_DMS_HTTP_TIMEOUT_MS, fetchImpl = fetch
}) {
  let keySet = null;

  return {
    mode: TOKEN_PROFILES.STANDARD,
    async verify(token) {
      if (!keySet) {
        keySet = createRemoteJWKSet(new URL(await resolveJwksUrl({ jwksUrl, metadataUrl, timeoutMs }, fetchImpl)), { timeoutDuration: timeoutMs });
      }
      const { payload } = await jwtVerify(token, keySet, { issuer, audience, clockTolerance: clockSkewSeconds });
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

  // DMS publishes its signing keys through OIDC metadata and a JWKS endpoint, not a shared PEM
  const settings = getDmsTokenSettings(env);
  return settings.profile === TOKEN_PROFILES.STANDARD
    ? createStandardJwksTokenVerifier(settings)
    : createCmsSelfContainedTokenVerifier(settings);
}
