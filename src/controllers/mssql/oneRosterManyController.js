const { getPool } = require('../../../config/db-mssql');
const sql = require('mssql');

async function doOneRosterEndpointMany(req, res, endpoint, config, extraWhere = "") {
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

    try {
        // Default URL param values, overridden by any passed values:
        const {
            limit = 10,
            offset = 0,
            sort = config.defaultSortField,
            orderBy = 'asc',
            fields = '*',
            filter = ''
        } = req.query;

        const pool = await getPool();
        const request = pool.request();
        
        // Add parameters (MSSQL uses named parameters)
        request.input('limit', sql.Int, parseInt(limit));
        request.input('offset', sql.Int, parseInt(offset));

        // Construct the ORDER BY clause for MSSQL:
        const orderClause = sort.split(',').filter(s =>
            config.selectableFields.includes(s.trim())
        ).map(s =>
            orderBy.toLowerCase()=='desc' ? `[${endpoint}].[${s.trim()}] DESC` : `[${endpoint}].[${s.trim()}] ASC`
        ).join(', ');

        // Build WHERE clause with MSSQL parameter syntax
        let whereClause = buildMSSQLWhereClause(filter, config, request, extraWhere, endpoint);
        
        // Construct the SELECT clause for MSSQL:
        let fieldsClause = '';
        if (fields != "*") {
            if (fields.split(',').filter(s => config.selectableFields.includes(s.trim())).length != fields.split(',').length) {
                res.status(400).json({
                    imsx_codeMajor: 'failure',
                    imsx_severity: 'error',
                    imsx_description: `one or more of the selected 'fields' does not exist`,
                    imsx_CodeMinor: 'invalid_selection_field',
                });
                return;
            }
            fieldsClause = fields.split(',').filter(s =>
                config.selectableFields.includes(s.trim())
            ).map(s =>
                `[${endpoint}].[${s.trim()}]`
            ).join(', ');
        } else fieldsClause = config.selectableFields.map(f => `[${endpoint}].[${f}]`).join(", ");

        // MSSQL query with OFFSET/FETCH (SQL Server 2012+)
        const query = `
            SELECT ${fieldsClause}
            FROM oneroster12.[${endpoint}]
            WHERE ${whereClause}
            ORDER BY ${orderClause}
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY`;
            
        console.log("[MSSQL] Query: ", query);
        console.log("[MSSQL] Query params: ", { limit: parseInt(limit), offset: parseInt(offset) });
        
        const result = await request.query(query);
        
        // Parse JSON fields to match PostgreSQL behavior
        const parsedRecords = result.recordset.map(record => {
            const parsedRecord = { ...record };
            
            // Common JSON fields that need parsing
            const jsonFields = ['metadata', 'parent', 'children', 'grades', 'subjects', 'course', 
                              'school', 'terms', 'subjectCodes', 'periods', 'resources', 'org', 
                              'class', 'user', 'userIds', 'roles', 'userProfiles'];
            
            jsonFields.forEach(field => {
                if (parsedRecord[field] && typeof parsedRecord[field] === 'string') {
                    try {
                        parsedRecord[field] = JSON.parse(parsedRecord[field]);
                    } catch (e) {
                        // If parsing fails, keep as string (might be a simple string value)
                        // console.warn(`[MSSQL] Failed to parse JSON field '${field}':`, e.message);
                    }
                }
            });
            
            return parsedRecord;
        });
        
        res.json({ [endpoint]: parsedRecords });
        
    } catch (err) {
        console.error('[MSSQL]', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

// MSSQL-specific helper function to build WHERE clause
function buildMSSQLWhereClause(filter, config, request, extraWhere, endpoint) {
    let logical = ' AND ';
    const allowedPredicates = ['=', '!=', '>', '>=', '<', '<=', '~'];
    let whereClauseArray = [];
    let paramCount = 3; // start at 3 since limit and offset are 1 & 2
    
    if (filter != '') {
        let whereClauses = filter.split(logical);
        if (whereClauses.length == 1) {
            logical = ' OR ';
            whereClauses = filter.split(logical);
        }
        
        for (const whereClause of whereClauses) {
            let allowedPredicateFound = false;
            for (const allowedPredicate of allowedPredicates) {
                const pieces = whereClause.split(allowedPredicate);
                if (pieces.length == 2) { // allowedPredicate is the predicate
                    allowedPredicateFound = true;
                    const field = pieces[0];
                    let value = pieces[1];
                    
                    if (!config.allowedFilterFields.includes(field)) {
                        throw new Error(`'${field}' is not a field that allows filtering`);
                    }
                    
                    // trim enclosing string quotes off `value`:
                    if (value[0]=='"' && value[value.length-1]=='"')
                        value = value.substring(1,value.length-1);
                    if (value[0]=="'" && value[value.length-1]=="'")
                        value = value.substring(1,value.length-1);
                    
                    // Add parameter to request
                    const paramName = `param${paramCount}`;
                    request.input(paramName, sql.NVarChar, value);
                    
                    // Build clause with MSSQL parameter syntax
                    let sqlPredicate = allowedPredicate;
                    if (allowedPredicate === '~') {
                        sqlPredicate = 'LIKE';
                        value = `%${value}%`;
                        request.input(paramName, sql.NVarChar, value);
                    }
                    
                    whereClauseArray.push(`[${endpoint}].[${field}] ${sqlPredicate} @${paramName}`);
                    paramCount++;
                }
            }
            
            if (!allowedPredicateFound) {
                throw new Error(`'filters' contains an invalid predicate (allowed predicates are ${allowedPredicates.join(', ')})`);
            }
        }
    }
    
    // build WHERE clause; inject `extraWhere` 
    return "(" + (whereClauseArray.join(logical) || '1=1') + ")" + (extraWhere!="" ? " AND " + extraWhere : "");
}

// Configuration objects (same as PostgreSQL version)
const configs = {
    academicSessions: {
        defaultSortField: 'sourcedId',
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'type',
            'startDate', 'endDate', 'schoolYear'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'type',
            'startDate', 'endDate', 'parent', 'schoolYear', 'metadata']
    },
    classes: {
        defaultSortField: 'sourcedId',
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'classCode',
            'classType', 'location', 'periods'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'classCode',
            'classType', 'location', 'grades', 'subjects', 'course', 'school', 'terms',
            'subjectCodes', 'periods', 'resources', 'metadata']
    },
    courses: {
        defaultSortField: 'sourcedId',
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'courseCode'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'schoolYear',
            'courseCode', 'grades', 'subjects', 'org', 'subjectCodes', 'resources', 'metadata']
    },
    demographics: {
        defaultSortField: 'sourcedId',
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'birthDate', 'sex',
            'americanIndianOrAlaskaNative', 'asian', 'blackOrAfricanAmerican',
            'nativeHawaiianOrOtherPacificIslander', 'white', 'demographicRaceTwoOrMoreRaces',
            'hispanicOrLatinoEthnicity', 'countryOfBirthCode', 'stateOfBirthAbbreviation',
            'cityOfBirth'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'birthDate', 'sex',
            'americanIndianOrAlaskaNative', 'asian', 'blackOrAfricanAmerican',
            'nativeHawaiianOrOtherPacificIslander', 'white', 'demographicRaceTwoOrMoreRaces',
            'hispanicOrLatinoEthnicity', 'countryOfBirthCode', 'stateOfBirthAbbreviation',
            'cityOfBirth', 'publicSchoolResidenceStatus', 'metadata']
    },
    enrollments: {
        defaultSortField: 'sourcedId',
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'role', 'primary',
            'beginDate', 'endDate'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'class', 'user', 'school',
            'role', 'primary', 'beginDate', 'endDate', 'metadata']
    },
    orgs: {
        defaultSortField: 'sourcedId',
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'name', 'type',
            'identifier'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'name', 'type',
            'identifier', 'parent', 'children', 'metadata']
    },
    users: {
        defaultSortField: 'sourcedId',
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'username',
        'enabledUser', 'givenName', 'familyName', 'middleName', 'preferredFirstName',
        'preferredMiddleName', 'preferredLastName', 'roles', 'identifier', 'email'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'userMasterIdentifier',
            'username', 'userIds', 'enabledUser', 'givenName', 'familyName', 'middleName',
            'preferredFirstName', 'preferredMiddleName', 'preferredLastName', 'pronouns',
            'roles', 'userProfiles', 'identifier', 'email', 'sms', 'phone',
            'agentSourceIds', 'grades', 'password', 'metadata']
    }
};

// map endpoints (same as PostgreSQL version):
exports.academicSessions = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'academicSessions', configs.academicSessions); };
exports.gradingPeriods = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'academicSessions', configs.academicSessions, "type='gradingPeriod'"); };
exports.terms = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'academicSessions', configs.academicSessions, "type='term'"); };
exports.classes = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'classes', configs.classes); };
exports.courses = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'courses', configs.courses); };
exports.demographics = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'demographics', configs.demographics); };
exports.enrollments = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'enrollments', configs.enrollments); };
exports.orgs = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'orgs', configs.orgs); };
exports.schools = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'orgs', configs.orgs, "type='school'"); };
exports.users = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'users', configs.users); };
exports.students = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'users', configs.users, "role='student'"); };
exports.teachers = async (req, res) =>
    { return doOneRosterEndpointMany(req, res, 'users', configs.users, "role='teacher'"); };