const { Pool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
neonConfig.webSocketConstructor = ws;
const fs = require('fs');
const path = require('path');

const envContent = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8');
const env = {};
for (const line of envContent.split(/\r?\n/)) {
  const m = line.match(/^([^=]+)=(.*)$/);
  if (m) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[m[1].trim()] = v;
  }
}

async function initSchema() {
  // Use unpooled for schema migrations
  const pool = new Pool({ connectionString: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL });

  console.log('Creating tables...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      student_id VARCHAR(30) PRIMARY KEY,
      name TEXT NOT NULL,
      department TEXT,
      year_level TEXT,
      nfc_registered BOOLEAN DEFAULT false,
      active_loans INT DEFAULT 0,
      overdue_count INT DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS student_web_accounts (
      student_id VARCHAR(30) PRIMARY KEY REFERENCES students(student_id) ON UPDATE CASCADE ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS books (
      barcode VARCHAR(50) PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      call_number TEXT,
      section TEXT,
      isbn TEXT,
      total_copies INT DEFAULT 1,
      available_copies INT DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      book_barcode VARCHAR(50),
      book_title TEXT,
      student_id VARCHAR(30) REFERENCES students(student_id),
      type TEXT NOT NULL,
      transaction_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      days_overdue INT DEFAULT 0
    );
  `);

  console.log('Checking sample data...');
  const { rowCount } = await pool.query('SELECT 1 FROM students WHERE student_id = $1', ['25-10834']);
  if (rowCount === 0) {
    console.log('Inserting sample student and book...');
    await pool.query(`
      INSERT INTO students (student_id, name, department, year_level, nfc_registered, active_loans, overdue_count)
      VALUES ('25-10834', 'Dela Cruz, Juan M.', 'Computer Science', '3rd Year', true, 1, 0)
      ON CONFLICT DO NOTHING;

      INSERT INTO books (barcode, title, author, call_number, section, isbn, total_copies, available_copies)
      VALUES 
        ('B-001', 'Introduction to Algorithms', 'Thomas H. Cormen', 'QA76.6 .C662', 'Circulation', '9780262033848', 3, 2),
        ('B-002', 'Design Patterns', 'Erich Gamma', 'QA76.76.D47 D47', 'Circulation', '9780201633610', 2, 2)
      ON CONFLICT DO NOTHING;

      INSERT INTO transactions (book_barcode, book_title, student_id, type, transaction_time, days_overdue)
      VALUES ('B-001', 'Introduction to Algorithms', '25-10834', 'BORROWED', NOW() - INTERVAL '2 days', 0);
    `);
  }

  const res = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  console.log('Public tables:', res.rows.map(r => r.table_name));

  await pool.end();
  console.log('Schema setup complete.');
}

initSchema().catch(e => {
  console.error('Schema initialization failed:', e);
  process.exit(1);
});
