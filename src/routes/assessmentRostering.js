// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import express from 'express';
import * as oneRosterController from '../controllers/unified/oneRosterController.js';
import { authorizeEndpoint } from '../middleware/authorizationHandler.js';
import { ASSESSMENT_ROSTERING_BASE_PATH as BASE, ASSESSMENT_ENDPOINTS } from '../config/assessment-rostering.js';

/**
 * Assessment rostering routes, mounted ahead of the rostering router under /ims/oneroster when
 * ASSESSMENT_ROSTERING_ENABLED is true. There is no catch-all here: an unknown path falls
 * through to the rostering router's 404. Every endpoint takes the rostering scopes.
 */
const router = express.Router();

const { assessments, assessmentOfferings, assessmentEnrollments } = ASSESSMENT_ENDPOINTS;

// Sub-collections, authorized as the child resource
router.get(`${BASE}/assessments/:id/assessmentOfferings`, authorizeEndpoint(assessmentOfferings), oneRosterController.assessmentOfferingsForAssessment);
router.get(`${BASE}/assessmentOfferings/:id/assessmentEnrollments`, authorizeEndpoint(assessmentEnrollments), oneRosterController.assessmentEnrollmentsForOffering);

// Single record endpoints
router.get(`${BASE}/assessments/:id`, authorizeEndpoint(assessments), oneRosterController.assessmentsOne);
router.get(`${BASE}/assessmentOfferings/:id`, authorizeEndpoint(assessmentOfferings), oneRosterController.assessmentOfferingsOne);
router.get(`${BASE}/assessmentEnrollments/:id`, authorizeEndpoint(assessmentEnrollments), oneRosterController.assessmentEnrollmentsOne);

// Collection endpoints
router.get(`${BASE}/assessments`, authorizeEndpoint(assessments), oneRosterController.assessments);
router.get(`${BASE}/assessmentOfferings`, authorizeEndpoint(assessmentOfferings), oneRosterController.assessmentOfferings);
router.get(`${BASE}/assessmentEnrollments`, authorizeEndpoint(assessmentEnrollments), oneRosterController.assessmentEnrollments);

export default router;
