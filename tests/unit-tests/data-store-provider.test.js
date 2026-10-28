// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect } from '@jest/globals';
import {
  createEdFiAdminDataStoreProvider,
  getDataStoreProvider
} from '../../src/platform/data-store-provider.js';

describe('data-store providers', () => {
  describe('EdFi_Admin (ODS/API)', () => {
    function createProvider() {
      const instanceService = {
        resolveOdsConnectionString: jest.fn().mockResolvedValue('host=db-ods;database=EdFi_Ods'),
        destroy: jest.fn().mockResolvedValue(undefined)
      };
      const adminConnectionStringFor = jest.fn(() => 'host=db-admin;database=EdFi_Admin');
      const provider = createEdFiAdminDataStoreProvider({ instanceService, adminConnectionStringFor });
      return { provider, instanceService, adminConnectionStringFor };
    }

    test('resolves the ODS instance through its tenant\'s EdFi_Admin', async () => {
      const { provider, instanceService, adminConnectionStringFor } = createProvider();

      const connectionString = await provider.resolveConnectionString({ tenantId: 'Tenant1', dataStoreId: 3, dbType: 'postgres' });

      expect(provider.name).toBe('edfiAdmin');
      expect(connectionString).toBe('host=db-ods;database=EdFi_Ods');
      expect(adminConnectionStringFor).toHaveBeenCalledWith('Tenant1', 'postgres');
      expect(instanceService.resolveOdsConnectionString).toHaveBeenCalledWith({
        adminConnectionString: 'host=db-admin;database=EdFi_Admin',
        dbType: 'postgres',
        odsInstanceId: 3,
        tenantId: 'Tenant1'
      });
    });

    test('defaults to no tenant', async () => {
      const { provider, adminConnectionStringFor, instanceService } = createProvider();

      await provider.resolveConnectionString({ dataStoreId: 3, dbType: 'mssql' });

      expect(adminConnectionStringFor).toHaveBeenCalledWith(null, 'mssql');
      expect(instanceService.resolveOdsConnectionString).toHaveBeenCalledWith(expect.objectContaining({ tenantId: null }));
    });

    test('fails when EdFi_Admin is not configured, before any lookup', async () => {
      const { provider, adminConnectionStringFor, instanceService } = createProvider();
      adminConnectionStringFor.mockImplementation(() => { throw new Error('CONNECTION_CONFIG is not set'); });

      await expect(provider.resolveConnectionString({ dataStoreId: 3, dbType: 'postgres' }))
        .rejects.toThrow('CONNECTION_CONFIG is not set');
      expect(instanceService.resolveOdsConnectionString).not.toHaveBeenCalled();
    });

    test('closes the EdFi_Admin connections on destroy', async () => {
      const { provider, instanceService } = createProvider();

      await provider.destroy();

      expect(instanceService.destroy).toHaveBeenCalled();
    });
  });

  describe('getDataStoreProvider', () => {
    test('creates the EdFi_Admin provider once on the ODS/API', () => {
      const provider = getDataStoreProvider('ods');

      expect(provider.name).toBe('edfiAdmin');
      expect(getDataStoreProvider('ods')).toBe(provider);
    });

    test('has no DMS provider yet', () => {
      expect(() => getDataStoreProvider('dms')).toThrow('Data-store resolution for PLATFORM=dms is not implemented yet');
    });
  });
});
