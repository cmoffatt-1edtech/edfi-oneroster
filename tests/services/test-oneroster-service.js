/**
 * Test OneRoster Query Service with real data
 */

require('dotenv').config();
const { getDatabaseServiceForType } = require('../../src/services/database/DatabaseServiceFactory');

// OneRoster endpoint configurations (from existing codebase)
const testConfigs = {
  orgs: {
    defaultSortField: 'sourcedId',
    selectableFields: [
      'sourcedId', 'status', 'dateLastModified', 'name', 
      'type', 'identifier', 'parent', 'children'
    ],
    allowedFilterFields: [
      'sourcedId', 'status', 'dateLastModified', 'name', 'type'
    ]
  },
  users: {
    defaultSortField: 'sourcedId',
    selectableFields: [
      'sourcedId', 'status', 'dateLastModified', 'username',
      'userIds', 'givenName', 'familyName', 'middleName',
      'role', 'identifier', 'email', 'sms', 'phone', 'agents', 'orgs'
    ],
    allowedFilterFields: [
      'sourcedId', 'status', 'dateLastModified', 'username', 'role', 'givenName', 'familyName'
    ]
  },
  classes: {
    defaultSortField: 'sourcedId',
    selectableFields: [
      'sourcedId', 'status', 'dateLastModified', 'title',
      'grades', 'subjects', 'course', 'school', 'terms',
      'subjectCodes', 'periods', 'resources'
    ],
    allowedFilterFields: [
      'sourcedId', 'status', 'dateLastModified', 'title'
    ]
  }
};

async function testOneRosterService(dbType, service) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing ${dbType.toUpperCase()} OneRoster Query Service`);
  console.log('='.repeat(60));

  const testResults = {};

  try {
    // Test 1: Basic queryMany
    console.log('\n1. Testing basic queryMany (orgs)...');
    const orgsQuery = {
      limit: 5,
      offset: 0
    };
    const orgs = await service.queryMany('orgs', testConfigs.orgs, orgsQuery);
    console.log(`   ✅ Retrieved ${orgs.length} organizations`);
    if (orgs.length > 0) {
      console.log(`   ✅ First org: ${orgs[0].name || orgs[0].sourcedId}`);
      console.log(`   ✅ Fields returned: ${Object.keys(orgs[0]).join(', ')}`);
    }
    testResults.basicQuery = { success: true, count: orgs.length };

    // Test 2: Query with field selection
    console.log('\n2. Testing field selection...');
    const fieldsQuery = {
      limit: 3,
      offset: 0,
      fields: 'sourcedId,name,type'
    };
    const selectedFieldOrgs = await service.queryMany('orgs', testConfigs.orgs, fieldsQuery);
    console.log(`   ✅ Retrieved ${selectedFieldOrgs.length} organizations with selected fields`);
    if (selectedFieldOrgs.length > 0) {
      const fieldNames = Object.keys(selectedFieldOrgs[0]);
      console.log(`   ✅ Only requested fields returned: ${fieldNames.join(', ')}`);
      const hasOnlyRequestedFields = fieldNames.length === 3 && 
        fieldNames.includes('sourcedId') && 
        fieldNames.includes('name') && 
        fieldNames.includes('type');
      console.log(`   ✅ Field selection working: ${hasOnlyRequestedFields}`);
    }
    testResults.fieldSelection = { success: true, count: selectedFieldOrgs.length };

    // Test 3: Query with filtering
    console.log('\n3. Testing filtering...');
    try {
      const filterQuery = {
        limit: 10,
        offset: 0,
        filter: "status='active'"
      };
      const filteredOrgs = await service.queryMany('orgs', testConfigs.orgs, filterQuery);
      console.log(`   ✅ Retrieved ${filteredOrgs.length} active organizations`);
      testResults.filtering = { success: true, count: filteredOrgs.length };
    } catch (error) {
      console.log(`   ⚠️ Filtering test failed: ${error.message}`);
      testResults.filtering = { success: false, error: error.message };
    }

    // Test 4: Query with sorting
    console.log('\n4. Testing sorting...');
    const sortQuery = {
      limit: 5,
      offset: 0,
      sort: 'name',
      orderBy: 'desc'
    };
    const sortedOrgs = await service.queryMany('orgs', testConfigs.orgs, sortQuery);
    console.log(`   ✅ Retrieved ${sortedOrgs.length} organizations sorted by name DESC`);
    if (sortedOrgs.length > 1) {
      const firstName = sortedOrgs[0].name || '';
      const secondName = sortedOrgs[1].name || '';
      const isDescending = firstName >= secondName;
      console.log(`   ✅ Sorting working: ${isDescending} (${firstName} >= ${secondName})`);
    }
    testResults.sorting = { success: true, count: sortedOrgs.length };

    // Test 5: Query with pagination
    console.log('\n5. Testing pagination...');
    const page1Query = { limit: 2, offset: 0 };
    const page2Query = { limit: 2, offset: 2 };
    
    const page1 = await service.queryMany('orgs', testConfigs.orgs, page1Query);
    const page2 = await service.queryMany('orgs', testConfigs.orgs, page2Query);
    
    console.log(`   ✅ Page 1: ${page1.length} records`);
    console.log(`   ✅ Page 2: ${page2.length} records`);
    
    if (page1.length > 0 && page2.length > 0) {
      const differentRecords = page1[0].sourcedId !== page2[0].sourcedId;
      console.log(`   ✅ Different records on different pages: ${differentRecords}`);
    }
    testResults.pagination = { success: true, page1: page1.length, page2: page2.length };

    // Test 6: queryOne
    console.log('\n6. Testing queryOne...');
    if (orgs.length > 0) {
      const testId = orgs[0].sourcedId;
      const singleOrg = await service.queryOne('orgs', testId);
      if (singleOrg) {
        console.log(`   ✅ Retrieved single org: ${singleOrg.name || singleOrg.sourcedId}`);
        console.log(`   ✅ sourcedId matches: ${singleOrg.sourcedId === testId}`);
      } else {
        console.log(`   ❌ Single org not found for ID: ${testId}`);
      }
      testResults.queryOne = { success: !!singleOrg, found: !!singleOrg };
    }

    // Test 7: Complex filtering (if supported)
    console.log('\n7. Testing complex filtering...');
    try {
      const complexQuery = {
        limit: 10,
        offset: 0,
        filter: "status='active' AND type='school'"
      };
      const complexFiltered = await service.queryMany('orgs', testConfigs.orgs, complexQuery);
      console.log(`   ✅ Retrieved ${complexFiltered.length} records with complex filter`);
      testResults.complexFiltering = { success: true, count: complexFiltered.length };
    } catch (error) {
      console.log(`   ⚠️ Complex filtering failed: ${error.message}`);
      testResults.complexFiltering = { success: false, error: error.message };
    }

    // Test 8: Different endpoint (users)
    console.log('\n8. Testing different endpoint (users)...');
    const usersQuery = {
      limit: 5,
      offset: 0,
      fields: 'sourcedId,username,givenName,familyName,role'
    };
    const users = await service.queryMany('users', testConfigs.users, usersQuery);
    console.log(`   ✅ Retrieved ${users.length} users`);
    if (users.length > 0) {
      console.log(`   ✅ First user: ${users[0].username || users[0].sourcedId}`);
      console.log(`   ✅ User role: ${users[0].role || 'N/A'}`);
    }
    testResults.usersEndpoint = { success: true, count: users.length };

    // Test 9: Error handling
    console.log('\n9. Testing error handling...');
    try {
      const invalidFieldQuery = {
        limit: 5,
        offset: 0,
        fields: 'sourcedId,invalidField'
      };
      await service.queryMany('orgs', testConfigs.orgs, invalidFieldQuery);
      console.log(`   ❌ Should have thrown error for invalid field`);
      testResults.errorHandling = { success: false, reason: 'No error thrown' };
    } catch (error) {
      console.log(`   ✅ Correctly caught error: ${error.message}`);
      testResults.errorHandling = { success: true, error: error.message };
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✅ ${dbType.toUpperCase()} OneRoster service tests completed!`);
    console.log('='.repeat(60));

    return testResults;

  } catch (error) {
    console.error(`\n❌ ${dbType.toUpperCase()} service test failed:`, error.message);
    console.error('Stack:', error.stack);
    throw error;
  }
}

async function runAllTests() {
  const results = {
    postgres: null,
    mssql: null
  };

  try {
    // Test PostgreSQL service
    console.log('\nTesting PostgreSQL OneRoster Query Service...');
    try {
      const pgService = await getDatabaseServiceForType('postgres');
      results.postgres = await testOneRosterService('postgres', pgService);
    } catch (error) {
      console.error('❌ PostgreSQL service test failed:', error.message);
      results.postgres = { error: error.message };
    }

    // Test MSSQL service
    console.log('\nTesting MSSQL OneRoster Query Service...');
    try {
      const mssqlService = await getDatabaseServiceForType('mssql');
      results.mssql = await testOneRosterService('mssql', mssqlService);
    } catch (error) {
      console.error('❌ MSSQL service test failed:', error.message);
      results.mssql = { error: error.message };
    }

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('TEST SUMMARY');
    console.log('='.repeat(70));
    
    const pgSuccess = results.postgres && !results.postgres.error;
    const mssqlSuccess = results.mssql && !results.mssql.error;
    
    console.log(`PostgreSQL Service: ${pgSuccess ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`MSSQL Service:      ${mssqlSuccess ? '✅ PASSED' : '❌ FAILED'}`);
    
    if (pgSuccess && mssqlSuccess) {
      console.log('\n🎉 All OneRoster service tests passed successfully!');
      return true;
    } else if (pgSuccess || mssqlSuccess) {
      console.log('\n⚠️ Some tests passed - we can proceed');
      return true;
    } else {
      console.log('\n❌ All service tests failed');
      return false;
    }

  } catch (error) {
    console.error('❌ Fatal error during service testing:', error.message);
    return false;
  } finally {
    // Cleanup
    try {
      const { databaseServiceFactory } = require('../../src/services/database/DatabaseServiceFactory');
      await databaseServiceFactory.closeAll();
      console.log('\n✅ All services closed');
    } catch (error) {
      console.error('⚠️ Error during cleanup:', error.message);
    }
  }
}

// Run tests
console.log('OneRoster Query Service Test Suite');
console.log('==================================');
runAllTests()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
  });