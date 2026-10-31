// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { getDefaultDatabaseService } from '../../services/database/DatabaseServiceFactory.js';
import { ASSESSMENT_ENDPOINTS, ASSESSMENT_ENDPOINT_NAMES } from '../../config/assessment-rostering.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('OneRosterController');

// Error codes that represent a handled client error (bad input), not a server-side failure.
const CLIENT_ERROR_CODES = new Set(['AUTH_FILTER_MISSING', 'FILTER_VALIDATION_ERROR', 'PAGINATION_VALIDATION_ERROR']);

/**
 * Unified OneRoster Controller
 * Uses Knex.js database services for both PostgreSQL and MSSQL
 */

// Map DB table names to OneRoster JSON collection wrapper names
// (only needed where they differ)
const collectionNames = {
    academicsessions: 'academicSessions',
    assessmentofferings: 'assessmentOfferings',
    assessmentenrollments: 'assessmentEnrollments',
};

function getCollectionName(endpoint) {
    return collectionNames[endpoint] || endpoint;
}

// OneRoster endpoint configurations
const configs = {
    academicsessions: {
        defaultSortField: '', // Use database natural ordering instead of sourcedId
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'type',
            'startDate', 'endDate', 'schoolYear'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'type',
            'startDate', 'endDate', 'parent', 'schoolYear', 'metadata']
    },
    classes: {
        defaultSortField: '', // Use database natural ordering instead of sourcedId
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'classCode',
            'classType', 'location', 'periods'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'classCode',
            'classType', 'location', 'grades', 'subjects', 'course', 'school', 'terms',
            'subjectCodes', 'periods', 'resources', 'metadata']
    },
    courses: {
        defaultSortField: '', // Use database natural ordering instead of sourcedId
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'courseCode'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'schoolYear',
            'courseCode', 'grades', 'subjects', 'org', 'subjectCodes', 'metadata']
    },
    demographics: {
        defaultSortField: '', // Use database natural ordering instead of sourcedId
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
        defaultSortField: '', // Use database natural ordering instead of sourcedId
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'role', 'primary',
            'beginDate', 'endDate'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'class', 'user', 'school',
            'role', 'primary', 'beginDate', 'endDate', 'metadata']
    },
    orgs: {
        defaultSortField: '', // Use database natural ordering instead of sourcedId
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'name', 'type',
            'identifier'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'name', 'type',
            'identifier', 'parent', 'children', 'metadata']
    },
    users: {
        defaultSortField: '', // Use database natural ordering instead of sourcedId
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'username',
        'enabledUser', 'givenName', 'familyName', 'middleName', 'preferredFirstName',
        'preferredMiddleName', 'preferredLastName', 'roles', 'identifier', 'email'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'userMasterIdentifier',
            'username', 'userIds', 'enabledUser', 'givenName', 'familyName', 'middleName',
            'preferredFirstName', 'preferredMiddleName', 'preferredLastName', 'pronouns',
            'roles', 'userProfiles', 'identifier', 'email', 'sms', 'phone',
            'agentSourceIds', 'grades', 'password', 'metadata']
    },
    // Assessment rostering (src/config/assessment-rostering.js). Hidden columns the
    // authorization filters and sub-collections read are deliberately not selectable.
    assessments: {
        defaultSortField: '',
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'identifier',
            'category'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'identifier',
            'version', 'category', 'subjects', 'grades', 'org', 'course', 'metadata']
    },
    assessmentofferings: {
        defaultSortField: '',
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'title'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'title', 'assessment', 'org',
            'testingWindows', 'class', 'academicSession', 'metadata']
    },
    assessmentenrollments: {
        defaultSortField: '',
        allowedFilterFields: ['sourcedId', 'status', 'dateLastModified', 'role'],
        selectableFields: ['sourcedId', 'status', 'dateLastModified', 'user', 'assessmentOffering',
            'school', 'role', 'beginDate', 'endDate', 'metadata']
    }
};

// Hidden columns that link a sub-collection's rows to their parent
const parentColumns = {
    assessmentofferings: 'assessmentSourcedId',
    assessmentenrollments: 'assessmentOfferingSourcedId'
};

/**
 * Whether a query failed because a oneroster12 view doesn't exist: PostgreSQL 42P01
 * (undefined_table), SQL Server 208 (invalid object name).
 */
function isMissingViewError(error) {
    return error?.code === '42P01' || error?.number === 208 || error?.originalError?.info?.number === 208;
}

/**
 * An assessment rostering endpoint on a data store without the assessment views: Data Standard
 * 4.0, which has no assessment registration data, or the views were never deployed. The service
 * doesn't know a data store's Data Standard, so the missing view is how it finds out.
 */
function isAssessmentRosteringUnavailable(endpoint, error) {
    return ASSESSMENT_ENDPOINT_NAMES.has(endpoint) && isMissingViewError(error);
}

function handleAssessmentRosteringUnavailable(res) {
    return res.status(404).json({
        imsx_codeMajor: 'failure',
        imsx_severity: 'error',
        imsx_description: 'Assessment rostering is not available for this data store.',
        imsx_codeMinor: 'unknownobject'
    });
}

function handleMissingAuthFilterError(res, error) {
    return res.status(403).json({
        imsx_codeMajor: 'failure',
        imsx_severity: 'error',
        imsx_description: error.message || 'Authorization policy could not be resolved for this endpoint.',
        imsx_codeMinor: 'forbidden'
    });
}

/**
 * Handle collection endpoints (many records)
 */
async function doOneRosterEndpointMany(req, res, endpoint, config, extraWhere = null, parent = null) {

    if (!req.odsInstanceId) {
        const routeValues = Object.entries(req.params || {}).map(([k, v]) => `${k}=${v}`).join(', ');
        logger.warn(`No ODS instance matching the available route values was found. Route values were: [${routeValues}]`);
        return res.status(404).json({
            imsx_codeMajor: 'failure',
            imsx_severity: 'error',
            imsx_description: 'The specified data could not be found.'
        });
    }

    try {
        // Get database service with two-level resolution (tenant + ODS instance + context)
        const dbService = await getDefaultDatabaseService(req.tenantId, req.odsInstanceId, req.odsCacheKey, req.odsConnectionVersion);
        // Get education organization IDs from token for authorization filtering
        const educationOrgIds = req.educationOrgIds || [];

        // A sub-collection answers 404 when its parent doesn't exist or isn't visible to the
        // caller, like the parent's own single-record endpoint
        if (parent) {
            const parentRecord = await dbService.queryOne(parent.endpoint, parent.id, null, educationOrgIds, ['sourcedId']);
            if (!parentRecord) {
                return res.status(404).json({
                    imsx_codeMajor: 'failure',
                    imsx_severity: 'error',
                    imsx_description: `Resource not found: ${parent.endpoint}/${parent.id}`
                });
            }
        }

        // Execute query using Knex.js service with authorization
        const results = await dbService.queryMany(endpoint, config, req.query, extraWhere, educationOrgIds);

        // Return OneRoster-formatted response
        res.json({ [getCollectionName(endpoint)]: results });

    } catch (error) {
        const unavailable = isAssessmentRosteringUnavailable(endpoint, error);
        const logLevel = CLIENT_ERROR_CODES.has(error.code) || unavailable ? 'warn' : 'error';
        logger[logLevel]({ endpoint, err: error }, `Error in ${endpoint} many`);

        if (unavailable) {
            return handleAssessmentRosteringUnavailable(res);
        }

        if (error.code === 'AUTH_FILTER_MISSING') {
            return handleMissingAuthFilterError(res, error);
        }

        // Handle validation errors
        if (error.code === 'FILTER_VALIDATION_ERROR') {
            return res.status(400).json({
                imsx_codeMajor: 'failure',
                imsx_severity: 'error',
                imsx_description: error.message,
                imsx_codeMinor: 'invalid_data'
            });
        }

        // Handle malformed pagination parameters - a client error, not a server fault
        if (error.code === 'PAGINATION_VALIDATION_ERROR') {
            return res.status(400).json({
                imsx_codeMajor: 'failure',
                imsx_severity: 'error',
                imsx_description: error.message,
                imsx_codeMinor: 'invalid_data'
            });
        }

        // Generic server error
        res.status(500).json({
            imsx_codeMajor: 'failure',
            imsx_severity: 'error',
            imsx_description: 'An internal server error occurred'
        });
    }
}

/**
 * Handle single record endpoints
 */
async function doOneRosterEndpointOne(req, res, endpoint, config, extraWhere = null) {
    const id = req.params.id;

    if (!req.odsInstanceId) {
        const routeValues = Object.entries(req.params || {}).map(([k, v]) => `${k}=${v}`).join(', ');
        logger.warn(`No ODS instance matching the available route values was found. Route values were: [${routeValues}]`);
        return res.status(404).json({
            imsx_codeMajor: 'failure',
            imsx_severity: 'error',
            imsx_description: 'The specified data could not be found.'
        });
    }

    try {
        // Get database service with two-level resolution (tenant + ODS instance + context)
        const dbService = await getDefaultDatabaseService(req.tenantId, req.odsInstanceId, req.odsCacheKey, req.odsConnectionVersion);

        // Get education organization IDs from token for authorization filtering
        const educationOrgIds = req.educationOrgIds || [];

        // Execute single record query with authorization
        const selectableFields = config ? config.selectableFields : null;
        const result = await dbService.queryOne(endpoint, id, extraWhere, educationOrgIds, selectableFields);

        if (!result) {
            return res.status(404).json({
                imsx_codeMajor: 'failure',
                imsx_severity: 'error',
                imsx_description: `Resource not found: ${endpoint}/${id}`
            });
        }

        // Return OneRoster-formatted response with proper wrapper
        res.json({ [getWrapper(endpoint)]: result });

    } catch (error) {
        const unavailable = isAssessmentRosteringUnavailable(endpoint, error);
        const logLevel = CLIENT_ERROR_CODES.has(error.code) || unavailable ? 'warn' : 'error';
        logger[logLevel]({ endpoint, err: error }, `Error in ${endpoint} one`);

        if (unavailable) {
            return handleAssessmentRosteringUnavailable(res);
        }

        if (error.code === 'AUTH_FILTER_MISSING') {
            return handleMissingAuthFilterError(res, error);
        }

        res.status(500).json({
            imsx_codeMajor: 'failure',
            imsx_severity: 'error',
            imsx_description: 'An internal server error occurred'
        });
    }
}

/**
 * Get OneRoster response wrapper name for single records
 */
function getWrapper(word) {
    if (word=='academicsessions') return 'academicSession';
    if (word=='classes') return 'class';
    //if (word=='demographics') return 'demographics'; // this one is still plural for some reason
    if (word=='gradingPeriod') return 'academicSession';
    if (word=='term') return 'academicSession';
    if (word=='school') return 'org';
    if (word=='student') return 'user';
    if (word=='teacher') return 'user';
    if (word=='assessments') return 'assessment';
    if (word=='assessmentofferings') return 'assessmentOffering';
    if (word=='assessmentenrollments') return 'assessmentEnrollment';
    const endings = { ies: 'y', es: 'e', s: '' };
    return word.replace(
        new RegExp(`(${Object.keys(endings).join('|')})$`),
        r => endings[r]
    );
}

// Collection endpoint exports (many records)
export const academicSessions = async (req, res) => doOneRosterEndpointMany(req, res, 'academicsessions', configs.academicsessions);
export const gradingPeriods = async (req, res) => doOneRosterEndpointMany(req, res, 'academicsessions', configs.academicsessions, "type='gradingPeriod'");
export const terms = async (req, res) => doOneRosterEndpointMany(req, res, 'academicsessions', configs.academicsessions, "type='term'");
export const classes = async (req, res) => doOneRosterEndpointMany(req, res, 'classes', configs.classes);
export const courses = async (req, res) => doOneRosterEndpointMany(req, res, 'courses', configs.courses);
export const demographics = async (req, res) => doOneRosterEndpointMany(req, res, 'demographics', configs.demographics);
export const enrollments = async (req, res) => doOneRosterEndpointMany(req, res, 'enrollments', configs.enrollments);
export const orgs = async (req, res) => doOneRosterEndpointMany(req, res, 'orgs', configs.orgs);
export const schools = async (req, res) => doOneRosterEndpointMany(req, res, 'orgs', configs.orgs, "type='school'");
export const users = async (req, res) => doOneRosterEndpointMany(req, res, 'users', configs.users);
export const students = async (req, res) => doOneRosterEndpointMany(req, res, 'users', configs.users, "role='student'");
export const teachers = async (req, res) => doOneRosterEndpointMany(req, res, 'users', configs.users, "role='teacher'");

// Single record endpoint exports
export const academicSessionsOne = async (req, res) => doOneRosterEndpointOne(req, res, 'academicsessions', configs.academicsessions);
export const gradingPeriodsOne = async (req, res) => doOneRosterEndpointOne(req, res, 'academicsessions', configs.academicsessions, "type='gradingPeriod'");
export const termsOne = async (req, res) => doOneRosterEndpointOne(req, res, 'academicsessions', configs.academicsessions, "type='term'");
export const classesOne = async (req, res) => doOneRosterEndpointOne(req, res, 'classes', configs.classes);
export const coursesOne = async (req, res) => doOneRosterEndpointOne(req, res, 'courses', configs.courses);
export const demographicsOne = async (req, res) => doOneRosterEndpointOne(req, res, 'demographics', configs.demographics);
export const enrollmentsOne = async (req, res) => doOneRosterEndpointOne(req, res, 'enrollments', configs.enrollments);
export const orgsOne = async (req, res) => doOneRosterEndpointOne(req, res, 'orgs', configs.orgs);
export const schoolsOne = async (req, res) => doOneRosterEndpointOne(req, res, 'orgs', configs.orgs, "type='school'");
export const usersOne = async (req, res) => doOneRosterEndpointOne(req, res, 'users', configs.users);
export const studentsOne = async (req, res) => doOneRosterEndpointOne(req, res, 'users', configs.users, "role='student'");
export const teachersOne = async (req, res) => doOneRosterEndpointOne(req, res, 'users', configs.users, "role='teacher'");

// Assessment rostering (mounted only when ASSESSMENT_ROSTERING_ENABLED is true)
const { assessments: ASSESSMENTS, assessmentOfferings: OFFERINGS, assessmentEnrollments: ENROLLMENTS } = ASSESSMENT_ENDPOINTS;

/**
 * A sub-collection: the child rows whose hidden parent column holds the parent's sourcedId.
 * The value is bound, never interpolated into SQL.
 */
function doAssessmentSubCollection(req, res, parentEndpoint, endpoint) {
    const id = req.params.id;
    return doOneRosterEndpointMany(req, res, endpoint, configs[endpoint], { [parentColumns[endpoint]]: id },
        { endpoint: parentEndpoint, id });
}

export const assessments = async (req, res) => doOneRosterEndpointMany(req, res, ASSESSMENTS, configs[ASSESSMENTS]);
export const assessmentOfferings = async (req, res) => doOneRosterEndpointMany(req, res, OFFERINGS, configs[OFFERINGS]);
export const assessmentEnrollments = async (req, res) => doOneRosterEndpointMany(req, res, ENROLLMENTS, configs[ENROLLMENTS]);
export const assessmentsOne = async (req, res) => doOneRosterEndpointOne(req, res, ASSESSMENTS, configs[ASSESSMENTS]);
export const assessmentOfferingsOne = async (req, res) => doOneRosterEndpointOne(req, res, OFFERINGS, configs[OFFERINGS]);
export const assessmentEnrollmentsOne = async (req, res) => doOneRosterEndpointOne(req, res, ENROLLMENTS, configs[ENROLLMENTS]);
export const assessmentOfferingsForAssessment = async (req, res) => doAssessmentSubCollection(req, res, ASSESSMENTS, OFFERINGS);
export const assessmentEnrollmentsForOffering = async (req, res) => doAssessmentSubCollection(req, res, OFFERINGS, ENROLLMENTS);
