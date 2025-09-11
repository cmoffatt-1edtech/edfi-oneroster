const { getPool } = require('../../../config/db-mssql');
const sql = require('mssql');

async function doOneRosterEndpointOne(req, res, endpoint, extraWhere = "1=1") {
    // check scope/permissions (same as PostgreSQL):
    if (process.env.OAUTH2_AUDIENCE) {
        const scope = req.auth.payload.scope;
        if (
            (endpoint=='demographics' && !scope.includes('https://purl.imsglobal.org/spec/or/v1p2/scope/roster-demographics.readonly') && !scope.includes('https://purl.imsglobal.org/spec/or/v1p2/scope/roster.readonly'))
            || (endpoint!='demographics' && !scope.includes('https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly') && !scope.includes('https://purl.imsglobal.org/spec/or/v1p2/scope/roster.readonly'))
        ) {
            // permission denied!
            return res.status(403).json({
                message: `Insufficient scope: your token must have the 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster.readonly' or '${endpoint=='demographics' ? 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster-demographics.readonly' : 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly'}' scope to access this route.`
            });
        }
    }

    const id = req.params.id;
    try {
        const pool = await getPool();
        const request = pool.request();
        
        // Add parameter for sourcedId
        request.input('sourcedId', sql.NVarChar, id);
        
        // Put together the query with MSSQL syntax:
        const query = `SELECT * FROM oneroster12.[${endpoint}] WHERE [${endpoint}].[sourcedId] = @sourcedId AND ${extraWhere}`;
        
        console.log("[MSSQL] Query: ", query);
        console.log("[MSSQL] Query params: ", { sourcedId: id });
        
        const result = await request.query(query);
        
        if (result.recordset.length === 0) {
            res.status(404).json({ error: 'Not found' });
            return;
        }
        
        // Parse JSON fields to match PostgreSQL behavior
        const record = { ...result.recordset[0] };
        const jsonFields = ['metadata', 'parent', 'children', 'grades', 'subjects', 'course', 
                          'school', 'terms', 'subjectCodes', 'periods', 'resources', 'org', 
                          'class', 'user', 'userIds', 'roles', 'userProfiles'];
        
        jsonFields.forEach(field => {
            if (record[field] && typeof record[field] === 'string') {
                try {
                    record[field] = JSON.parse(record[field]);
                } catch (e) {
                    // If parsing fails, keep as string (might be a simple string value)
                    // console.warn(`[MSSQL] Failed to parse JSON field '${field}':`, e.message);
                }
            }
        });
        
        res.json({ [getWrapper(endpoint)]: record });
    } catch (err) {
        console.error('[MSSQL]', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

// map endpoints (same as PostgreSQL version):
exports.academicSessions = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'academicSessions'); };
exports.gradingPeriods = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'academicSessions', "type='gradingPeriod'"); };
exports.terms = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'academicSessions', "type='term'"); };
exports.classes = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'classes'); };
exports.courses = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'courses'); };
exports.demographics = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'demographics'); };
exports.enrollments = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'enrollments'); };
exports.orgs = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'orgs'); };
exports.schools = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'orgs', "type='school'"); };
exports.users = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'users'); };
exports.students = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'users', "role='student'"); };
exports.teachers = async (req, res) =>
    { return doOneRosterEndpointOne(req, res, 'users', "role='teacher'"); };

// Helper function (same as PostgreSQL version)
function getWrapper(word) {
    if (word=='classes') return 'class';
    //if (word=='demographics') return 'demographics'; // this one is still plural for some reason
    if (word=='gradingPeriod') return 'academicSession';
    if (word=='term') return 'academicSession';
    if (word=='school') return 'org';
    if (word=='student') return 'user';
    if (word=='teacher') return 'user';
    const endings = { ies: 'y', es: 'e', s: '' };
    return word.replace(
        new RegExp(`(${Object.keys(endings).join('|')})$`), 
        r => endings[r]
    );
}