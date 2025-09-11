/**
 * Database-API Consistency Test
 * Comprehensive validation that compares direct database queries with API endpoints
 * for all OneRoster tables/materialized views to ensure data consistency
 */

require('dotenv').config();
const { getKnexForType } = require('../../src/config/knex-factory');
const http = require('http');

class DatabaseAPIConsistencyTester {
    constructor() {
        this.knex = null;
        this.apiBaseUrl = 'http://localhost:3000';
        this.apiPath = '/ims/oneroster/rostering/v1p2';
        this.testResults = {};
        
        // Define all OneRoster endpoints to test
        this.endpoints = [
            {
                name: 'Organizations',
                tableName: 'orgs',
                apiEndpoint: '/orgs',
                collectionWrapper: 'orgs',
                singleWrapper: 'org',
                expectedFields: ['sourcedId', 'status', 'dateLastModified', 'name', 'type', 'identifier', 'parent', 'children', 'metadata']
            },
            {
                name: 'Users',
                tableName: 'users',
                apiEndpoint: '/users',
                collectionWrapper: 'users',
                singleWrapper: 'user',
                expectedFields: ['sourcedId', 'status', 'dateLastModified', 'userMasterIdentifier', 'username', 'userIds', 'enabledUser', 'givenName', 'familyName', 'middleName', 'preferredFirstName', 'preferredMiddleName', 'preferredLastName', 'pronouns', 'roles', 'userProfiles', 'identifier', 'email', 'sms', 'phone', 'agentSourceIds', 'grades', 'password', 'metadata']
            },
            {
                name: 'Classes',
                tableName: 'classes',
                apiEndpoint: '/classes',
                collectionWrapper: 'classes',
                singleWrapper: 'class',
                expectedFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'classCode', 'classType', 'location', 'grades', 'subjects', 'course', 'school', 'terms', 'subjectCodes', 'periods', 'resources', 'metadata']
            },
            {
                name: 'Courses',
                tableName: 'courses',
                apiEndpoint: '/courses',
                collectionWrapper: 'courses',
                singleWrapper: 'course',
                expectedFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'schoolYear', 'courseCode', 'grades', 'subjects', 'org', 'subjectCodes', 'metadata']
            },
            {
                name: 'Academic Sessions',
                tableName: 'academicsessions',
                apiEndpoint: '/academicSessions',
                collectionWrapper: 'academicsessions',
                singleWrapper: 'academicsession',
                expectedFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'type', 'startDate', 'endDate', 'parent', 'schoolYear', 'metadata']
            },
            {
                name: 'Enrollments',
                tableName: 'enrollments',
                apiEndpoint: '/enrollments',
                collectionWrapper: 'enrollments',
                singleWrapper: 'enrollment',
                expectedFields: ['sourcedId', 'status', 'dateLastModified', 'class', 'user', 'school', 'role', 'primary', 'beginDate', 'endDate', 'metadata']
            },
            {
                name: 'Demographics',
                tableName: 'demographics',
                apiEndpoint: '/demographics',
                collectionWrapper: 'demographics',
                singleWrapper: 'demographic',
                expectedFields: ['sourcedId', 'status', 'dateLastModified', 'birthDate', 'sex', 'americanIndianOrAlaskaNative', 'asian', 'blackOrAfricanAmerican', 'nativeHawaiianOrOtherPacificIslander', 'white', 'demographicRaceTwoOrMoreRaces', 'hispanicOrLatinoEthnicity', 'countryOfBirthCode', 'stateOfBirthAbbreviation', 'cityOfBirth', 'publicSchoolResidenceStatus', 'metadata']
            }
        ];
    }

    async initialize() {
        try {
            // Get database connection
            this.knex = getKnexForType(process.env.DB_TYPE || 'postgres');
            console.log(`✅ Database connection established (${process.env.DB_TYPE || 'postgres'})`);
        } catch (error) {
            console.error('❌ Failed to connect to database:', error.message);
            throw error;
        }
    }

    /**
     * Make HTTP request to API
     */
    async makeAPIRequest(endpoint, queryParams = {}) {
        const url = new URL(`${this.apiBaseUrl}${this.apiPath}${endpoint}`);
        
        // Add query parameters
        Object.keys(queryParams).forEach(key => {
            if (queryParams[key] !== undefined && queryParams[key] !== null) {
                url.searchParams.append(key, queryParams[key]);
            }
        });

        return new Promise((resolve, reject) => {
            const startTime = Date.now();
            
            const req = http.get(url.toString(), (res) => {
                let data = '';
                
                res.on('data', chunk => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    const responseTime = Date.now() - startTime;
                    
                    try {
                        const jsonData = JSON.parse(data);
                        resolve({
                            statusCode: res.statusCode,
                            headers: res.headers,
                            data: jsonData,
                            responseTime,
                            rawData: data
                        });
                    } catch (error) {
                        resolve({
                            statusCode: res.statusCode,
                            headers: res.headers,
                            data: null,
                            responseTime,
                            rawData: data,
                            parseError: error.message
                        });
                    }
                });
            });
            
            req.on('error', reject);
            req.setTimeout(10000, () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    /**
     * Check if table/materialized view exists
     */
    async checkTableExists(tableName) {
        try {
            let exists = false;
            let objectType = '';
            
            if (process.env.DB_TYPE === 'mssql') {
                // For MSSQL, check for regular tables
                exists = await this.knex.schema.withSchema('oneroster12').hasTable(tableName);
                objectType = 'table';
            } else {
                // For PostgreSQL, check for materialized views first, then tables
                const matViewResult = await this.knex.raw(`
                    SELECT schemaname, matviewname 
                    FROM pg_matviews 
                    WHERE schemaname = 'oneroster12' AND matviewname = ?
                `, [tableName]);
                
                if (matViewResult.rows && matViewResult.rows.length > 0) {
                    exists = true;
                    objectType = 'materialized view';
                } else {
                    // Fallback to check regular table
                    exists = await this.knex.schema.withSchema('oneroster12').hasTable(tableName);
                    objectType = 'table';
                }
            }
            
            return { exists, objectType };
        } catch (error) {
            return { exists: false, error: error.message };
        }
    }

    /**
     * Get table column information
     */
    async getTableColumns(tableName) {
        try {
            if (process.env.DB_TYPE === 'mssql') {
                // MSSQL column query
                const columns = await this.knex.raw(`
                    SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type, IS_NULLABLE as is_nullable
                    FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_SCHEMA = 'oneroster12' AND TABLE_NAME = ?
                    ORDER BY ORDINAL_POSITION
                `, [tableName]);
                return columns.recordset || columns;
            } else {
                // PostgreSQL column query (works for both tables and materialized views)
                const columns = await this.knex('information_schema.columns')
                    .select('column_name', 'data_type', 'is_nullable')
                    .where('table_schema', 'oneroster12')
                    .where('table_name', tableName)
                    .orderBy('ordinal_position');
                return columns;
            }
        } catch (error) {
            throw new Error(`Failed to get columns for ${tableName}: ${error.message}`);
        }
    }

    /**
     * Test single endpoint for database-API consistency
     */
    async testEndpoint(endpointConfig) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Testing ${endpointConfig.name}`);
        console.log('='.repeat(60));

        const results = {
            name: endpointConfig.name,
            tableName: endpointConfig.tableName,
            success: false,
            issues: []
        };

        try {
            // 1. Check if table/view exists
            console.log(`\n1. Checking ${endpointConfig.tableName} table/view existence...`);
            const tableCheck = await this.checkTableExists(endpointConfig.tableName);
            
            if (!tableCheck.exists) {
                console.log(`   ❌ ${endpointConfig.tableName} does not exist`);
                results.issues.push(`Table/view ${endpointConfig.tableName} does not exist`);
                return results;
            }
            
            console.log(`   ✅ Found as ${tableCheck.objectType}`);

            // 2. Get row count
            console.log(`\n2. Getting row count...`);
            const countResult = await this.knex(`oneroster12.${endpointConfig.tableName}`).count('* as count');
            const rowCount = parseInt(countResult[0].count);
            console.log(`   Database rows: ${rowCount}`);
            
            if (rowCount === 0) {
                console.log(`   ⚠️ Table is empty`);
                results.issues.push('Table is empty');
            }

            // 3. Get table structure
            console.log(`\n3. Analyzing table structure...`);
            const columns = await this.getTableColumns(endpointConfig.tableName);
            const availableColumns = columns.map(c => c.column_name);
            const missingFields = endpointConfig.expectedFields.filter(field => !availableColumns.includes(field));
            const existingFields = endpointConfig.expectedFields.filter(field => availableColumns.includes(field));

            console.log(`   Available columns: ${availableColumns.length}`);
            console.log(`   Expected fields: ${endpointConfig.expectedFields.length}`);
            if (missingFields.length > 0) {
                console.log(`   ❌ Missing fields: ${missingFields.join(', ')}`);
                results.issues.push(`Missing fields: ${missingFields.join(', ')}`);
            } else {
                console.log(`   ✅ All expected fields present`);
            }

            // 4. Test API collection endpoint
            console.log(`\n4. Testing API collection endpoint...`);
            const apiResponse = await this.makeAPIRequest(endpointConfig.apiEndpoint, { limit: 5 });
            
            console.log(`   Status: ${apiResponse.statusCode}`);
            console.log(`   Response time: ${apiResponse.responseTime}ms`);
            
            if (apiResponse.statusCode !== 200) {
                console.log(`   ❌ API returned ${apiResponse.statusCode}: ${apiResponse.rawData}`);
                results.issues.push(`API error: ${apiResponse.statusCode}`);
                return results;
            }

            if (!apiResponse.data || !apiResponse.data[endpointConfig.collectionWrapper]) {
                console.log(`   ❌ Missing ${endpointConfig.collectionWrapper} wrapper in response`);
                results.issues.push(`Missing collection wrapper: ${endpointConfig.collectionWrapper}`);
                return results;
            }

            const apiRecords = apiResponse.data[endpointConfig.collectionWrapper];
            console.log(`   ✅ API returned ${apiRecords.length} records`);

            // 5. Compare data consistency
            console.log(`\n5. Data consistency check...`);
            if (rowCount > 0 && apiRecords.length === 0) {
                console.log(`   ⚠️ Database has ${rowCount} rows but API returned 0 records`);
                results.issues.push('Data inconsistency: DB has data but API returns none');
            } else if (rowCount === 0 && apiRecords.length > 0) {
                console.log(`   ⚠️ Database has 0 rows but API returned ${apiRecords.length} records`);
                results.issues.push('Data inconsistency: DB empty but API returns data');
            } else if (rowCount > 0 && apiRecords.length > 0) {
                console.log(`   ✅ Both database and API have data`);
                
                // Check field consistency if we have data
                if (apiRecords.length > 0) {
                    const apiFields = Object.keys(apiRecords[0]);
                    const extraApiFields = apiFields.filter(field => !endpointConfig.expectedFields.includes(field));
                    const missingApiFields = endpointConfig.expectedFields.filter(field => !apiFields.includes(field));
                    
                    if (extraApiFields.length > 0) {
                        console.log(`   ℹ️ Extra API fields: ${extraApiFields.join(', ')}`);
                    }
                    if (missingApiFields.length > 0) {
                        console.log(`   ⚠️ Missing API fields: ${missingApiFields.join(', ')}`);
                        results.issues.push(`API missing fields: ${missingApiFields.join(', ')}`);
                    }
                }
            } else {
                console.log(`   ✅ Both database and API are empty (consistent)`);
            }

            // 6. Test single record endpoint if we have data
            if (apiRecords.length > 0) {
                console.log(`\n6. Testing single record endpoint...`);
                const testId = apiRecords[0].sourcedId;
                const singleResponse = await this.makeAPIRequest(`${endpointConfig.apiEndpoint}/${testId}`);
                
                if (singleResponse.statusCode === 200 && singleResponse.data[endpointConfig.singleWrapper]) {
                    console.log(`   ✅ Single record endpoint working`);
                } else {
                    console.log(`   ⚠️ Single record endpoint issue: ${singleResponse.statusCode}`);
                    results.issues.push('Single record endpoint not working');
                }
            }

            // Summary
            console.log(`\n📊 Summary for ${endpointConfig.name}:`);
            console.log(`   Database: ${tableCheck.objectType} with ${rowCount} rows`);
            console.log(`   API: ${apiResponse.statusCode} returning ${apiRecords.length} records`);
            console.log(`   Issues: ${results.issues.length}`);
            
            results.success = results.issues.length === 0;
            results.rowCount = rowCount;
            results.apiRecordCount = apiRecords.length;
            results.responseTime = apiResponse.responseTime;

        } catch (error) {
            console.error(`   ❌ Test failed: ${error.message}`);
            results.issues.push(`Test error: ${error.message}`);
        }

        return results;
    }

    /**
     * Run comprehensive consistency test for all endpoints
     */
    async runConsistencyTests() {
        console.log('Database-API Consistency Test Suite');
        console.log('===================================');
        console.log(`Database Type: ${process.env.DB_TYPE || 'postgres'}`);
        console.log(`API Base URL: ${this.apiBaseUrl}${this.apiPath}`);

        const startTime = Date.now();
        const allResults = [];

        try {
            await this.initialize();

            // Test each endpoint
            for (const endpoint of this.endpoints) {
                const result = await this.testEndpoint(endpoint);
                allResults.push(result);
                this.testResults[endpoint.name] = result;
            }

            // Generate summary report
            const totalTime = Date.now() - startTime;
            console.log(`\n${'='.repeat(80)}`);
            console.log(`CONSISTENCY TEST SUMMARY`);
            console.log('='.repeat(80));
            
            let totalTests = allResults.length;
            let successfulTests = allResults.filter(r => r.success).length;
            let testsWithIssues = allResults.filter(r => r.issues.length > 0).length;

            console.log(`Total Endpoints Tested: ${totalTests}`);
            console.log(`Successful Tests: ${successfulTests}`);
            console.log(`Tests with Issues: ${testsWithIssues}`);
            console.log(`Success Rate: ${((successfulTests / totalTests) * 100).toFixed(1)}%`);
            console.log(`Total Time: ${totalTime}ms`);

            // Detailed results
            console.log(`\nDetailed Results:`);
            allResults.forEach(result => {
                const status = result.success ? '✅' : '❌';
                console.log(`  ${status} ${result.name}: ${result.issues.length} issues`);
                if (result.issues.length > 0) {
                    result.issues.forEach(issue => {
                        console.log(`     - ${issue}`);
                    });
                }
            });

            // Recommendations
            const failedTests = allResults.filter(r => !r.success);
            if (failedTests.length > 0) {
                console.log(`\nRecommendations:`);
                failedTests.forEach(result => {
                    console.log(`  ${result.name}:`);
                    result.issues.forEach(issue => {
                        if (issue.includes('Missing fields')) {
                            console.log(`    - Update controller configuration to match table schema`);
                        } else if (issue.includes('does not exist')) {
                            console.log(`    - Verify table/view exists in database schema`);
                        } else if (issue.includes('API error')) {
                            console.log(`    - Check API implementation and error handling`);
                        }
                    });
                });
            } else {
                console.log(`\n🎉 All endpoints show consistent database-API behavior!`);
            }

            return {
                success: successfulTests === totalTests,
                totalTests,
                successfulTests,
                testsWithIssues,
                results: allResults,
                totalTime
            };

        } catch (error) {
            console.error('❌ Test suite failed:', error.message);
            return {
                success: false,
                error: error.message
            };
        } finally {
            // Cleanup
            if (this.knex) {
                await this.knex.destroy();
                console.log('\n✅ Database connection closed');
            }
        }
    }
}

// Run the consistency tests
async function runConsistencyTests() {
    const tester = new DatabaseAPIConsistencyTester();
    
    try {
        const result = await tester.runConsistencyTests();
        process.exit(result.success ? 0 : 1);
    } catch (error) {
        console.error('Consistency test suite error:', error);
        process.exit(1);
    }
}

// Export for potential use in other test suites
module.exports = { DatabaseAPIConsistencyTester };

// Run tests if this file is executed directly
if (require.main === module) {
    console.log('Starting Database-API Consistency Tests...');
    console.log('Make sure the API server is running on http://localhost:3000\n');
    runConsistencyTests();
}