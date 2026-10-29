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
  unmappedPosition: descriptor('ClassroomPositionDescriptor', 'Teacher of Record', UNMAPPED)
};

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
    { id: CHARTER_LEA, name: 'Fixture Charter District', sea: null, category: D.leaCategory }
  ],
  schools: [
    { id: HIGH, name: 'Fixture High School', lea: LEA },
    { id: MIDDLE, name: 'Fixture Middle School', lea: LEA },
    { id: LAB, name: 'Fixture Lab School', lea: null }
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
    { uniqueId: 'FX-STU-5', firstName: 'Eve', lastName: 'Evans', birthDate: '2012-02-29' }
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
    { student: 'FX-STU-4', school: MIDDLE, entryDate: '2025-08-11', grade: D.tenthGrade }
    // FX-STU-5: no school
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
    }
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

  return rows;
}

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
      DocumentId: alloc(), SchoolId_Unified: ssa.school, School_DocumentId: edorg(ssa.school), ...student(ssa.student),
      EntryDate: ssa.entryDate, ExitWithdrawDate: ssa.exitDate ?? null, PrimarySchool: ssa.primary ?? null,
      EntryGradeLevelDescriptor_DescriptorId: d(ssa.grade), ...modified(ssa)
    });
  }
  for (const seoa of fixture.studentEducationOrganizationAssociations) {
    const documentId = alloc();
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

/** Rows each projection gains from the fixture. */
export const EXPECTED_COUNTS = {
  orgs: 6, // 1 SEA, 2 LEAs, 3 schools
  academicsessions: 8, // 3 school years (LEA 2025 and 2026, no-LEA 2026) and 5 mapped terms
  courses: 5,
  classes: 5,
  users: 19, // 8 student rows (one per school), 7 staff rows, 4 contacts
  enrollments: 9,
  demographics: 8
};

/**
 * Expected values by projection: { view, key, values } where key is the text the sourcedId hashes,
 * or { view, key, absent: true }. Columns in `unordered` hold arrays whose order the SQL leaves open.
 */
export const EXPECTATIONS = [
  { view: 'orgs', key: String(SEA), values: { type: 'state', parent: null, children: [orgRef(LEA)] } },
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
  { view: 'demographics', key: 'STU-FX-STU-5', values: { educationOrganizationId: null, hispanicOrLatinoEthnicity: 'false', dateLastModified: at(LAST_MODIFIED) } }
];
