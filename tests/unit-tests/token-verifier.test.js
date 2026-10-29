// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'http';
import { generateKeyPair, exportSPKI, exportJWK, SignJWT, CompactSign, jwtVerify, createLocalJWKSet } from 'jose';
import {
  createPemTokenVerifier,
  createTokenVerifier,
  createCmsSelfContainedTokenVerifier,
  createStandardJwksTokenVerifier
} from '../../src/platform/token-verifier.js';
import { createJwtCheck } from '../../src/middleware/jwtCheck.js';

const AUDIENCE = 'oneroster-api';
const ISSUER = 'https://ods.example.org/api';

let privateKey;
let publicKeyPem;

async function signToken({ issuer = ISSUER, audience = AUDIENCE, expiresIn = '5m', key = privateKey } = {}) {
  return new SignJWT({ scope: 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster.readonly', educationOrganizationId: '255901' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

function createRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function createReq(authorization) {
  return { get: name => (name.toLowerCase() === 'authorization' ? authorization : undefined) };
}

beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  publicKeyPem = await exportSPKI(keys.publicKey);
});

describe('createPemTokenVerifier', () => {
  test('returns the payload of a valid token', async () => {
    const verifier = createPemTokenVerifier({ publicKeyPem, audience: AUDIENCE, issuer: ISSUER });

    const payload = await verifier.verify(await signToken());

    expect(verifier.mode).toBe('pem');
    expect(payload.educationOrganizationId).toBe('255901');
  });

  test('compares issuers without trailing slashes', async () => {
    const verifier = createPemTokenVerifier({ publicKeyPem, audience: AUDIENCE, issuer: `${ISSUER}/` });

    await expect(verifier.verify(await signToken({ issuer: `${ISSUER}//` }))).resolves.toBeDefined();
  });

  test('accepts a PEM with escaped newlines, as env files carry it', async () => {
    const escapedPem = publicKeyPem.replace(/\n/g, '\\n');
    const verifier = createPemTokenVerifier({ publicKeyPem: escapedPem, audience: AUDIENCE, issuer: ISSUER });

    await expect(verifier.verify(await signToken())).resolves.toBeDefined();
  });

  test('rejects another issuer', async () => {
    const verifier = createPemTokenVerifier({ publicKeyPem, audience: AUDIENCE, issuer: ISSUER });

    await expect(verifier.verify(await signToken({ issuer: 'https://elsewhere.example.org' })))
      .rejects.toThrow('Issuer claim mismatch');
  });

  test('rejects another audience', async () => {
    const verifier = createPemTokenVerifier({ publicKeyPem, audience: AUDIENCE, issuer: ISSUER });

    await expect(verifier.verify(await signToken({ audience: 'account' }))).rejects.toThrow(/aud/);
  });

  test('rejects an expired token', async () => {
    const verifier = createPemTokenVerifier({ publicKeyPem, audience: AUDIENCE, issuer: ISSUER });

    await expect(verifier.verify(await signToken({ expiresIn: '-1m' }))).rejects.toThrow(/exp/);
  });

  test('rejects a token signed with another key', async () => {
    const other = await generateKeyPair('RS256');
    const verifier = createPemTokenVerifier({ publicKeyPem, audience: AUDIENCE, issuer: ISSUER });

    await expect(verifier.verify(await signToken({ key: other.privateKey }))).rejects.toThrow();
  });
});

describe('createTokenVerifier', () => {
  test('uses the PEM verifier from OAUTH2_* settings on the ODS/API', async () => {
    const verifier = createTokenVerifier('ods', {
      OAUTH2_PUBLIC_KEY_PEM: publicKeyPem,
      OAUTH2_AUDIENCE: AUDIENCE,
      OAUTH2_ISSUERBASEURL: ISSUER
    });

    expect(verifier.mode).toBe('pem');
    await expect(verifier.verify(await signToken())).resolves.toBeDefined();
  });

  test('verifies DMS tokens as the CMS self-contained provider issues them by default', () => {
    const env = { OAUTH2_ISSUER: CMS_ISSUER, OAUTH2_AUDIENCE: 'account', OAUTH2_JWKS_URL: 'http://cms/jwks' };
    expect(createTokenVerifier('dms', env).mode).toBe('cms-self-contained');
    expect(createTokenVerifier('dms', { ...env, OAUTH2_TOKEN_PROFILE: 'standard' }).mode).toBe('standard');
  });
});

const CMS_ISSUER = 'http://ed-fi-api-config:8081';
const KID = 'cms-key-1';

describe('createCmsSelfContainedTokenVerifier', () => {
  let cmsKeys;
  let cmsJwks;

  beforeAll(async () => {
    cmsKeys = await generateKeyPair('RS256', { extractable: true });
    // As the CMS publishes it: empty key_ops, oth and x5c arrays
    cmsJwks = { keys: [{ ...(await exportJWK(cmsKeys.publicKey)), kid: KID, alg: 'RS256', use: 'sig', key_ops: [], oth: [], x5c: [] }] };
  });

  /** Sign a payload as CMS does: iat and exp as JSON strings. */
  function cmsToken(overrides = {}, { kid = KID, key = cmsKeys.privateKey } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: CMS_ISSUER, aud: 'account', scope: 'OneRoster-ReadOnly', client_id: 'lea',
      educationOrganizationIds: '255901', dataStoreIds: '1',
      iat: String(now), exp: String(now + 1800), ...overrides
    };
    return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
      .sign(key);
  }

  function createVerifier(fetchImpl = jest.fn(async () => ({ ok: true, json: async () => cmsJwks }))) {
    return { fetchImpl, verifier: createCmsSelfContainedTokenVerifier({ issuer: CMS_ISSUER, audience: 'account', jwksUrl: 'http://cms/jwks', fetchImpl }) };
  }

  test('stock jose rejects these tokens, which is why this verifier exists', async () => {
    await expect(jwtVerify(await cmsToken(), createLocalJWKSet(cmsJwks))).rejects.toThrow();
  });

  test('accepts a CMS token with string iat/exp and a JWKS with empty arrays', async () => {
    const { verifier } = createVerifier();
    const payload = await verifier.verify(await cmsToken());

    expect(verifier.mode).toBe('cms-self-contained');
    expect(payload.scope).toBe('OneRoster-ReadOnly');
    expect(payload.dataStoreIds).toBe('1');
  });

  test('fails a token check when the JWKS request outlasts the timeout', async () => {
    const fetchImpl = jest.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }));
    const verifier = createCmsSelfContainedTokenVerifier({ issuer: CMS_ISSUER, audience: 'account', jwksUrl: 'http://cms/jwks', timeoutMs: 20, fetchImpl });
    await expect(verifier.verify(await cmsToken())).rejects.toThrow('JWKS request timed out after 20 ms');
  });

  test('fetches the JWKS once and reuses it', async () => {
    const { verifier, fetchImpl } = createVerifier();
    await verifier.verify(await cmsToken());
    await verifier.verify(await cmsToken());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('finds the JWKS through the OIDC metadata when no JWKS URL is set', async () => {
    const fetchImpl = jest.fn(async url => ({
      ok: true,
      json: async () => (url.endsWith('openid-configuration') ? { jwks_uri: 'http://cms/config/.well-known/jwks.json' } : cmsJwks)
    }));
    const verifier = createCmsSelfContainedTokenVerifier({
      issuer: CMS_ISSUER, audience: 'account', metadataUrl: 'http://cms/.well-known/openid-configuration', fetchImpl
    });

    await expect(verifier.verify(await cmsToken())).resolves.toBeDefined();
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      'http://cms/.well-known/openid-configuration', 'http://cms/config/.well-known/jwks.json'
    ]);
  });

  test.each([
    ['another issuer', { iss: 'http://localhost:8081' }, 'Issuer claim mismatch'],
    ['another audience', { aud: 'oneroster' }, 'Audience claim mismatch'],
    ['an expired token', { exp: String(Math.floor(Date.now() / 1000) - 120) }, 'Token has expired'],
    ['a token not yet valid', { nbf: String(Math.floor(Date.now() / 1000) + 600) }, 'Token is not yet valid'],
    ['a token without exp', { exp: undefined }, 'Token has no valid exp claim'],
    ['a non-numeric exp', { exp: 'soon' }, 'Token has no valid exp claim']
  ])('rejects %s', async (label, overrides, message) => {
    const { verifier } = createVerifier();
    await expect(verifier.verify(await cmsToken(overrides))).rejects.toThrow(message);
  });

  test('allows clock skew on exp', async () => {
    const { verifier } = createVerifier();
    await expect(verifier.verify(await cmsToken({ exp: String(Math.floor(Date.now() / 1000) - 30) }))).resolves.toBeDefined();
  });

  test('rejects a token signed with another key', async () => {
    const other = await generateKeyPair('RS256');
    const { verifier } = createVerifier();
    await expect(verifier.verify(await cmsToken({}, { key: other.privateKey }))).rejects.toThrow();
  });

  test('rejects an unknown kid without refetching the JWKS it just loaded', async () => {
    const { verifier, fetchImpl } = createVerifier();
    await expect(verifier.verify(await cmsToken({}, { kid: 'rotated' }))).rejects.toThrow('No JWKS key matches the token kid');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects algorithms other than RS256', async () => {
    const { verifier } = createVerifier();
    const hs = await new SignJWT({ iss: CMS_ISSUER, aud: 'account' })
      .setProtectedHeader({ alg: 'HS256', kid: KID }).sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
    await expect(verifier.verify(hs)).rejects.toThrow('Unsupported token algorithm HS256');
  });
});

describe('createStandardJwksTokenVerifier', () => {
  let server;
  let jwksUrl;
  let keys;

  beforeAll(async () => {
    keys = await generateKeyPair('RS256', { extractable: true });
    const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'kc-1', alg: 'RS256', use: 'sig' }] });
    server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(jwks); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    jwksUrl = `http://127.0.0.1:${server.address().port}/jwks`;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  test('verifies conforming tokens (Keycloak) with an exact issuer', async () => {
    const verifier = createStandardJwksTokenVerifier({ issuer: 'https://kc.example.org/realms/edfi', audience: 'account', jwksUrl });
    const token = await new SignJWT({ scope: 'OneRoster-ReadOnly' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kc-1' })
      .setIssuer('https://kc.example.org/realms/edfi').setAudience('account').setIssuedAt().setExpirationTime('5m')
      .sign(keys.privateKey);

    expect((await verifier.verify(token)).scope).toBe('OneRoster-ReadOnly');

    const otherIssuer = createStandardJwksTokenVerifier({ issuer: 'https://kc.example.org/realms/edfi/', audience: 'account', jwksUrl });
    await expect(otherIssuer.verify(token)).rejects.toThrow();
  });
});

describe('createJwtCheck', () => {
  const missingHeader = {
    imsx_codeMajor: 'failure',
    imsx_severity: 'error',
    imsx_description: 'Missing or invalid Authorization header.'
  };

  test.each([
    ['no header', undefined],
    ['a non-bearer scheme', 'Basic abc'],
    ['an empty bearer token', 'Bearer   ']
  ])('answers 401 for %s without calling the verifier', async (label, header) => {
    const verifier = { verify: jest.fn() };
    const res = createRes();
    const next = jest.fn();

    await createJwtCheck(verifier)(createReq(header), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(missingHeader);
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('answers 401 when the verifier rejects the token', async () => {
    const verifier = { verify: jest.fn().mockRejectedValue(new Error('signature verification failed')) };
    const res = createRes();
    const next = jest.fn();

    await createJwtCheck(verifier)(createReq('Bearer abc.def.ghi'), res, next);

    expect(verifier.verify).toHaveBeenCalledWith('abc.def.ghi');
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      imsx_codeMajor: 'failure',
      imsx_severity: 'error',
      imsx_description: 'Invalid or expired token.'
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('puts the verified claims on req.auth.payload', async () => {
    const payload = { sub: 'client', educationOrganizationId: '255901' };
    const verifier = { verify: jest.fn().mockResolvedValue(payload) };
    const req = createReq('Bearer  abc.def.ghi ');
    const res = createRes();
    const next = jest.fn();

    await createJwtCheck(verifier)(req, res, next);

    expect(verifier.verify).toHaveBeenCalledWith('abc.def.ghi');
    expect(req.auth).toEqual({ payload });
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});
