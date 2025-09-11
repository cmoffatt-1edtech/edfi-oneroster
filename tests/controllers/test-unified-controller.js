/**
 * Test unified OneRoster controller with both PostgreSQL and MSSQL
 */

require('dotenv').config();

async function testUnifiedController(dbType) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing Unified Controller with ${dbType.toUpperCase()}`);
    console.log('='.repeat(60));

    // Set the database type for this test
    const originalDbType = process.env.DB_TYPE;
    process.env.DB_TYPE = dbType;

    try {
        // Import controller after setting DB_TYPE
        delete require.cache[require.resolve('../../src/controllers/unified/oneRosterController')];
        delete require.cache[require.resolve('../../src/services/database/DatabaseServiceFactory')];
        delete require.cache[require.resolve('../../src/config/knex-factory')];
        
        const oneRosterController = require('../../src/controllers/unified/oneRosterController');

        // Mock request and response objects
        function createMockReq(query = {}, params = {}) {
            return {
                query,
                params,
                auth: { payload: { scope: 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster.readonly' } }
            };
        }

        function createMockRes() {
            const res = {
                status: function(code) {
                    res.statusCode = code;
                    return res;
                },
                json: function(data) {
                    res.data = data;
                    return res;
                }
            };
            return res;
        }

        // Test 1: Collection endpoint
        console.log('\n1. Testing collection endpoint (orgs)...');
        const req1 = createMockReq({ limit: 3, offset: 0 });
        const res1 = createMockRes();
        
        await oneRosterController.orgs(req1, res1);
        
        if (res1.statusCode && res1.statusCode !== 200) {
            console.log(`   ❌ Error response: ${res1.statusCode}`, res1.data);
        } else if (res1.data && res1.data.orgs) {
            console.log(`   ✅ Retrieved ${res1.data.orgs.length} organizations`);
            if (res1.data.orgs.length > 0) {
                console.log(`   ✅ First org: ${res1.data.orgs[0].name || res1.data.orgs[0].sourcedId}`);
            }
        } else {
            console.log(`   ❌ Unexpected response format:`, res1.data);
        }

        // Test 2: Single record endpoint
        console.log('\n2. Testing single record endpoint...');
        if (res1.data && res1.data.orgs && res1.data.orgs.length > 0) {
            const testId = res1.data.orgs[0].sourcedId;
            const req2 = createMockReq({}, { id: testId });
            const res2 = createMockRes();
            
            await oneRosterController.orgsOne(req2, res2);
            
            if (res2.statusCode && res2.statusCode === 404) {
                console.log(`   ⚠️ Record not found for ID: ${testId}`);
            } else if (res2.statusCode && res2.statusCode !== 200) {
                console.log(`   ❌ Error response: ${res2.statusCode}`, res2.data);
            } else if (res2.data && res2.data.org) {
                console.log(`   ✅ Retrieved single org: ${res2.data.org.name || res2.data.org.sourcedId}`);
                console.log(`   ✅ ID matches: ${res2.data.org.sourcedId === testId}`);
            } else {
                console.log(`   ❌ Unexpected response format:`, res2.data);
            }
        }

        // Test 3: Filtered endpoint
        console.log('\n3. Testing filtered endpoint (active orgs)...');
        const req3 = createMockReq({ limit: 5, filter: "status='active'" });
        const res3 = createMockRes();
        
        await oneRosterController.orgs(req3, res3);
        
        if (res3.statusCode && res3.statusCode !== 200) {
            console.log(`   ❌ Error response: ${res3.statusCode}`, res3.data);
        } else if (res3.data && res3.data.orgs) {
            console.log(`   ✅ Retrieved ${res3.data.orgs.length} active organizations`);
        } else {
            console.log(`   ❌ Unexpected response format:`, res3.data);
        }

        // Test 4: Subset endpoint (schools)
        console.log('\n4. Testing subset endpoint (schools)...');
        const req4 = createMockReq({ limit: 3 });
        const res4 = createMockRes();
        
        await oneRosterController.schools(req4, res4);
        
        if (res4.statusCode && res4.statusCode !== 200) {
            console.log(`   ❌ Error response: ${res4.statusCode}`, res4.data);
        } else if (res4.data && res4.data.orgs) {
            console.log(`   ✅ Retrieved ${res4.data.orgs.length} schools`);
            if (res4.data.orgs.length > 0) {
                const schoolTypes = res4.data.orgs.map(org => org.type);
                console.log(`   ✅ School types: ${[...new Set(schoolTypes)].join(', ')}`);
            }
        } else {
            console.log(`   ❌ Unexpected response format:`, res4.data);
        }

        // Test 5: Field selection
        console.log('\n5. Testing field selection...');
        const req5 = createMockReq({ limit: 2, fields: 'sourcedId,name,type' });
        const res5 = createMockRes();
        
        await oneRosterController.orgs(req5, res5);
        
        if (res5.statusCode && res5.statusCode !== 200) {
            console.log(`   ❌ Error response: ${res5.statusCode}`, res5.data);
        } else if (res5.data && res5.data.orgs && res5.data.orgs.length > 0) {
            const fields = Object.keys(res5.data.orgs[0]);
            console.log(`   ✅ Fields returned: ${fields.join(', ')}`);
            const hasOnlyRequestedFields = fields.length === 3 && 
                fields.includes('sourcedId') && 
                fields.includes('name') && 
                fields.includes('type');
            console.log(`   ✅ Only requested fields: ${hasOnlyRequestedFields}`);
        } else {
            console.log(`   ❌ Unexpected response format:`, res5.data);
        }

        // Test 6: Different endpoint (users)
        console.log('\n6. Testing users endpoint...');
        const req6 = createMockReq({ limit: 3, fields: 'sourcedId,username,givenName,familyName' });
        const res6 = createMockRes();
        
        await oneRosterController.users(req6, res6);
        
        if (res6.statusCode && res6.statusCode !== 200) {
            console.log(`   ❌ Error response: ${res6.statusCode}`, res6.data);
        } else if (res6.data && res6.data.users) {
            console.log(`   ✅ Retrieved ${res6.data.users.length} users`);
            if (res6.data.users.length > 0) {
                console.log(`   ✅ First user: ${res6.data.users[0].username || res6.data.users[0].sourcedId}`);
            }
        } else {
            console.log(`   ❌ Unexpected response format:`, res6.data);
        }

        // Test 7: Error handling
        console.log('\n7. Testing error handling (invalid field)...');
        const req7 = createMockReq({ limit: 2, fields: 'sourcedId,invalidField' });
        const res7 = createMockRes();
        
        await oneRosterController.orgs(req7, res7);
        
        if (res7.statusCode === 400) {
            console.log(`   ✅ Correctly returned 400 error for invalid field`);
            console.log(`   ✅ Error message: ${res7.data.imsx_description || res7.data.message || 'N/A'}`);
        } else {
            console.log(`   ❌ Should have returned 400 error, got:`, res7.statusCode, res7.data);
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`✅ ${dbType.toUpperCase()} unified controller tests completed!`);
        console.log('='.repeat(60));

        return true;

    } catch (error) {
        console.error(`\n❌ ${dbType.toUpperCase()} controller test failed:`, error.message);
        console.error('Stack:', error.stack);
        return false;
    } finally {
        // Restore original DB_TYPE
        process.env.DB_TYPE = originalDbType;
    }
}

async function runControllerTests() {
    const results = {
        postgres: false,
        mssql: false
    };

    try {
        // Test PostgreSQL
        console.log('Testing Unified Controller with PostgreSQL...');
        results.postgres = await testUnifiedController('postgres');

        // Test MSSQL
        console.log('\nTesting Unified Controller with MSSQL...');
        results.mssql = await testUnifiedController('mssql');

        // Summary
        console.log('\n' + '='.repeat(70));
        console.log('UNIFIED CONTROLLER TEST SUMMARY');
        console.log('='.repeat(70));
        
        console.log(`PostgreSQL: ${results.postgres ? '✅ PASSED' : '❌ FAILED'}`);
        console.log(`MSSQL:      ${results.mssql ? '✅ PASSED' : '❌ FAILED'}`);
        
        if (results.postgres && results.mssql) {
            console.log('\n🎉 All unified controller tests passed successfully!');
            return true;
        } else if (results.postgres || results.mssql) {
            console.log('\n⚠️ Some tests passed - check failures above');
            return false;
        } else {
            console.log('\n❌ All controller tests failed');
            return false;
        }

    } catch (error) {
        console.error('❌ Fatal error during controller testing:', error.message);
        return false;
    } finally {
        // Cleanup - close all database connections
        try {
            // Clear require cache to ensure fresh imports
            delete require.cache[require.resolve('../../src/services/database/DatabaseServiceFactory')];
            delete require.cache[require.resolve('../../src/config/knex-factory')];
            
            const { databaseServiceFactory } = require('../../src/services/database/DatabaseServiceFactory');
            await databaseServiceFactory.closeAll();
            console.log('\n✅ All connections closed');
        } catch (error) {
            console.error('⚠️ Error during cleanup:', error.message);
        }
    }
}

// Run the tests
console.log('Unified OneRoster Controller Test Suite');
console.log('=======================================');
runControllerTests()
    .then(success => {
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error('Test suite error:', error);
        process.exit(1);
    });