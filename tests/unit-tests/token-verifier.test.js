// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect, beforeAll } from '@jest/globals';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { createPemTokenVerifier, createTokenVerifier } from '../../src/platform/token-verifier.js';
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

  test('has no DMS verifier yet', () => {
    expect(() => createTokenVerifier('dms', {})).toThrow('Token verification for PLATFORM=dms is not implemented yet');
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
