// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Synthetic Ed-Fi data for the branches of the oneroster12 projections that the Grand Bend sample never
 * reaches (docs/design/dms-parity-report.md, "What Grand Bend does not exercise"): people at more than
 * one school, suppressed and contact e-mails, unmapped descriptors, school-level student ids,
 * non-Teacher-of-Record positions, several races and SEOAs, birth place, courses owned by an LEA or the
 * state, several school years, calendars and class periods, and a school with no LEA.
 *
 * It also holds the assessment registration data for the assessment rostering projections
 * (docs/design/assessment-rostering-mappings.md): a second district, a testing service center that
 * OneRoster doesn't publish, offerings assigned at each level, several and open-ended testing windows,
 * a student at two schools, and keys with delimiters, mixed case and a non-ASCII character.
 *
 * The data is described once, by natural key. toOdsRows writes it to the ODS/API 7.3 tables and
 * toDmsRows to the DMS relational tables (both PostgreSQL, Data Standard 5.2). Only the tables and
 * columns the projections read are filled, so tests/compare-dms-fixture.js loads the rows with
 * triggers and foreign keys off, in a transaction it rolls back.
 *
 * EXPECTATIONS is what the ODS projections produce from these rows (the reference behavior). The
 * runner checks it on both platforms, so a fixture that stops reaching a branch fails instead of
 * passing on two matching empty results.
 */

import crypto from 'crypto';

const EDFI = 'uri://ed-fi.org';
// No OneRoster descriptor mapping uses this namespace, so its descriptors are unmapped even where the
// code value matches a mapped one.
const UNMAPPED = 'uri://fixture.edfi-oneroster.test';
const descriptor = (type, codeValue, namespace = EDFI) => `${namespace}/${type}#${codeValue}`;

export const SEA = 9900;
export const LEA = 990001;
export const CHARTER_LEA = 990002; // an LEA with no state education agency
export const HIGH = 990001001;
export const MIDDLE = 990001002;
export const LAB = 990009001; // a school with no LEA
// Assessment rostering: LEA is district A (schools HIGH and MIDDLE), LEA_B district B
export const LEA_B = 990003;
export const SCHOOL_B1 = 990003001;
export const SERVICE_CENTER = 990800; // an organization the orgs view doesn't publish

const LAST_MODIFIED = '2026-02-01T08:00:00Z';
// The ODS ranks a staff member's schools by StaffSchoolAssociation createdate and DMS by "DocumentId".
// Both follow the order of FIXTURE.staffSchoolAssociations: ODS createdate counts up
// from here, and DMS DocumentIds are allocated in that order.
const STAFF_SCHOOL_CREATED = Date.parse('2026-01-15T00:00:00Z');

const D = {
  leaCategory: descriptor('LocalEducationAgencyCategoryDescriptor', 'Independent'),
  instructionalDay: descriptor('CalendarEventDescriptor', 'Instructional day'),
  makeUpDay: descriptor('CalendarEventDescriptor', 'Make-up day'),
  lateArrival: descriptor('CalendarEventDescriptor', 'Student late arrival/early dismissal'),
  holiday: descriptor('CalendarEventDescriptor', 'Holiday'),
  fall: descriptor('TermDescriptor', 'Fall Semester'),
  spring: descriptor('TermDescriptor', 'Spring Semester'),
  yearRound: descriptor('TermDescriptor', 'Year Round'),
  unmappedTerm: descriptor('TermDescriptor', 'Fall Semester', UNMAPPED),
  ninthGrade: descriptor('GradeLevelDescriptor', 'Ninth grade'),
  tenthGrade: descriptor('GradeLevelDescriptor', 'Tenth grade'),
  female: descriptor('SexDescriptor', 'Female'),
  unmappedSex: descriptor('SexDescriptor', 'Female', UNMAPPED),
  unitedStates: descriptor('CountryDescriptor', 'US'),
  texas: descriptor('StateAbbreviationDescriptor', 'TX'),
  white: descriptor('RaceDescriptor', 'White'),
  asian: descriptor('RaceDescriptor', 'Asian'),
  black: descriptor('RaceDescriptor', 'Black or African American'),
  unmappedRace: descriptor('RaceDescriptor', 'White', UNMAPPED),
  homeEmail: descriptor('ElectronicMailTypeDescriptor', 'Home/Personal'),
  workEmail: descriptor('ElectronicMailTypeDescriptor', 'Work'),
  otherEmail: descriptor('ElectronicMailTypeDescriptor', 'Other'),
  studentStateId: descriptor('StudentIdentificationSystemDescriptor', 'State'),
  studentDistrictId: descriptor('StudentIdentificationSystemDescriptor', 'District'),
  staffStateId: descriptor('StaffIdentificationSystemDescriptor', 'State'),
  staffDistrictId: descriptor('StaffIdentificationSystemDescriptor', 'District'),
  regularEducation: descriptor('ProgramAssignmentDescriptor', 'Regular Education'),
  principal: descriptor('StaffClassificationDescriptor', 'Principal'),
  teacher: descriptor('StaffClassificationDescriptor', 'Teacher'),
  counselor: descriptor('StaffClassificationDescriptor', 'Counselor'),
  unmappedClassification: descriptor('StaffClassificationDescriptor', 'Teacher', UNMAPPED),
  teacherOfRecord: descriptor('ClassroomPositionDescriptor', 'Teacher of Record'),
  substitute: descriptor('ClassroomPositionDescriptor', 'Substitute Teacher'),
  unmappedPosition: descriptor('ClassroomPositionDescriptor', 'Teacher of Record', UNMAPPED),
  stateAssessment: descriptor('AssessmentCategoryDescriptor', 'State assessment'),
  mathematics: descriptor('AcademicSubjectDescriptor', 'Mathematics'),
  reading: descriptor('AcademicSubjectDescriptor', 'Reading'),
  writing: descriptor('AcademicSubjectDescriptor', 'Writing'),
  computerBased: descriptor('PlatformTypeDescriptor', 'Computer-based')
};

const FX_ASSESSMENT = 'uri://fixture.edfi-oneroster.test/Assessment';

/** { namespace, codeValue, type } of a descriptor URI such as uri://ed-fi.org/RaceDescriptor#White. */
export function parseDescriptorUri(uri) {
  const hash = uri.lastIndexOf('#');
  const namespace = uri.slice(0, hash);
  return { namespace, codeValue: uri.slice(hash + 1), type: namespace.slice(namespace.lastIndexOf('/') + 1) };
}

export const FIXTURE = {
  stateEducationAgencies: [{ id: SEA, name: 'Fixture State Education Agency' }],
  localEducationAgencies: [
    { id: LEA, name: 'Fixture Unified School District', sea: SEA, category: D.leaCategory },
    { id: CHARTER_LEA, name: 'Fixture Charter District', sea: null, category: D.leaCategory },
    { id: LEA_B, name: 'Fixture Second District', sea: SEA, category: D.leaCategory }
  ],
  educationServiceCenters: [{ id: SERVICE_CENTER, name: 'Fixture Testing Service Center' }],
  schools: [
    { id: HIGH, name: 'Fixture High School', lea: LEA },
    { id: MIDDLE, name: 'Fixture Middle School', lea: LEA },
    { id: LAB, name: 'Fixture Lab School', lea: null },
    { id: SCHOOL_B1, name: 'Fixture B1 School', lea: LEA_B }
  ],

  // Instructional days per school and year span every calendar the school has; the LEA's school year
  // takes the modal first and last day across its schools (a tie takes the earliest).
  calendarDates: [
    { school: HIGH, year: 2026, calendar: 'HS-MAIN', date: '2025-08-15', events: [D.holiday] },
    { school: HIGH, year: 2026, calendar: 'HS-MAIN', date: '2025-08-18', events: [D.instructionalDay, D.holiday] },
    { school: HIGH, year: 2026, calendar: 'HS-MAIN', date: '2026-05-29', events: [D.instructionalDay] },
    { school: HIGH, year: 2026, calendar: 'HS-MAIN', date: '2026-06-05', events: [D.holiday] },
    { school: HIGH, year: 2026, calendar: 'HS-ALT', date: '2025-08-11', events: [D.makeUpDay] },
    { school: MIDDLE, year: 2026, calendar: 'MS-MAIN', date: '2025-08-13', events: [D.instructionalDay] },
    { school: MIDDLE, year: 2026, calendar: 'MS-MAIN', date: '2026-06-02', events: [D.lateArrival] },
    { school: HIGH, year: 2025, calendar: 'HS-MAIN', date: '2024-08-19', events: [D.instructionalDay] },
    { school: HIGH, year: 2025, calendar: 'HS-MAIN', date: '2025-05-30', events: [D.instructionalDay] },
    { school: LAB, year: 2026, calendar: 'LAB', date: '2025-09-02', events: [D.instructionalDay] },
    { school: LAB, year: 2026, calendar: 'LAB', date: '2026-06-12', events: [D.instructionalDay] }
  ],
  sessions: [
    // mixed case: session sourcedIds keep the name as is, class sourcedIds lower-case it
    { key: 'hs-fall-2026', school: HIGH, year: 2026, name: 'FALL Semester 2025', term: D.fall, begin: '2025-08-11', end: '2025-12-19', days: 82 },
    { key: 'hs-spring-2026', school: HIGH, year: 2026, name: 'Spring Semester 2026', term: D.spring, begin: '2026-01-05', end: '2026-05-29', days: 95, lastModified: '2026-02-02T09:30:00Z' },
    // unmapped term: no academic session of its own, but the latest change to the LEA's 2026 sessions
    { key: 'hs-unmapped-2026', school: HIGH, year: 2026, name: 'Fixture Term 2026', term: D.unmappedTerm, begin: '2025-08-11', end: '2026-05-29', days: 177, lastModified: '2026-02-05T12:00:00Z' },
    { key: 'ms-fall-2026', school: MIDDLE, year: 2026, name: 'FALL Semester 2025', term: D.fall, begin: '2025-08-13', end: '2025-12-19', days: 80 },
    { key: 'hs-fall-2025', school: HIGH, year: 2025, name: 'Fall Semester 2024', term: D.fall, begin: '2024-08-19', end: '2024-12-20', days: 84, lastModified: '2025-01-10T10:00:00Z' },
    { key: 'lab-year-2026', school: LAB, year: 2026, name: 'Full Year 2026', term: D.yearRound, begin: '2025-09-02', end: '2026-06-12', days: 175 }
  ],
  courses: [
    { key: 'lea-algebra', org: LEA, code: 'ALG-1', title: 'Algebra I' },
    { key: 'school-biology', org: HIGH, code: 'BIO-1', title: 'Biology' },
    { key: 'state-cs', org: SEA, code: 'CS-1', title: 'Computer Science Principles' },
    { key: 'charter-algebra', org: CHARTER_LEA, code: 'ALG-1', title: 'Algebra I (Charter)' },
    { key: 'lab-art', org: LAB, code: 'ART-1', title: 'Studio Art' }
  ],
  // An offering's school is its session's school.
  courseOfferings: [
    { key: 'algebra-2026', localCode: 'Alg-1A', session: 'hs-fall-2026', course: 'lea-algebra', title: 'Algebra I, Block Schedule' },
    { key: 'algebra-2025', localCode: 'Alg-1A', session: 'hs-fall-2025', course: 'lea-algebra', title: null },
    { key: 'biology-2026', localCode: 'BIO-1', session: 'hs-spring-2026', course: 'school-biology', title: 'Biology' },
    { key: 'cs-2026', localCode: 'CS-1', session: 'ms-fall-2026', course: 'state-cs', title: 'CS Principles' },
    { key: 'art-2026', localCode: 'ART-1', session: 'lab-year-2026', course: 'lab-art', title: 'Studio Art' }
  ],
  sections: [
    { key: 'algebra-2026', offering: 'algebra-2026', id: 'Sec-01', room: 'Room 101', periods: ['Period 2', 'Period 1'] },
    { key: 'algebra-2025', offering: 'algebra-2025', id: 'Sec-01' },
    { key: 'biology-2026', offering: 'biology-2026', id: 'BIO-1-01', periods: ['Period 3'] },
    { key: 'cs-2026', offering: 'cs-2026', id: 'CS-01' },
    { key: 'art-2026', offering: 'art-2026', id: 'ART-01' }
  ],

  students: [
    { uniqueId: 'FX-STU-1', firstName: 'Ana', lastName: 'Alvarez', middleName: 'Beatriz', preferredFirstName: 'Annie', birthDate: '2010-03-04', sex: D.female, country: D.unitedStates, state: D.texas, city: 'Austin' },
    { uniqueId: 'FX-STU-2', firstName: 'Ben', lastName: 'Brown', preferredLastName: 'Browne', birthDate: '2010-07-08', sex: D.unmappedSex },
    { uniqueId: 'FX-STU-3', firstName: 'Cara', lastName: 'Chen', birthDate: '2011-01-15' },
    { uniqueId: 'FX-STU-4', firstName: 'Dev', lastName: 'Diaz', birthDate: '2010-11-30' },
    { uniqueId: 'FX-STU-5', firstName: 'Eve', lastName: 'Evans', birthDate: '2012-02-29' },
    { uniqueId: 'FX-STU-6', firstName: 'Fay', lastName: 'Fox', birthDate: '2010-05-05' },
    { uniqueId: 'FX-STU-7', firstName: 'Gus', lastName: 'Gray', birthDate: '2010-06-06' }
  ],
  studentSchoolAssociations: [
    // FX-STU-1: two schools, no primary flag; the later entry is primary
    { student: 'FX-STU-1', school: HIGH, entryDate: '2024-08-19', exitDate: '2025-06-01', grade: D.ninthGrade },
    { student: 'FX-STU-1', school: MIDDLE, entryDate: '2025-08-11', grade: D.tenthGrade },
    // FX-STU-2: the primary flag beats the later entry
    { student: 'FX-STU-2', school: HIGH, entryDate: '2024-08-19', primary: true, grade: D.ninthGrade },
    { student: 'FX-STU-2', school: MIDDLE, entryDate: '2025-01-06', primary: false, grade: D.ninthGrade },
    // FX-STU-3: re-enrolled at one school; one user row, one role, the latest grade
    { student: 'FX-STU-3', school: HIGH, entryDate: '2024-08-19', exitDate: '2024-12-20', grade: D.ninthGrade },
    { student: 'FX-STU-3', school: HIGH, entryDate: '2025-01-06', grade: D.tenthGrade },
    // FX-STU-4: same entry date at two schools; the lower schoolId is primary, the higher grade code wins
    { student: 'FX-STU-4', school: HIGH, entryDate: '2025-08-11', grade: D.ninthGrade },
    { student: 'FX-STU-4', school: MIDDLE, entryDate: '2025-08-11', grade: D.tenthGrade },
    // FX-STU-5: no school
    // FX-STU-6: district B only; FX-STU-7: one school in each district
    { student: 'FX-STU-6', school: SCHOOL_B1, entryDate: '2025-08-11', grade: D.tenthGrade },
    { student: 'FX-STU-7', school: HIGH, entryDate: '2025-08-11', grade: D.tenthGrade },
    { student: 'FX-STU-7', school: SCHOOL_B1, entryDate: '2025-08-12', grade: D.tenthGrade }
  ],
  studentEducationOrganizationAssociations: [
    {
      student: 'FX-STU-1', org: HIGH, hispanic: false, races: [D.asian],
      emails: [
        { type: D.homeEmail, address: 'ana.home@example.com', doNotPublish: true, primary: true },
        { type: D.workEmail, address: 'ana.work@example.com', doNotPublish: false }
      ],
      ids: [{ system: D.studentStateId, code: 'ST-1001' }, { system: D.studentDistrictId, code: 'GB-1001' }]
    },
    // LEA-level: races and ethnicity count, the id never reaches userIds
    { student: 'FX-STU-1', org: LEA, hispanic: true, races: [D.white, D.black], ids: [{ system: D.studentStateId, code: 'ST-LEA-1001' }], lastModified: '2026-02-03T08:00:00Z' },
    { student: 'FX-STU-2', org: HIGH, hispanic: null, races: [D.unmappedRace], emails: [{ type: D.homeEmail, address: 'ben.home@example.com', doNotPublish: true }] },
    { student: 'FX-STU-3', org: HIGH, hispanic: false, races: [D.white] },
    // a school the student isn't enrolled at still supplies the e-mail and the latest change
    { student: 'FX-STU-3', org: MIDDLE, hispanic: false, races: [D.white], emails: [{ type: D.otherEmail, address: 'cara.other@example.com', doNotPublish: null }], lastModified: '2026-02-04T08:00:00Z' },
    {
      student: 'FX-STU-4', org: HIGH, hispanic: true,
      emails: [
        { type: D.otherEmail, address: 'dev.other@example.com', doNotPublish: false },
        { type: D.homeEmail, address: 'dev.home@example.com', doNotPublish: false }
      ],
      ids: [{ system: D.studentDistrictId, code: 'GB-1004' }]
    },
    // assessment registrations reference these
    { student: 'FX-STU-6', org: LEA_B, hispanic: false },
    { student: 'FX-STU-7', org: LEA, hispanic: false }
  ],
  studentSectionAssociations: [
    { student: 'FX-STU-1', section: 'algebra-2026', begin: '2025-08-11' },
    { student: 'FX-STU-1', section: 'cs-2026', begin: '2025-08-11', end: '2025-12-19' },
    { student: 'FX-STU-3', section: 'algebra-2025', begin: '2024-08-19', end: '2024-12-20' },
    { student: 'FX-STU-3', section: 'algebra-2026', begin: '2025-08-11' },
    { student: 'FX-STU-4', section: 'biology-2026', begin: '2026-01-05' }
  ],

  staff: [
    {
      uniqueId: 'FX-STA-1', firstName: 'Tom', lastName: 'Taylor', middleName: 'Lee',
      ids: [{ system: D.staffStateId, code: 'STF-1' }, { system: D.staffDistrictId, code: 'GB-T1' }],
      emails: [
        { type: D.workEmail, address: 'tom.work@example.com', doNotPublish: true },
        { type: D.homeEmail, address: 'tom.home@example.com', doNotPublish: false }
      ]
    },
    { uniqueId: 'FX-STA-2', firstName: 'Una', lastName: 'Underwood', preferredFirstName: 'Uno', emails: [{ type: D.homeEmail, address: 'una.home@example.com' }] },
    { uniqueId: 'FX-STA-3', firstName: 'Vic', lastName: 'Vance', emails: [{ type: D.workEmail, address: 'vic at example', doNotPublish: null }] },
    { uniqueId: 'FX-STA-4', firstName: 'Wes', lastName: 'West' },
    { uniqueId: 'FX-STA-5', firstName: 'Xia', lastName: 'Xu' }
  ],
  // In creation order: a staff member's latest school is primary.
  staffSchoolAssociations: [
    { staff: 'FX-STA-1', school: HIGH },
    { staff: 'FX-STA-1', school: MIDDLE },
    { staff: 'FX-STA-2', school: HIGH },
    { staff: 'FX-STA-3', school: MIDDLE },
    { staff: 'FX-STA-3', school: HIGH },
    { staff: 'FX-STA-5', school: LAB }
  ],
  staffAssignments: [
    // a school-level classification wins over the LEA-level one at that school only
    { staff: 'FX-STA-1', org: HIGH, classification: D.principal, begin: '2025-07-01' },
    { staff: 'FX-STA-1', org: LEA, classification: D.teacher, begin: '2025-07-01' },
    { staff: 'FX-STA-2', org: HIGH, classification: D.unmappedClassification, begin: '2025-07-01' },
    { staff: 'FX-STA-4', org: LEA, classification: D.counselor, begin: '2025-07-01' },
    { staff: 'FX-STA-5', org: LAB, classification: D.counselor, begin: '2025-07-01' }
  ],
  staffContacts: [
    { staff: 'FX-STA-2', org: HIGH, title: 'Work', address: 'una.work@example.com' },
    { staff: 'FX-STA-4', org: LEA, title: 'Other', address: 'wes@example.com' }
  ],
  staffSectionAssociations: [
    { staff: 'FX-STA-1', section: 'algebra-2026', position: D.teacherOfRecord, begin: '2025-08-11' },
    { staff: 'FX-STA-1', section: 'cs-2026', position: D.unmappedPosition, begin: '2025-08-11' },
    { staff: 'FX-STA-2', section: 'biology-2026', position: D.substitute, begin: '2026-01-05', end: '2026-03-01' },
    { staff: 'FX-STA-5', section: 'art-2026', position: D.teacherOfRecord, begin: '2025-09-02' }
  ],

  contacts: [
    {
      uniqueId: 'FX-CON-1', firstName: 'Pat', lastName: 'Parker',
      emails: [
        { type: D.homeEmail, address: 'zed@example.com', primary: true, doNotPublish: false },
        { type: D.workEmail, address: 'amy@example.com', primary: true, doNotPublish: true },
        { type: D.otherEmail, address: 'bob@example.com', primary: false, doNotPublish: false },
        { type: D.workEmail, address: 'kim@example.com', primary: true, doNotPublish: false }
      ]
    },
    {
      // a null indicator excludes the address on both sides of the filter
      uniqueId: 'FX-CON-2', firstName: 'Quinn', lastName: 'Quill',
      emails: [
        { type: D.homeEmail, address: 'quinn@example.com', primary: null, doNotPublish: false },
        { type: D.workEmail, address: 'quinn.work@example.com', primary: true, doNotPublish: null }
      ]
    },
    { uniqueId: 'FX-CON-3', firstName: 'Rae', lastName: 'Ross' },
    { uniqueId: 'FX-CON-4', firstName: 'Sam', lastName: 'Stone' }
  ],
  studentContactAssociations: [
    { contact: 'FX-CON-1', student: 'FX-STU-1' },
    { contact: 'FX-CON-1', student: 'FX-STU-4' },
    { contact: 'FX-CON-2', student: 'FX-STU-2' },
    { contact: 'FX-CON-4', student: 'FX-STU-5' }
  ],

  // Assessment registration. Keys are natural keys; offerings name their assessment by key.
  assessments: [
    // no defining org: visible to every caller; several subjects and grades
    {
      key: 'math', namespace: FX_ASSESSMENT, identifier: 'FX-Math', title: 'Fixture Mathematics', version: 2,
      category: D.stateAssessment, subjects: [D.reading, D.mathematics], grades: [D.tenthGrade, D.ninthGrade],
      family: 'Fixture Family', form: 'Form A', revisionDate: '2025-07-01', adaptive: true
    },
    // defined by an organization OneRoster doesn't publish: no org reference, id in metadata
    { key: 'science', namespace: FX_ASSESSMENT, identifier: 'FX-Science', title: 'Fixture Science', definingOrg: SERVICE_CENTER },
    // defined by district B, never offered: visible up and down district B only
    { key: 'writing', namespace: FX_ASSESSMENT, identifier: 'FX-Writing', title: 'Fixture Writing', definingOrg: LEA_B, subjects: [D.writing] },
    // these two keys collide when lower-cased parts are joined with '-' (sourcedId 953301f4...)
    { key: 'collision-a', namespace: 'uri://example.org/Assessment', identifier: 'TEST-PART1', title: 'Collision A' },
    { key: 'collision-b', namespace: 'uri://example.org/Assessment-TEST', identifier: 'PART1', title: 'Collision B' },
    // backslash, pipe, hyphen, mixed case and a non-ASCII character; a title that looks like JSON
    { key: 'escapes', namespace: FX_ASSESSMENT, identifier: 'Esc\\Back|Pipe-Ñu', title: '[Pilot]' }
  ],
  assessmentAdministrations: [
    // O1: assigned by the state; several windows, the last open-ended; participation changed later
    {
      key: 'O1', assessment: 'math', assigning: SEA, identifier: 'Spring Window|A',
      periods: [{ begin: '2026-04-01', end: '2026-04-02' }, { begin: '2026-03-01', end: '2026-03-05' }, { begin: '2026-05-01', end: null }],
      participating: [{ org: LEA_B, lastModified: '2026-02-06T10:00:00Z' }, { org: LEA }]
    },
    // O2: assigned by district A, no windows
    { key: 'O2', assessment: 'math', assigning: LEA, identifier: 'District Retest', periods: [], participating: [{ org: HIGH }] },
    // O3: assigned by the service center, no participation; reachable only through its registration school
    { key: 'O3', assessment: 'science', assigning: SERVICE_CENTER, identifier: 'Vendor Sitting', periods: [{ begin: '2026-02-10', end: '2026-02-10' }], participating: [] },
    // O4: assigned by district B with district A taking part; no registrations
    { key: 'O4', assessment: 'math', assigning: LEA_B, identifier: 'B Sitting', periods: [{ begin: '2026-03-15', end: '2026-03-20' }], participating: [{ org: LEA }] }
  ],
  studentAssessmentRegistrations: [
    { administration: 'O1', student: 'FX-STU-1', school: HIGH, org: LEA, grade: D.tenthGrade, platform: D.computerBased, lastModified: '2026-02-07T09:00:00Z' },
    { administration: 'O1', student: 'FX-STU-6', school: SCHOOL_B1, org: LEA_B },
    { administration: 'O2', student: 'FX-STU-1', school: HIGH, org: LEA },
    // the testing organization (district A) must not widen access; the reporting one isn't published
    { administration: 'O3', student: 'FX-STU-6', school: SCHOOL_B1, org: LEA_B, testingOrg: LEA, reportingOrg: SERVICE_CENTER },
    // FX-STU-7 is at a district B school too, but registered through district A: district B can't see it
    { administration: 'O1', student: 'FX-STU-7', school: HIGH, org: LEA }
  ]
};

/** Every descriptor URI the fixture and the writers use. */
export function fixtureDescriptors(fixture = FIXTURE) {
  const uris = new Set([D.regularEducation]);
  const walk = value => {
    if (typeof value === 'string' && value.includes('Descriptor#')) uris.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(fixture);
  return [...uris].sort();
}

// --- Writers -------------------------------------------------------------------------------------
// Each returns [{ table, values }] in load order. A descriptor value is { $descriptor: uri }, which
// the loader resolves to that platform's id. alloc() returns unused ids (USIs on the ODS,
// DocumentIds on DMS).

const descriptorValue = uri => (uri == null ? null : { $descriptor: uri });
const byKey = (records, field = 'key') => new Map(records.map(record => [record[field], record]));

function sectionIdentity(fixture) {
  const sessions = byKey(fixture.sessions);
  const offerings = byKey(fixture.courseOfferings);
  const sections = byKey(fixture.sections);
  return key => {
    const section = sections.get(key);
    const offering = offerings.get(section.offering);
    const session = sessions.get(offering.session);
    return { localCourseCode: offering.localCode, schoolId: session.school, schoolYear: session.year, sessionName: session.name, sectionIdentifier: section.id };
  };
}

export function toOdsRows(fixture, alloc) {
  const rows = [];
  const add = (table, values) => rows.push({ table: `edfi.${table}`, values });
  const audit = record => ({ createdate: record.lastModified ?? LAST_MODIFIED, lastmodifieddate: record.lastModified ?? LAST_MODIFIED });
  const d = descriptorValue;
  const sessions = byKey(fixture.sessions);
  const courses = byKey(fixture.courses);
  const section = sectionIdentity(fixture);
  const sectionKey = key => {
    const s = section(key);
    return { localcoursecode: s.localCourseCode, schoolid: s.schoolId, schoolyear: s.schoolYear, sessionname: s.sessionName, sectionidentifier: s.sectionIdentifier };
  };
  const usi = { student: new Map(), staff: new Map(), contact: new Map() };

  const educationOrganization = (org, discriminator) =>
    add('educationorganization', { educationorganizationid: org.id, nameofinstitution: org.name, discriminator, ...audit(org) });
  for (const sea of fixture.stateEducationAgencies) {
    educationOrganization(sea, 'edfi.StateEducationAgency');
    add('stateeducationagency', { stateeducationagencyid: sea.id });
  }
  for (const lea of fixture.localEducationAgencies) {
    educationOrganization(lea, 'edfi.LocalEducationAgency');
    add('localeducationagency', { localeducationagencyid: lea.id, stateeducationagencyid: lea.sea, localeducationagencycategorydescriptorid: d(lea.category) });
  }
  for (const school of fixture.schools) {
    educationOrganization(school, 'edfi.School');
    add('school', { schoolid: school.id, localeducationagencyid: school.lea });
  }
  for (const center of fixture.educationServiceCenters ?? []) {
    educationOrganization(center, 'edfi.EducationServiceCenter');
    add('educationservicecenter', { educationservicecenterid: center.id });
  }

  for (const day of fixture.calendarDates) {
    const key = { calendarcode: day.calendar, date: day.date, schoolid: day.school, schoolyear: day.year };
    add('calendardate', { ...key, ...audit(day) });
    for (const event of day.events) add('calendardatecalendarevent', { ...key, calendareventdescriptorid: d(event) });
  }
  for (const session of fixture.sessions) {
    add('session', {
      schoolid: session.school, schoolyear: session.year, sessionname: session.name, termdescriptorid: d(session.term),
      begindate: session.begin, enddate: session.end, totalinstructionaldays: session.days, ...audit(session)
    });
  }
  for (const course of fixture.courses) {
    add('course', { coursecode: course.code, educationorganizationid: course.org, coursetitle: course.title, numberofparts: 1, ...audit(course) });
  }
  for (const offering of fixture.courseOfferings) {
    const session = sessions.get(offering.session);
    const course = courses.get(offering.course);
    add('courseoffering', {
      localcoursecode: offering.localCode, schoolid: session.school, schoolyear: session.year, sessionname: session.name,
      coursecode: course.code, educationorganizationid: course.org, localcoursetitle: offering.title, ...audit(offering)
    });
  }
  for (const s of fixture.sections) {
    const key = sectionKey(s.key);
    add('section', {
      ...key, locationclassroomidentificationcode: s.room ?? null, locationschoolid: s.room ? key.schoolid : null, ...audit(s)
    });
    for (const period of s.periods ?? []) add('sectionclassperiod', { ...key, classperiodname: period });
  }

  for (const student of fixture.students) {
    usi.student.set(student.uniqueId, alloc());
    add('student', {
      studentusi: usi.student.get(student.uniqueId), studentuniqueid: student.uniqueId,
      firstname: student.firstName, lastsurname: student.lastName, middlename: student.middleName ?? null,
      preferredfirstname: student.preferredFirstName ?? null, preferredlastsurname: student.preferredLastName ?? null,
      birthdate: student.birthDate, birthsexdescriptorid: d(student.sex), birthcountrydescriptorid: d(student.country),
      birthstateabbreviationdescriptorid: d(student.state), birthcity: student.city ?? null, ...audit(student)
    });
  }
  for (const ssa of fixture.studentSchoolAssociations) {
    add('studentschoolassociation', {
      studentusi: usi.student.get(ssa.student), schoolid: ssa.school, entrydate: ssa.entryDate, exitwithdrawdate: ssa.exitDate ?? null,
      primaryschool: ssa.primary ?? null, entrygradeleveldescriptorid: d(ssa.grade), ...audit(ssa)
    });
  }
  for (const seoa of fixture.studentEducationOrganizationAssociations) {
    const key = { educationorganizationid: seoa.org, studentusi: usi.student.get(seoa.student) };
    add('studenteducationorganizationassociation', { ...key, hispaniclatinoethnicity: seoa.hispanic, ...audit(seoa) });
    for (const race of seoa.races ?? []) add('studenteducationorganizationassociationrace', { ...key, racedescriptorid: d(race) });
    for (const email of seoa.emails ?? []) {
      add('studenteducationorganizationassociationelectronicmail', {
        ...key, electronicmailaddress: email.address, electronicmailtypedescriptorid: d(email.type),
        donotpublishindicator: email.doNotPublish ?? null, primaryemailaddressindicator: email.primary ?? null
      });
    }
    for (const id of seoa.ids ?? []) {
      add('studenteducationorganizationassociationstudentidentifica_c15030', {
        ...key, assigningorganizationidentificationcode: 'FX', studentidentificationsystemdescriptorid: d(id.system), identificationcode: id.code
      });
    }
  }
  for (const ssa of fixture.studentSectionAssociations) {
    add('studentsectionassociation', {
      ...sectionKey(ssa.section), studentusi: usi.student.get(ssa.student), begindate: ssa.begin, enddate: ssa.end ?? null, ...audit(ssa)
    });
  }

  for (const staff of fixture.staff) {
    usi.staff.set(staff.uniqueId, alloc());
    const staffusi = usi.staff.get(staff.uniqueId);
    add('staff', {
      staffusi, staffuniqueid: staff.uniqueId, firstname: staff.firstName, lastsurname: staff.lastName,
      middlename: staff.middleName ?? null, preferredfirstname: staff.preferredFirstName ?? null,
      preferredlastsurname: staff.preferredLastName ?? null, ...audit(staff)
    });
    for (const id of staff.ids ?? []) {
      add('staffidentificationcode', { staffusi, staffidentificationsystemdescriptorid: d(id.system), identificationcode: id.code });
    }
    for (const email of staff.emails ?? []) {
      add('staffelectronicmail', {
        staffusi, electronicmailaddress: email.address, electronicmailtypedescriptorid: d(email.type),
        donotpublishindicator: email.doNotPublish ?? null, primaryemailaddressindicator: email.primary ?? null
      });
    }
  }
  fixture.staffSchoolAssociations.forEach((ssa, index) => {
    add('staffschoolassociation', {
      staffusi: usi.staff.get(ssa.staff), schoolid: ssa.school, programassignmentdescriptorid: d(D.regularEducation),
      createdate: new Date(STAFF_SCHOOL_CREATED + index * 1000).toISOString(), lastmodifieddate: LAST_MODIFIED
    });
  });
  for (const assignment of fixture.staffAssignments) {
    add('staffeducationorganizationassignmentassociation', {
      staffusi: usi.staff.get(assignment.staff), educationorganizationid: assignment.org,
      staffclassificationdescriptorid: d(assignment.classification), begindate: assignment.begin, ...audit(assignment)
    });
  }
  for (const contact of fixture.staffContacts) {
    add('staffeducationorganizationcontactassociation', {
      staffusi: usi.staff.get(contact.staff), educationorganizationid: contact.org, contacttitle: contact.title,
      electronicmailaddress: contact.address, ...audit(contact)
    });
  }
  for (const ssa of fixture.staffSectionAssociations) {
    add('staffsectionassociation', {
      ...sectionKey(ssa.section), staffusi: usi.staff.get(ssa.staff), classroompositiondescriptorid: d(ssa.position),
      begindate: ssa.begin, enddate: ssa.end ?? null, ...audit(ssa)
    });
  }

  for (const contact of fixture.contacts) {
    usi.contact.set(contact.uniqueId, alloc());
    const contactusi = usi.contact.get(contact.uniqueId);
    add('contact', {
      contactusi, contactuniqueid: contact.uniqueId, firstname: contact.firstName, lastsurname: contact.lastName,
      middlename: contact.middleName ?? null, preferredfirstname: contact.preferredFirstName ?? null,
      preferredlastsurname: contact.preferredLastName ?? null, ...audit(contact)
    });
    for (const email of contact.emails ?? []) {
      add('contactelectronicmail', {
        contactusi, electronicmailaddress: email.address, electronicmailtypedescriptorid: d(email.type),
        donotpublishindicator: email.doNotPublish ?? null, primaryemailaddressindicator: email.primary ?? null
      });
    }
  }
  for (const sca of fixture.studentContactAssociations) {
    add('studentcontactassociation', { contactusi: usi.contact.get(sca.contact), studentusi: usi.student.get(sca.student), ...audit(sca) });
  }

  const assessments = byKey(fixture.assessments ?? []);
  const administrations = byKey(fixture.assessmentAdministrations ?? []);
  for (const a of fixture.assessments ?? []) {
    const key = { namespace: a.namespace, assessmentidentifier: a.identifier };
    add('assessment', {
      ...key, assessmenttitle: a.title, assessmentversion: a.version ?? null, assessmentcategorydescriptorid: d(a.category),
      educationorganizationid: a.definingOrg ?? null, assessmentfamily: a.family ?? null, assessmentform: a.form ?? null,
      revisiondate: a.revisionDate ?? null, adaptiveassessment: a.adaptive ?? null, ...audit(a)
    });
    for (const subject of a.subjects ?? []) add('assessmentacademicsubject', { ...key, academicsubjectdescriptorid: d(subject) });
    for (const grade of a.grades ?? []) add('assessmentassessedgradelevel', { ...key, gradeleveldescriptorid: d(grade) });
  }
  const administrationKey = key => {
    const aa = administrations.get(key);
    const a = assessments.get(aa.assessment);
    return { namespace: a.namespace, assessmentidentifier: a.identifier, assigningeducationorganizationid: aa.assigning, administrationidentifier: aa.identifier };
  };
  for (const aa of fixture.assessmentAdministrations ?? []) {
    const key = administrationKey(aa.key);
    add('assessmentadministration', { ...key, ...audit(aa) });
    for (const period of aa.periods) add('assessmentadministrationperiod', { ...key, begindate: period.begin, enddate: period.end });
    for (const p of aa.participating) add('assessmentadministrationparticipation', { ...key, participatingeducationorganizationid: p.org, ...audit(p) });
  }
  for (const r of fixture.studentAssessmentRegistrations ?? []) {
    const ssa = fixture.studentSchoolAssociations.find(candidate => candidate.student === r.student && candidate.school === r.school);
    add('studentassessmentregistration', {
      ...administrationKey(r.administration), educationorganizationid: r.org, studentusi: usi.student.get(r.student),
      schoolid: r.school, entrydate: ssa.entryDate, assessmentgradeleveldescriptorid: d(r.grade), platformtypedescriptorid: d(r.platform),
      testingeducationorganizationid: r.testingOrg ?? null, reportingeducationorganizationid: r.reportingOrg ?? null, ...audit(r)
    });
  }

  return rows;
}

/**
 * The ed-org hierarchy rows the triggers would write for the fixture's organizations (the load runs with
 * triggers off): each organization to itself, and each SEA and LEA to everything under it. The
 * projections don't read them; the assessment authorization matrix does.
 */
export function hierarchyPairs(fixture = FIXTURE) {
  const pairs = [];
  const leasOf = sea => fixture.localEducationAgencies.filter(lea => lea.sea === sea).map(lea => lea.id);
  const schoolsOf = lea => fixture.schools.filter(school => school.lea === lea).map(school => school.id);
  for (const org of [...fixture.stateEducationAgencies, ...fixture.localEducationAgencies, ...fixture.schools, ...(fixture.educationServiceCenters ?? [])]) {
    pairs.push([org.id, org.id]);
  }
  for (const sea of fixture.stateEducationAgencies) {
    for (const lea of leasOf(sea.id)) {
      pairs.push([sea.id, lea]);
      for (const school of schoolsOf(lea)) pairs.push([sea.id, school]);
    }
  }
  for (const lea of fixture.localEducationAgencies) {
    for (const school of schoolsOf(lea.id)) pairs.push([lea.id, school]);
  }
  return pairs;
}

export const toOdsHierarchyRows = (fixture = FIXTURE) => hierarchyPairs(fixture).map(([source, target]) => ({
  table: 'auth.educationorganizationidtoeducationorganizationid',
  values: { sourceeducationorganizationid: source, targeteducationorganizationid: target }
}));

export const toDmsHierarchyRows = (fixture = FIXTURE) => hierarchyPairs(fixture).map(([source, target]) => ({
  table: 'auth.EducationOrganizationIdToEducationOrganizationId',
  values: { SourceEducationOrganizationId: source, TargetEducationOrganizationId: target }
}));

const STUDENT_IDENTIFICATION_CODES = '{{table:Ed-Fi/StudentEducationOrganizationAssociation/$.studentIdentificationCodes[*]}}';

export function toDmsRows(fixture, alloc) {
  const rows = [];
  const add = (table, values) => rows.push({ table: table.startsWith('{{') ? table : `edfi.${table}`, values });
  const modified = record => ({ ContentLastModifiedAt: record.lastModified ?? LAST_MODIFIED });
  const d = descriptorValue;
  // DocumentIds by document, allocated on first use. Referenced documents the projections don't
  // read (school years, calendars, class periods, locations) get an id but no row.
  const documents = new Map();
  const doc = key => {
    if (!documents.has(key)) documents.set(key, alloc());
    return documents.get(key);
  };
  const edorg = id => doc(`edorg:${id}`);
  const sessions = byKey(fixture.sessions);
  const courses = byKey(fixture.courses);
  const offerings = byKey(fixture.courseOfferings);
  const section = sectionIdentity(fixture);
  const sectionReference = key => {
    const s = section(key);
    return {
      Section_DocumentId: doc(`section:${key}`), Section_LocalCourseCode: s.localCourseCode, Section_SchoolId: s.schoolId,
      Section_SchoolYear: s.schoolYear, Section_SessionName: s.sessionName, Section_SectionIdentifier: s.sectionIdentifier
    };
  };
  const student = uniqueId => ({ Student_DocumentId: doc(`student:${uniqueId}`), Student_StudentUniqueId: uniqueId });

  for (const sea of fixture.stateEducationAgencies) {
    add('StateEducationAgency', { DocumentId: edorg(sea.id), StateEducationAgencyId: sea.id, NameOfInstitution: sea.name, ...modified(sea) });
  }
  for (const lea of fixture.localEducationAgencies) {
    add('LocalEducationAgency', {
      DocumentId: edorg(lea.id), LocalEducationAgencyId: lea.id, NameOfInstitution: lea.name,
      LocalEducationAgencyCategoryDescriptor_DescriptorId: d(lea.category),
      StateEducationAgency_DocumentId: lea.sea == null ? null : edorg(lea.sea), StateEducationAgency_StateEducationAgencyId: lea.sea,
      ...modified(lea)
    });
  }
  for (const school of fixture.schools) {
    add('School', {
      DocumentId: edorg(school.id), SchoolId: school.id, NameOfInstitution: school.name,
      LocalEducationAgency_DocumentId: school.lea == null ? null : edorg(school.lea), LocalEducationAgency_LocalEducationAgencyId: school.lea,
      ...modified(school)
    });
  }
  for (const center of fixture.educationServiceCenters ?? []) {
    add('EducationServiceCenter', { DocumentId: edorg(center.id), EducationServiceCenterId: center.id, NameOfInstitution: center.name, ...modified(center) });
  }

  for (const day of fixture.calendarDates) {
    const calendar = `${day.school}:${day.year}:${day.calendar}`;
    const documentId = doc(`calendarDate:${calendar}:${day.date}`);
    add('CalendarDate', {
      DocumentId: documentId, Calendar_DocumentId: doc(`calendar:${calendar}`), Calendar_CalendarCode: day.calendar,
      Calendar_SchoolId: day.school, Calendar_SchoolYear: day.year, Date: day.date, ...modified(day)
    });
    day.events.forEach((event, index) => {
      add('CalendarDateCalendarEvent', { CalendarDate_DocumentId: documentId, Ordinal: index, CalendarEventDescriptor_DescriptorId: d(event) });
    });
  }
  for (const session of fixture.sessions) {
    add('Session', {
      DocumentId: doc(`session:${session.key}`), SchoolYear_DocumentId: doc(`schoolYear:${session.year}`), SchoolYear_SchoolYear: session.year,
      School_DocumentId: edorg(session.school), School_SchoolId: session.school, TermDescriptor_DescriptorId: d(session.term),
      BeginDate: session.begin, EndDate: session.end, SessionName: session.name, TotalInstructionalDays: session.days, ...modified(session)
    });
  }
  for (const course of fixture.courses) {
    add('Course', {
      DocumentId: doc(`course:${course.key}`), EducationOrganization_DocumentId: edorg(course.org),
      EducationOrganization_EducationOrganizationId: course.org, CourseCode: course.code, CourseTitle: course.title, NumberOfParts: 1,
      ...modified(course)
    });
  }
  for (const offering of fixture.courseOfferings) {
    const session = sessions.get(offering.session);
    const course = courses.get(offering.course);
    add('CourseOffering', {
      DocumentId: doc(`offering:${offering.key}`), SchoolId_Unified: session.school,
      Course_DocumentId: doc(`course:${course.key}`), Course_CourseCode: course.code, Course_EducationOrganizationId: course.org,
      School_DocumentId: edorg(session.school), Session_DocumentId: doc(`session:${session.key}`),
      Session_SchoolYear: session.year, Session_SessionName: session.name,
      LocalCourseCode: offering.localCode, LocalCourseTitle: offering.title, ...modified(offering)
    });
  }
  for (const s of fixture.sections) {
    const offering = offerings.get(s.offering);
    const session = sessions.get(offering.session);
    const location = s.room
      ? {
        LocationLocation_DocumentId: doc(`location:${session.school}:${s.room}`), LocationLocation_ClassroomIdentificationCode: s.room,
        LocationSchool_DocumentId: edorg(session.school), SchoolId_U35501e03_Unified: session.school
      }
      : {};
    add('Section', {
      DocumentId: doc(`section:${s.key}`), SchoolId_Unified: session.school, CourseOffering_DocumentId: doc(`offering:${offering.key}`),
      CourseOffering_LocalCourseCode: offering.localCode, CourseOffering_SchoolYear: session.year,
      CourseOffering_SessionName: session.name, SectionIdentifier: s.id, ...location, ...modified(s)
    });
    (s.periods ?? []).forEach((period, index) => {
      add('SectionClassPeriod', {
        Section_DocumentId: doc(`section:${s.key}`), Ordinal: index, ClassPeriod_DocumentId: doc(`classPeriod:${session.school}:${period}`),
        ClassPeriod_ClassPeriodName: period, ClassPeriod_SchoolId: session.school
      });
    });
  }

  for (const s of fixture.students) {
    add('Student', {
      DocumentId: doc(`student:${s.uniqueId}`), StudentUniqueId: s.uniqueId, FirstName: s.firstName, LastSurname: s.lastName,
      MiddleName: s.middleName ?? null, PreferredFirstName: s.preferredFirstName ?? null, PreferredLastSurname: s.preferredLastName ?? null,
      BirthDate: s.birthDate, BirthSexDescriptor_DescriptorId: d(s.sex), BirthCountryDescriptor_DescriptorId: d(s.country),
      BirthStateAbbreviationDescriptor_DescriptorId: d(s.state), BirthCity: s.city ?? null, ...modified(s)
    });
  }
  for (const ssa of fixture.studentSchoolAssociations) {
    add('StudentSchoolAssociation', {
      DocumentId: doc(`ssa:${ssa.student}:${ssa.school}:${ssa.entryDate}`), SchoolId_Unified: ssa.school, School_DocumentId: edorg(ssa.school), ...student(ssa.student),
      EntryDate: ssa.entryDate, ExitWithdrawDate: ssa.exitDate ?? null, PrimarySchool: ssa.primary ?? null,
      EntryGradeLevelDescriptor_DescriptorId: d(ssa.grade), ...modified(ssa)
    });
  }
  for (const seoa of fixture.studentEducationOrganizationAssociations) {
    const documentId = doc(`seoa:${seoa.student}:${seoa.org}`);
    add('StudentEducationOrganizationAssociation', {
      DocumentId: documentId, EducationOrganization_DocumentId: edorg(seoa.org), EducationOrganization_EducationOrganizationId: seoa.org,
      ...student(seoa.student), HispanicLatinoEthnicity: seoa.hispanic, ...modified(seoa)
    });
    const parent = { StudentEducationOrganizationAssociation_DocumentId: documentId };
    (seoa.races ?? []).forEach((race, index) => {
      add('StudentEducationOrganizationAssociationRace', { ...parent, Ordinal: index, RaceDescriptor_DescriptorId: d(race) });
    });
    (seoa.emails ?? []).forEach((email, index) => {
      add('StudentEducationOrganizationAssociationElectronicMail', {
        ...parent, Ordinal: index, ElectronicMailTypeDescriptor_DescriptorId: d(email.type), ElectronicMailAddress: email.address,
        DoNotPublishIndicator: email.doNotPublish ?? null, PrimaryEmailAddressIndicator: email.primary ?? null
      });
    });
    (seoa.ids ?? []).forEach((id, index) => {
      add(STUDENT_IDENTIFICATION_CODES, {
        ...parent, Ordinal: index, StudentIdentificationSystemDescriptor_DescriptorId: d(id.system),
        AssigningOrganizationIdentificationCode: 'FX', IdentificationCode: id.code
      });
    });
  }
  for (const ssa of fixture.studentSectionAssociations) {
    add('StudentSectionAssociation', {
      DocumentId: alloc(), ...sectionReference(ssa.section), ...student(ssa.student), BeginDate: ssa.begin, EndDate: ssa.end ?? null,
      ...modified(ssa)
    });
  }

  for (const s of fixture.staff) {
    const documentId = doc(`staff:${s.uniqueId}`);
    add('Staff', {
      DocumentId: documentId, StaffUniqueId: s.uniqueId, FirstName: s.firstName, LastSurname: s.lastName,
      MiddleName: s.middleName ?? null, PreferredFirstName: s.preferredFirstName ?? null, PreferredLastSurname: s.preferredLastName ?? null,
      ...modified(s)
    });
    (s.ids ?? []).forEach((id, index) => {
      add('StaffIdentificationCode', {
        Staff_DocumentId: documentId, Ordinal: index, StaffIdentificationSystemDescriptor_DescriptorId: d(id.system), IdentificationCode: id.code
      });
    });
    (s.emails ?? []).forEach((email, index) => {
      add('StaffElectronicMail', {
        Staff_DocumentId: documentId, Ordinal: index, ElectronicMailTypeDescriptor_DescriptorId: d(email.type),
        ElectronicMailAddress: email.address, DoNotPublishIndicator: email.doNotPublish ?? null, PrimaryEmailAddressIndicator: email.primary ?? null
      });
    });
  }
  for (const ssa of fixture.staffSchoolAssociations) {
    add('StaffSchoolAssociation', {
      DocumentId: alloc(), SchoolId_Unified: ssa.school, School_DocumentId: edorg(ssa.school),
      Staff_DocumentId: doc(`staff:${ssa.staff}`), Staff_StaffUniqueId: ssa.staff,
      ProgramAssignmentDescriptor_DescriptorId: d(D.regularEducation), ContentLastModifiedAt: LAST_MODIFIED
    });
  }
  for (const assignment of fixture.staffAssignments) {
    add('StaffEducationOrganizationAssignmentAssociation', {
      DocumentId: alloc(), StaffUniqueId_Unified: assignment.staff, Staff_DocumentId: doc(`staff:${assignment.staff}`),
      EducationOrganization_DocumentId: edorg(assignment.org), EducationOrganization_EducationOrganizationId: assignment.org,
      StaffClassificationDescriptor_DescriptorId: d(assignment.classification), BeginDate: assignment.begin, ...modified(assignment)
    });
  }
  for (const contact of fixture.staffContacts) {
    add('StaffEducationOrganizationContactAssociation', {
      DocumentId: alloc(), Staff_DocumentId: doc(`staff:${contact.staff}`), Staff_StaffUniqueId: contact.staff,
      EducationOrganization_DocumentId: edorg(contact.org), EducationOrganization_EducationOrganizationId: contact.org,
      ContactTitle: contact.title, ElectronicMailAddress: contact.address, ...modified(contact)
    });
  }
  for (const ssa of fixture.staffSectionAssociations) {
    add('StaffSectionAssociation', {
      DocumentId: alloc(), ...sectionReference(ssa.section), Staff_DocumentId: doc(`staff:${ssa.staff}`), Staff_StaffUniqueId: ssa.staff,
      ClassroomPositionDescriptor_DescriptorId: d(ssa.position), BeginDate: ssa.begin, EndDate: ssa.end ?? null, ...modified(ssa)
    });
  }

  for (const c of fixture.contacts) {
    const documentId = doc(`contact:${c.uniqueId}`);
    add('Contact', {
      DocumentId: documentId, ContactUniqueId: c.uniqueId, FirstName: c.firstName, LastSurname: c.lastName,
      MiddleName: c.middleName ?? null, PreferredFirstName: c.preferredFirstName ?? null, PreferredLastSurname: c.preferredLastName ?? null,
      ...modified(c)
    });
    (c.emails ?? []).forEach((email, index) => {
      add('ContactElectronicMail', {
        Contact_DocumentId: documentId, Ordinal: index, ElectronicMailTypeDescriptor_DescriptorId: d(email.type),
        ElectronicMailAddress: email.address, DoNotPublishIndicator: email.doNotPublish ?? null, PrimaryEmailAddressIndicator: email.primary ?? null
      });
    });
  }
  for (const sca of fixture.studentContactAssociations) {
    add('StudentContactAssociation', {
      DocumentId: alloc(), Contact_DocumentId: doc(`contact:${sca.contact}`), Contact_ContactUniqueId: sca.contact,
      ...student(sca.student), ...modified(sca)
    });
  }

  const assessments = byKey(fixture.assessments ?? []);
  const administrations = byKey(fixture.assessmentAdministrations ?? []);
  for (const a of fixture.assessments ?? []) {
    const documentId = doc(`assessment:${a.key}`);
    add('Assessment', {
      DocumentId: documentId, Namespace: a.namespace, AssessmentIdentifier: a.identifier, AssessmentTitle: a.title,
      AssessmentVersion: a.version ?? null, AssessmentCategoryDescriptor_DescriptorId: d(a.category),
      EducationOrganization_DocumentId: a.definingOrg == null ? null : edorg(a.definingOrg), EducationOrganization_EducationOrganizationId: a.definingOrg ?? null,
      AssessmentFamily: a.family ?? null, AssessmentForm: a.form ?? null, RevisionDate: a.revisionDate ?? null,
      AdaptiveAssessment: a.adaptive ?? null, ...modified(a)
    });
    (a.subjects ?? []).forEach((subject, index) => {
      add('AssessmentAcademicSubject', { Assessment_DocumentId: documentId, Ordinal: index, AcademicSubjectDescriptor_DescriptorId: d(subject) });
    });
    (a.grades ?? []).forEach((grade, index) => {
      add('AssessmentAssessedGradeLevel', { Assessment_DocumentId: documentId, Ordinal: index, GradeLevelDescriptor_DescriptorId: d(grade) });
    });
  }
  const administrationReference = key => {
    const aa = administrations.get(key);
    const a = assessments.get(aa.assessment);
    return {
      AssessmentAdministration_DocumentId: doc(`administration:${key}`), AssessmentAdministration_AdministrationIdentifier: aa.identifier,
      AssessmentAdministration_AssessmentIdentifier: a.identifier, AssessmentAdministration_Namespace: a.namespace,
      AssessmentAdministration_AssigningEducationOrganizationId: aa.assigning
    };
  };
  for (const aa of fixture.assessmentAdministrations ?? []) {
    const a = assessments.get(aa.assessment);
    const documentId = doc(`administration:${aa.key}`);
    add('AssessmentAdministration', {
      DocumentId: documentId, Assessment_DocumentId: doc(`assessment:${a.key}`), Assessment_AssessmentIdentifier: a.identifier,
      Assessment_Namespace: a.namespace, AssigningEducationOrganization_DocumentId: edorg(aa.assigning),
      AssigningEducationOrganization_EducationOrganizationId: aa.assigning, AdministrationIdentifier: aa.identifier, ...modified(aa)
    });
    aa.periods.forEach((period, index) => {
      add('AssessmentAdministrationPeriod', {
        AssessmentAdministration_DocumentId: documentId, Ordinal: index,
        AssessmentAdministrationBeginDate: period.begin, AssessmentAdministrationEndDate: period.end
      });
    });
    for (const p of aa.participating) {
      add('AssessmentAdministrationParticipation', {
        DocumentId: alloc(), ...administrationReference(aa.key), ParticipatingEducationOrganization_DocumentId: edorg(p.org),
        ParticipatingEducationOrganization_EducationOrganizationId: p.org, ...modified(p)
      });
    }
  }
  for (const r of fixture.studentAssessmentRegistrations ?? []) {
    const ssa = fixture.studentSchoolAssociations.find(candidate => candidate.student === r.student && candidate.school === r.school);
    add('StudentAssessmentRegistration', {
      DocumentId: alloc(), StudentUniqueId_Unified: r.student, ...administrationReference(r.administration),
      StudentEducationOrganizationAssociation_DocumentId: doc(`seoa:${r.student}:${r.org}`),
      StudentEducationOrganizationAssociation_EducationOrganizationId: r.org,
      StudentSchoolAssociation_DocumentId: doc(`ssa:${r.student}:${r.school}:${ssa.entryDate}`),
      StudentSchoolAssociation_EntryDate: ssa.entryDate, StudentSchoolAssociation_SchoolId: r.school,
      TestingEducationOrganization_DocumentId: r.testingOrg == null ? null : edorg(r.testingOrg),
      TestingEducationOrganization_EducationOrganizationId: r.testingOrg ?? null,
      ReportingEducationOrganization_DocumentId: r.reportingOrg == null ? null : edorg(r.reportingOrg),
      ReportingEducationOrganization_EducationOrganizationId: r.reportingOrg ?? null,
      AssessmentGradeLevelDescriptor_DescriptorId: d(r.grade), PlatformTypeDescriptor_DescriptorId: d(r.platform), ...modified(r)
    });
  }

  return rows;
}

// --- Expected projection rows (ODS behavior) ------------------------------------------------------

export const md5 = text => crypto.createHash('md5').update(text).digest('hex');
const orgRef = id => ({ href: `/orgs/${md5(String(id))}`, sourcedId: md5(String(id)), type: 'org' });
const yearId = (lea, year) => md5(`${lea ?? ''}-${year}`);
const yearRef = (lea, year) => ({ href: `/academicSessions/${yearId(lea, year)}`, sourcedId: yearId(lea, year), type: 'academicSession' });
const termId = (school, year, name) => md5(`${school}-${year}-${name}`);
const courseRef = (org, code) => ({ href: `/courses/${md5(`${org}-${code}`)}`, sourcedId: md5(`${org}-${code}`), type: 'course' });
const classId = (code, school, year, section, session) => md5([code.toLowerCase(), school, year, section.toLowerCase(), session.toLowerCase()].join('-'));
const userRef = key => ({ href: `/users/${md5(key)}`, sourcedId: md5(key), type: 'user' });
const role = (roleType, roleName, school) => ({ roleType, role: roleName, org: orgRef(school) });
const userId = (type, identifier) => ({ type, identifier });
const at = iso => new Date(iso);

const ALGEBRA_2026 = classId('Alg-1A', HIGH, 2026, 'Sec-01', 'FALL Semester 2025');
const CS_2026 = classId('CS-1', MIDDLE, 2026, 'CS-01', 'FALL Semester 2025');
const BIOLOGY_2026 = classId('BIO-1', HIGH, 2026, 'BIO-1-01', 'Spring Semester 2026');
const ART_2026 = classId('ART-1', LAB, 2026, 'ART-01', 'Full Year 2026');
const staffEnrollmentId = (staff, code, school, year, section, session, begin) =>
  md5(['STA', staff.toLowerCase(), code.toLowerCase(), school, year, section.toLowerCase(), session.toLowerCase(), begin].join('-'));
const studentEnrollmentId = (student, code, school, year, section, session, begin) =>
  md5([student.toLowerCase(), code.toLowerCase(), school, year, section.toLowerCase(), session.toLowerCase(), begin].join('-'));

// Assessment rostering sourcedIds: key parts lower-cased, '\\' and '|' escaped, joined with '|'
const k = text => text.toLowerCase().replaceAll('\\', '\\\\').replaceAll('|', '\\|');
export const assessmentId = (namespace, identifier) => md5(`${k(namespace)}|${k(identifier)}`);
export const offeringId = (namespace, identifier, assigning, administration) =>
  md5(`${k(namespace)}|${k(identifier)}|${assigning}|${k(administration)}`);
export const assessmentEnrollmentId = (namespace, identifier, assigning, administration, org, student) =>
  md5(`${k(namespace)}|${k(identifier)}|${assigning}|${k(administration)}|${org}|${k(student)}`);

const MATH = assessmentId(FX_ASSESSMENT, 'FX-Math');
const SCIENCE = assessmentId(FX_ASSESSMENT, 'FX-Science');
const WRITING = assessmentId(FX_ASSESSMENT, 'FX-Writing');
const COLLISION_A = assessmentId('uri://example.org/Assessment', 'TEST-PART1');
const COLLISION_B = assessmentId('uri://example.org/Assessment-TEST', 'PART1');
const ESCAPES = assessmentId(FX_ASSESSMENT, 'Esc\\Back|Pipe-Ñu');
const O1 = offeringId(FX_ASSESSMENT, 'FX-Math', SEA, 'Spring Window|A');
const O2 = offeringId(FX_ASSESSMENT, 'FX-Math', LEA, 'District Retest');
const O3 = offeringId(FX_ASSESSMENT, 'FX-Science', SERVICE_CENTER, 'Vendor Sitting');
const O4 = offeringId(FX_ASSESSMENT, 'FX-Math', LEA_B, 'B Sitting');
const R1 = assessmentEnrollmentId(FX_ASSESSMENT, 'FX-Math', SEA, 'Spring Window|A', LEA, 'FX-STU-1');
const R2 = assessmentEnrollmentId(FX_ASSESSMENT, 'FX-Math', SEA, 'Spring Window|A', LEA_B, 'FX-STU-6');
const R3 = assessmentEnrollmentId(FX_ASSESSMENT, 'FX-Math', LEA, 'District Retest', LEA, 'FX-STU-1');
const R4 = assessmentEnrollmentId(FX_ASSESSMENT, 'FX-Science', SERVICE_CENTER, 'Vendor Sitting', LEA_B, 'FX-STU-6');
const R5 = assessmentEnrollmentId(FX_ASSESSMENT, 'FX-Math', SEA, 'Spring Window|A', LEA, 'FX-STU-7');
const assessmentRef = id => ({ href: `/assessments/${id}`, sourcedId: id, type: 'assessment' });
// assessmentauthorgs rows have a key for the parity tools, not a OneRoster id
const authOrgId = (assessment, offering, org, orgRole) => md5(`${assessment}|${offering ?? ''}|${org}|${orgRole}`);
const offeringRef = id => ({ href: `/assessmentOfferings/${id}`, sourcedId: id, type: 'assessmentOffering' });

/** Rows each projection gains from the fixture. */
export const EXPECTED_COUNTS = {
  orgs: 8, // 1 SEA, 3 LEAs, 4 schools (the service center isn't published)
  academicsessions: 8, // 3 school years (LEA 2025 and 2026, no-LEA 2026) and 5 mapped terms
  courses: 5,
  classes: 5,
  users: 22, // 11 student rows (one per school), 7 staff rows, 4 contacts
  enrollments: 9,
  demographics: 11,
  assessments: 6,
  assessmentofferings: 4,
  assessmentenrollments: 5,
  assessmentauthorgs: 14 // 2 defining, 4 assigning, 4 participating, 4 registration schools
};

/**
 * Expected values by projection: { view, key, values } where key is the text the sourcedId hashes,
 * or { view, key, absent: true }. Columns in `unordered` hold arrays whose order the SQL leaves open.
 */
export const EXPECTATIONS = [
  { view: 'orgs', key: String(SEA), values: { type: 'state', parent: null, children: [orgRef(LEA), orgRef(LEA_B)] }, unordered: ['children'] },
  { view: 'orgs', key: String(SCHOOL_B1), values: { type: 'school', parent: orgRef(LEA_B) } },
  { view: 'orgs', key: String(SERVICE_CENTER), absent: true },
  { view: 'orgs', key: String(LEA), values: { type: 'district', parent: orgRef(SEA), children: [orgRef(HIGH), orgRef(MIDDLE)] }, unordered: ['children'] },
  { view: 'orgs', key: String(CHARTER_LEA), values: { parent: null, children: null } },
  { view: 'orgs', key: String(HIGH), values: { type: 'school', name: 'Fixture High School', identifier: String(HIGH), parent: orgRef(LEA), children: null } },
  { view: 'orgs', key: String(LAB), values: { type: 'school', parent: null } },

  {
    view: 'academicsessions', key: `${LEA}-2026`,
    values: { type: 'schoolYear', title: '2025-2026', startDate: '2025-08-11', endDate: '2026-05-29', schoolYear: '2026', educationOrganizationId: String(LEA), dateLastModified: at('2026-02-05T12:00:00Z') }
  },
  { view: 'academicsessions', key: `${LEA}-2025`, values: { startDate: '2024-08-19', endDate: '2025-05-30', dateLastModified: at('2025-01-10T10:00:00Z') } },
  { view: 'academicsessions', key: '-2026', values: { type: 'schoolYear', startDate: '2025-09-02', endDate: '2026-06-12', educationOrganizationId: null, dateLastModified: null } },
  {
    view: 'academicsessions', key: `${HIGH}-2026-FALL Semester 2025`,
    values: { title: 'Fall Semester', type: 'semester', startDate: '2025-08-11', endDate: '2025-12-19', parent: yearRef(LEA, 2026), schoolYear: '2026', educationOrganizationId: String(HIGH) }
  },
  { view: 'academicsessions', key: `${HIGH}-2026-Fixture Term 2026`, absent: true },
  { view: 'academicsessions', key: `${LAB}-2026-Full Year 2026`, values: { type: 'schoolYear', title: 'Year Round', parent: yearRef(null, 2026) } },

  { view: 'courses', key: `${LEA}-ALG-1`, values: { title: 'Algebra I', schoolYear: yearRef(LEA, 2026), org: orgRef(LEA), educationOrganizationId: String(LEA) } },
  { view: 'courses', key: `${HIGH}-BIO-1`, values: { schoolYear: yearRef(LEA, 2026) } },
  { view: 'courses', key: `${SEA}-CS-1`, values: { schoolYear: null, org: orgRef(SEA) } },
  { view: 'courses', key: `${CHARTER_LEA}-ALG-1`, values: { schoolYear: null } },
  { view: 'courses', key: `${LAB}-ART-1`, values: { schoolYear: null } },

  {
    view: 'classes', id: ALGEBRA_2026,
    values: {
      title: 'Algebra I, Block Schedule', classCode: 'Alg-1A', location: 'Room 101', periods: ['Period 1', 'Period 2'],
      course: courseRef(LEA, 'ALG-1'), school: orgRef(HIGH),
      terms: [{ href: `/academicSessions/${termId(HIGH, 2026, 'FALL Semester 2025')}`, sourcedId: termId(HIGH, 2026, 'FALL Semester 2025'), type: 'academicSession' }]
    }
  },
  { view: 'classes', id: classId('Alg-1A', HIGH, 2025, 'Sec-01', 'Fall Semester 2024'), values: { title: '', location: null, periods: null } },
  { view: 'classes', id: BIOLOGY_2026, values: { periods: ['Period 3'], course: courseRef(HIGH, 'BIO-1') } },

  {
    view: 'users', key: `STU-FX-STU-1-${HIGH}`,
    values: {
      educationOrganizationId: String(HIGH), email: 'ana.work@example.com', username: 'ana.work@example.com', grades: ['Tenth grade'],
      givenName: 'Ana', middleName: 'Beatriz', preferredFirstName: 'Annie', preferredLastName: null,
      userIds: [userId('studentUniqueId', 'FX-STU-1'), userId('District', 'GB-1001'), userId('State', 'ST-1001')],
      roles: [role('secondary', 'student', HIGH), role('primary', 'student', MIDDLE)]
    },
    unordered: ['roles']
  },
  { view: 'users', key: `STU-FX-STU-1-${MIDDLE}`, values: { educationOrganizationId: String(MIDDLE), userIds: [userId('studentUniqueId', 'FX-STU-1')] } },
  {
    view: 'users', key: `STU-FX-STU-2-${HIGH}`,
    values: { email: null, username: '', preferredLastName: 'Browne', grades: ['Ninth grade'], roles: [role('primary', 'student', HIGH), role('secondary', 'student', MIDDLE)] },
    unordered: ['roles']
  },
  { view: 'users', key: `STU-FX-STU-3-${HIGH}`, values: { email: 'cara.other@example.com', grades: ['Tenth grade'], roles: [role('primary', 'student', HIGH)] } },
  { view: 'users', key: `STU-FX-STU-3-${MIDDLE}`, absent: true },
  {
    view: 'users', key: `STU-FX-STU-4-${HIGH}`,
    values: {
      email: 'dev.home@example.com', grades: ['Tenth grade'],
      userIds: [userId('studentUniqueId', 'FX-STU-4'), userId('District', 'GB-1004')],
      roles: [role('primary', 'student', HIGH), role('secondary', 'student', MIDDLE)]
    },
    unordered: ['roles']
  },
  { view: 'users', key: 'STU-FX-STU-5', values: { educationOrganizationId: null, roles: null, grades: [null], userIds: [userId('studentUniqueId', 'FX-STU-5')] } },
  {
    view: 'users', key: `STA-FX-STA-1-${HIGH}`,
    values: {
      role: 'principal', email: 'tom.home@example.com', middleName: 'Lee',
      userIds: [userId('staffUniqueId', 'FX-STA-1'), userId('District', 'GB-T1'), userId('State', 'STF-1')],
      roles: [role('secondary', 'principal', HIGH), role('primary', 'teacher', MIDDLE)]
    },
    unordered: ['roles']
  },
  { view: 'users', key: `STA-FX-STA-1-${MIDDLE}`, values: { role: 'principal', educationOrganizationId: String(MIDDLE) } },
  { view: 'users', key: `STA-FX-STA-2-${HIGH}`, values: { role: 'teacher', email: 'una.work@example.com', preferredFirstName: 'Uno', roles: [role('primary', null, HIGH)] } },
  {
    view: 'users', key: `STA-FX-STA-3-${HIGH}`,
    values: { role: null, email: 'vic at example', username: 'vic at example', roles: [role('primary', null, HIGH), role('secondary', null, MIDDLE)] },
    unordered: ['roles']
  },
  { view: 'users', key: 'STA-FX-STA-4', values: { role: null, roles: null, educationOrganizationId: null, email: 'wes@example.com' } },
  { view: 'users', key: `STA-FX-STA-5-${LAB}`, values: { role: 'counselor', roles: [role('primary', 'counselor', LAB)] } },
  {
    view: 'users', key: `PAR-FX-CON-1-${HIGH}`,
    values: { role: 'parent', email: 'kim@example.com', educationOrganizationId: String(HIGH), roles: [role('primary', 'parent', HIGH), role('primary', 'parent', MIDDLE)] },
    unordered: ['roles']
  },
  { view: 'users', key: `PAR-FX-CON-1-${MIDDLE}`, absent: true },
  { view: 'users', key: `PAR-FX-CON-2-${MIDDLE}`, values: { email: null, username: '', roles: [role('primary', 'parent', MIDDLE), role('primary', 'parent', HIGH)] }, unordered: ['roles'] },
  { view: 'users', key: 'PAR-FX-CON-3', values: { roles: null, educationOrganizationId: null } },
  { view: 'users', key: 'PAR-FX-CON-4', values: { roles: null, educationOrganizationId: null } },

  {
    view: 'enrollments', id: staffEnrollmentId('FX-STA-1', 'Alg-1A', HIGH, 2026, 'Sec-01', 'FALL Semester 2025', '2025-08-11'),
    values: { role: 'teacher', primary: 'true', beginDate: '2025-08-11', endDate: null, user: userRef(`STA-FX-STA-1-${HIGH}`), class: { href: `/classes/${ALGEBRA_2026}`, sourcedId: ALGEBRA_2026, type: 'class' } }
  },
  { view: 'enrollments', id: staffEnrollmentId('FX-STA-1', 'CS-1', MIDDLE, 2026, 'CS-01', 'FALL Semester 2025', '2025-08-11'), values: { primary: 'false', user: userRef(`STA-FX-STA-1-${MIDDLE}`) } },
  { view: 'enrollments', id: staffEnrollmentId('FX-STA-2', 'BIO-1', HIGH, 2026, 'BIO-1-01', 'Spring Semester 2026', '2026-01-05'), values: { primary: 'false', endDate: '2026-03-01' } },
  { view: 'enrollments', id: staffEnrollmentId('FX-STA-5', 'ART-1', LAB, 2026, 'ART-01', 'Full Year 2026', '2025-09-02'), values: { primary: 'true', educationOrganizationId: String(LAB) } },
  { view: 'enrollments', id: studentEnrollmentId('FX-STU-1', 'CS-1', MIDDLE, 2026, 'CS-01', 'FALL Semester 2025', '2025-08-11'), values: { role: 'student', primary: 'false', endDate: '2025-12-19', class: { href: `/classes/${CS_2026}`, sourcedId: CS_2026, type: 'class' } } },
  { view: 'enrollments', id: studentEnrollmentId('FX-STU-4', 'BIO-1', HIGH, 2026, 'BIO-1-01', 'Spring Semester 2026', '2026-01-05'), values: { user: userRef(`STU-FX-STU-4-${HIGH}`), class: { href: `/classes/${BIOLOGY_2026}`, sourcedId: BIOLOGY_2026, type: 'class' } } },
  { view: 'enrollments', id: studentEnrollmentId('FX-STU-3', 'Alg-1A', HIGH, 2025, 'Sec-01', 'Fall Semester 2024', '2024-08-19'), values: { endDate: '2024-12-20' } },

  {
    view: 'demographics', key: `STU-FX-STU-1-${HIGH}`,
    values: {
      birthDate: '2010-03-04', sex: 'female', americanIndianOrAlaskaNative: 'false', asian: 'true', blackOrAfricanAmerican: 'true',
      nativeHawaiianOrOtherPacificIslander: 'false', white: 'true', demographicRaceTwoOrMoreRaces: 'true', hispanicOrLatinoEthnicity: 'true',
      countryOfBirthCode: 'US', stateOfBirthAbbreviation: 'TX', cityOfBirth: 'Austin', dateLastModified: at('2026-02-03T08:00:00Z')
    }
  },
  {
    view: 'demographics', key: `STU-FX-STU-2-${MIDDLE}`,
    values: { sex: null, white: 'false', demographicRaceTwoOrMoreRaces: 'false', hispanicOrLatinoEthnicity: 'false', countryOfBirthCode: null, cityOfBirth: null }
  },
  { view: 'demographics', key: `STU-FX-STU-3-${HIGH}`, values: { white: 'true', asian: 'false', demographicRaceTwoOrMoreRaces: 'false', hispanicOrLatinoEthnicity: 'false', dateLastModified: at('2026-02-04T08:00:00Z') } },
  { view: 'demographics', key: `STU-FX-STU-4-${MIDDLE}`, values: { white: 'false', demographicRaceTwoOrMoreRaces: 'false', hispanicOrLatinoEthnicity: 'true' } },
  { view: 'demographics', key: 'STU-FX-STU-5', values: { educationOrganizationId: null, hispanicOrLatinoEthnicity: 'false', dateLastModified: at(LAST_MODIFIED) } },

  {
    view: 'assessments', id: MATH,
    values: {
      title: 'Fixture Mathematics', identifier: 'FX-Math', version: '2', category: 'State assessment',
      subjects: ['Mathematics', 'Reading'], grades: ['Ninth grade', 'Tenth grade'], org: null, course: null,
      definingEducationOrganizationId: null, dateLastModified: at(LAST_MODIFIED),
      metadata: {
        edfi: {
          resource: 'assessments', naturalKey: { namespace: FX_ASSESSMENT, assessmentIdentifier: 'FX-Math' },
          assessmentFamily: 'Fixture Family', assessmentForm: 'Form A', revisionDate: '2025-07-01', adaptiveAssessment: true
        }
      }
    }
  },
  {
    view: 'assessments', id: SCIENCE,
    values: {
      org: null, subjects: [], grades: [], category: null, version: null, definingEducationOrganizationId: String(SERVICE_CENTER),
      metadata: { edfi: { resource: 'assessments', naturalKey: { namespace: FX_ASSESSMENT, assessmentIdentifier: 'FX-Science' }, educationOrganizationId: SERVICE_CENTER } }
    }
  },
  { view: 'assessments', id: WRITING, values: { org: orgRef(LEA_B), subjects: ['Writing'], definingEducationOrganizationId: String(LEA_B) } },
  { view: 'assessments', id: COLLISION_A, values: { title: 'Collision A', identifier: 'TEST-PART1' } },
  { view: 'assessments', id: COLLISION_B, values: { title: 'Collision B', identifier: 'PART1' } },
  { view: 'assessments', id: ESCAPES, values: { title: '[Pilot]', identifier: 'Esc\\Back|Pipe-Ñu' } },

  {
    view: 'assessmentofferings', id: O1,
    values: {
      title: 'Spring Window|A', assessment: assessmentRef(MATH), org: orgRef(SEA), assessmentSourcedId: MATH,
      testingWindows: [
        { startDate: '2026-03-01', endDate: '2026-03-05' },
        { startDate: '2026-04-01', endDate: '2026-04-02' },
        { startDate: '2026-05-01', endDate: null }
      ],
      class: null, academicSession: null,
      // the later participation change
      dateLastModified: at('2026-02-06T10:00:00Z'),
      metadata: {
        edfi: {
          resource: 'assessmentAdministrations',
          naturalKey: { namespace: FX_ASSESSMENT, assessmentIdentifier: 'FX-Math', assigningEducationOrganizationId: SEA, administrationIdentifier: 'Spring Window|A' },
          participatingEducationOrganizations: [
            { educationOrganizationId: LEA, org: orgRef(LEA) },
            { educationOrganizationId: LEA_B, org: orgRef(LEA_B) }
          ]
        }
      }
    }
  },
  { view: 'assessmentofferings', id: O2, values: { org: orgRef(LEA), testingWindows: [], dateLastModified: at(LAST_MODIFIED) } },
  {
    view: 'assessmentofferings', id: O3,
    values: {
      org: null, assessment: assessmentRef(SCIENCE), testingWindows: [{ startDate: '2026-02-10', endDate: '2026-02-10' }],
      metadata: {
        edfi: {
          resource: 'assessmentAdministrations',
          naturalKey: { namespace: FX_ASSESSMENT, assessmentIdentifier: 'FX-Science', assigningEducationOrganizationId: SERVICE_CENTER, administrationIdentifier: 'Vendor Sitting' }
        }
      }
    }
  },
  { view: 'assessmentofferings', id: O4, values: { org: orgRef(LEA_B), assessmentSourcedId: MATH } },

  {
    view: 'assessmentenrollments', id: R1,
    values: {
      user: userRef(`STU-FX-STU-1-${HIGH}`), school: orgRef(HIGH), assessmentOffering: offeringRef(O1), role: 'student',
      beginDate: null, endDate: null, educationOrganizationId: String(HIGH), assessmentOfferingSourcedId: O1,
      dateLastModified: at('2026-02-07T09:00:00Z'),
      metadata: {
        edfi: {
          resource: 'studentAssessmentRegistrations',
          naturalKey: {
            namespace: FX_ASSESSMENT, assessmentIdentifier: 'FX-Math', assigningEducationOrganizationId: SEA,
            administrationIdentifier: 'Spring Window|A', educationOrganizationId: LEA, studentUniqueId: 'FX-STU-1'
          },
          assessmentGradeLevel: 'Tenth grade', platformType: 'Computer-based'
        }
      }
    }
  },
  { view: 'assessmentenrollments', id: R2, values: { user: userRef(`STU-FX-STU-6-${SCHOOL_B1}`), school: orgRef(SCHOOL_B1), educationOrganizationId: String(SCHOOL_B1) } },
  { view: 'assessmentenrollments', id: R3, values: { assessmentOffering: offeringRef(O2), assessmentOfferingSourcedId: O2 } },
  {
    view: 'assessmentenrollments', id: R4,
    values: {
      assessmentOffering: offeringRef(O3),
      metadata: {
        edfi: {
          resource: 'studentAssessmentRegistrations',
          naturalKey: {
            namespace: FX_ASSESSMENT, assessmentIdentifier: 'FX-Science', assigningEducationOrganizationId: SERVICE_CENTER,
            administrationIdentifier: 'Vendor Sitting', educationOrganizationId: LEA_B, studentUniqueId: 'FX-STU-6'
          },
          testingEducationOrganization: { educationOrganizationId: LEA, org: orgRef(LEA) },
          reportingEducationOrganization: { educationOrganizationId: SERVICE_CENTER }
        }
      }
    }
  },
  { view: 'assessmentenrollments', id: R5, values: { user: userRef(`STU-FX-STU-7-${HIGH}`), school: orgRef(HIGH) } },

  {
    view: 'assessmentauthorgs', id: authOrgId(SCIENCE, null, SERVICE_CENTER, 'defining'),
    values: { assessmentSourcedId: SCIENCE, assessmentOfferingSourcedId: null, educationOrganizationId: String(SERVICE_CENTER), orgRole: 'defining' }
  },
  { view: 'assessmentauthorgs', id: authOrgId(MATH, O1, SEA, 'assigning'), values: { assessmentOfferingSourcedId: O1, orgRole: 'assigning' } },
  { view: 'assessmentauthorgs', id: authOrgId(MATH, O4, LEA, 'participating'), values: { educationOrganizationId: String(LEA) } },
  // one row per registration school, however many students
  { view: 'assessmentauthorgs', id: authOrgId(MATH, O1, HIGH, 'registration'), values: { orgRole: 'registration' } },
  { view: 'assessmentauthorgs', id: authOrgId(SCIENCE, O3, SCHOOL_B1, 'registration'), values: { assessmentSourcedId: SCIENCE } },
  // testing and reporting organizations are not authorization organizations
  { view: 'assessmentauthorgs', id: authOrgId(SCIENCE, O3, LEA, 'registration'), absent: true }
];

/**
 * What each caller sees of the fixture's assessment rostering rows: the authorization
 * filters run against the fixture with toOdsHierarchyRows loaded. Assessments without a defining
 * organization are visible to everyone; testing organizations never widen access.
 */
export const ASSESSMENT_VISIBILITY = {
  [SEA]: {
    assessments: [MATH, SCIENCE, WRITING, COLLISION_A, COLLISION_B, ESCAPES],
    assessmentofferings: [O1, O2, O3, O4],
    assessmentenrollments: [R1, R2, R3, R4, R5]
  },
  [LEA]: {
    assessments: [MATH, COLLISION_A, COLLISION_B, ESCAPES],
    assessmentofferings: [O1, O2, O4],
    assessmentenrollments: [R1, R3, R5]
  },
  [LEA_B]: {
    assessments: [MATH, SCIENCE, WRITING, COLLISION_A, COLLISION_B, ESCAPES],
    assessmentofferings: [O1, O3, O4],
    assessmentenrollments: [R2, R4]
  },
  [HIGH]: {
    assessments: [MATH, COLLISION_A, COLLISION_B, ESCAPES],
    assessmentofferings: [O1, O2, O4],
    assessmentenrollments: [R1, R3, R5]
  },
  [MIDDLE]: {
    assessments: [MATH, COLLISION_A, COLLISION_B, ESCAPES],
    assessmentofferings: [O1, O2, O4],
    assessmentenrollments: []
  },
  [SCHOOL_B1]: {
    assessments: [MATH, SCIENCE, WRITING, COLLISION_A, COLLISION_B, ESCAPES],
    assessmentofferings: [O1, O3, O4],
    assessmentenrollments: [R2, R4]
  }
};

