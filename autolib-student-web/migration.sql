-- =====================================================================
-- A.K.L.A.T. Student Web Portal — one-time database setup
-- Run this ONCE on the same PostgreSQL database the librarian app uses.
-- It only ADDS a new table; it does not touch students/books/transactions,
-- so the JavaFX librarian app keeps working exactly as before.
-- =====================================================================

CREATE TABLE IF NOT EXISTS student_web_accounts (
    student_id    VARCHAR(30) PRIMARY KEY
                  REFERENCES students(student_id) ON UPDATE CASCADE ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- Recommended: a limited database user for the website, so a bug in the
-- website can never modify books, students or transactions.
-- Replace CHANGE_ME with a long random password, then use this user in
-- DATABASE_URL.
-- ---------------------------------------------------------------------
-- CREATE ROLE autolib_web LOGIN PASSWORD 'CHANGE_ME';
-- GRANT CONNECT ON DATABASE autolib_db TO autolib_web;
-- GRANT USAGE ON SCHEMA public TO autolib_web;
-- GRANT SELECT ON students, books, transactions TO autolib_web;
-- GRANT SELECT, INSERT ON student_web_accounts TO autolib_web;
