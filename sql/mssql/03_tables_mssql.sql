-- =============================================
-- MS SQL Server Table Definitions for OneRoster 1.2
-- Creates all data tables that will store materialized view data
-- =============================================

-- Drop existing tables if they exist (in dependency order)
IF OBJECT_ID('oneroster12.enrollments', 'U') IS NOT NULL DROP TABLE oneroster12.enrollments;
IF OBJECT_ID('oneroster12.demographics', 'U') IS NOT NULL DROP TABLE oneroster12.demographics;
IF OBJECT_ID('oneroster12.users', 'U') IS NOT NULL DROP TABLE oneroster12.users;
IF OBJECT_ID('oneroster12.classes', 'U') IS NOT NULL DROP TABLE oneroster12.classes;
IF OBJECT_ID('oneroster12.courses', 'U') IS NOT NULL DROP TABLE oneroster12.courses;
IF OBJECT_ID('oneroster12.orgs', 'U') IS NOT NULL DROP TABLE oneroster12.orgs;
IF OBJECT_ID('oneroster12.academicsessions', 'U') IS NOT NULL DROP TABLE oneroster12.academicsessions;
GO

-- =============================================
-- Academic Sessions Table
-- =============================================
CREATE TABLE oneroster12.academicsessions (
    sourcedId NVARCHAR(64) NOT NULL PRIMARY KEY,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    title NVARCHAR(256) NOT NULL,
    type NVARCHAR(32) NOT NULL,
    startDate NVARCHAR(32) NULL,
    endDate NVARCHAR(32) NULL,
    parent NVARCHAR(MAX) NULL, -- JSON
    schoolYear NVARCHAR(16) NULL,
    metadata NVARCHAR(MAX) NULL -- JSON
);
GO

-- =============================================
-- Organizations Table
-- =============================================
CREATE TABLE oneroster12.orgs (
    sourcedId NVARCHAR(64) NOT NULL PRIMARY KEY,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    name NVARCHAR(256) NOT NULL,
    type NVARCHAR(32) NOT NULL,
    identifier NVARCHAR(256) NULL,
    parent NVARCHAR(MAX) NULL, -- JSON
    children NVARCHAR(MAX) NULL, -- JSON array
    metadata NVARCHAR(MAX) NULL -- JSON
);
GO

-- =============================================
-- Courses Table
-- =============================================
CREATE TABLE oneroster12.courses (
    sourcedId NVARCHAR(64) NOT NULL PRIMARY KEY,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    schoolYear NVARCHAR(MAX) NULL, -- JSON object
    title NVARCHAR(256) NOT NULL,
    courseCode NVARCHAR(64) NULL,
    grades NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    subjects NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    org NVARCHAR(MAX) NULL, -- JSON
    subjectCodes NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    resources NVARCHAR(MAX) NULL, -- JSON array
    metadata NVARCHAR(MAX) NULL -- JSON
);
GO

-- =============================================
-- Classes Table
-- =============================================
CREATE TABLE oneroster12.classes (
    sourcedId NVARCHAR(64) NOT NULL PRIMARY KEY,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    title NVARCHAR(256) NOT NULL,
    classCode NVARCHAR(64) NULL,
    classType NVARCHAR(32) NULL,
    location NVARCHAR(256) NULL,
    grades NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    subjects NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    course NVARCHAR(MAX) NULL, -- JSON
    school NVARCHAR(MAX) NULL, -- JSON
    terms NVARCHAR(MAX) NULL, -- JSON array
    subjectCodes NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    periods NVARCHAR(MAX) NULL, -- comma-separated
    resources NVARCHAR(MAX) NULL, -- JSON array
    metadata NVARCHAR(MAX) NULL -- JSON
);
GO

-- =============================================
-- Users Table
-- =============================================
CREATE TABLE oneroster12.users (
    sourcedId NVARCHAR(64) NOT NULL PRIMARY KEY,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    enabledUser BIT NOT NULL DEFAULT 1,
    username NVARCHAR(256) NULL,
    userIds NVARCHAR(MAX) NULL, -- JSON array
    givenName NVARCHAR(256) NULL,
    familyName NVARCHAR(256) NULL,
    middleName NVARCHAR(256) NULL,
    identifier NVARCHAR(256) NULL,
    email NVARCHAR(256) NULL,
    sms NVARCHAR(32) NULL,
    phone NVARCHAR(32) NULL,
    agents NVARCHAR(MAX) NULL, -- JSON array
    orgs NVARCHAR(MAX) NULL, -- JSON array
    grades NVARCHAR(MAX) NULL, -- JSON array or comma-separated
    password NVARCHAR(256) NULL,
    userMasterIdentifier NVARCHAR(256) NULL,
    resourceId NVARCHAR(256) NULL,
    preferredFirstName NVARCHAR(256) NULL,
    preferredMiddleName NVARCHAR(256) NULL,
    preferredLastName NVARCHAR(256) NULL,
    primaryOrg NVARCHAR(MAX) NULL, -- JSON
    pronouns NVARCHAR(64) NULL,
    userProfiles NVARCHAR(MAX) NULL, -- JSON array (for OneRoster compatibility)
    agentSourceIds NVARCHAR(MAX) NULL, -- text field (for OneRoster compatibility)
    metadata NVARCHAR(MAX) NULL, -- JSON
    role NVARCHAR(32) NULL,
    roles NVARCHAR(MAX) NULL -- JSON array
);
GO

-- =============================================
-- Enrollments Table
-- =============================================
CREATE TABLE oneroster12.enrollments (
    sourcedId NVARCHAR(64) NOT NULL PRIMARY KEY,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    class NVARCHAR(MAX) NULL, -- JSON
    school NVARCHAR(MAX) NULL, -- JSON
    [user] NVARCHAR(MAX) NULL, -- JSON (note: 'user' is escaped as it's a reserved word)
    role NVARCHAR(32) NULL,
    [primary] BIT NULL, -- 'primary' is a reserved word
    beginDate NVARCHAR(32) NULL,
    endDate NVARCHAR(32) NULL,
    metadata NVARCHAR(MAX) NULL -- JSON
);
GO

-- =============================================
-- Demographics Table
-- =============================================
CREATE TABLE oneroster12.demographics (
    sourcedId NVARCHAR(64) NOT NULL PRIMARY KEY,
    status NVARCHAR(16) NOT NULL,
    dateLastModified DATETIME2 NULL,
    birthDate NVARCHAR(32) NULL,
    sex NVARCHAR(32) NULL,
    americanIndianOrAlaskaNative BIT NULL,
    asian BIT NULL,
    blackOrAfricanAmerican BIT NULL,
    nativeHawaiianOrOtherPacificIslander BIT NULL,
    white BIT NULL,
    demographicRaceTwoOrMoreRaces BIT NULL,
    hispanicOrLatinoEthnicity BIT NULL,
    countryOfBirthCode NVARCHAR(8) NULL,
    stateOfBirthAbbreviation NVARCHAR(8) NULL,
    cityOfBirth NVARCHAR(256) NULL,
    publicSchoolResidenceStatus NVARCHAR(256) NULL,
    metadata NVARCHAR(MAX) NULL -- JSON
);
GO

-- Create basic indexes on sourcedId (already PRIMARY KEY, but documenting intent)
-- Additional indexes will be created in the indexes file based on query patterns

PRINT 'OneRoster 1.2 tables created successfully';
GO