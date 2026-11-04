// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  PLATFORMS,
  DEFAULT_PLATFORM,
  parsePlatform,
  getPlatform,
  isDmsPlatform
} from '../../src/config/platform.js';

describe('platform', () => {
  let originalValue;

  beforeEach(() => {
    originalValue = process.env.PLATFORM;
    delete process.env.PLATFORM;
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.PLATFORM;
    } else {
      process.env.PLATFORM = originalValue;
    }
  });

  test('defaults to the ODS/API', () => {
    expect(DEFAULT_PLATFORM).toBe(PLATFORMS.ODS);
    expect(getPlatform()).toBe('ods');
    expect(isDmsPlatform()).toBe(false);
  });

  test.each([
    [undefined, 'ods'],
    ['', 'ods'],
    ['   ', 'ods'],
    ['ods', 'ods'],
    ['ODS', 'ods'],
    ['dms', 'dms'],
    [' Dms ', 'dms']
  ])('parses %p as %p', (value, expected) => {
    expect(parsePlatform(value)).toBe(expected);
  });

  test.each(['v8', 'ods,dms', 'dms1'])('rejects %p', (value) => {
    expect(parsePlatform(value)).toBeNull();
  });

  test('reads PLATFORM from the environment', () => {
    process.env.PLATFORM = 'dms';
    expect(getPlatform()).toBe('dms');
    expect(isDmsPlatform()).toBe(true);
  });

  test('throws on an unrecognised PLATFORM', () => {
    process.env.PLATFORM = 'v8';
    expect(() => getPlatform()).toThrow('PLATFORM must be one of: ods, dms');
  });
});
