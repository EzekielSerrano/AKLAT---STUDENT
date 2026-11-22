# A.K.L.A.T. Student Web Portal

A website for students (Dashboard · Find Books · My History · My Profile).
The librarian desktop app (JavaFX) is unchanged and keeps using the same PostgreSQL database,
so everything a librarian records shows up on the website.

```
 Students (phone / PC browser) ──HTTPS──►  Web server (this project)  ──►  PostgreSQL  ◄──  Librarian JavaFX app
```

Students are **read-only** here: no borrowing or returning (that happens at the library counter).

---

## 1. Prepare the database (once)

Run `migration.sql` on your `autolib_db`. It only adds one table (`student_web_accounts`);
nothing existing is modified.

```
psql -h YOUR_DB_HOST -U postgres -d autolib_db -f migration.sql
```

Then uncomment and run the `CREATE ROLE autolib_web ...` lines at the bottom (with a strong password).
The website will use that limited user.

## 2. Try it on your own computer

Requires Node.js 18+.

```
npm install
copy .env.example .env      (Windows)   |   cp .env.example .env   (Mac/Linux)
# edit .env: DATABASE_URL, SESSION_SECRET (DB_SSL=false for a local database, NODE_ENV=development)
node server.js
```

Open http://localhost:3000.

## 3. Put it online

You need two things online: **the database** and **this website**.

### Database
Your librarian app's database must be reachable from the internet-hosted website.
Easiest: use a managed PostgreSQL (e.g. Neon, Supabase, Railway, Render, DigitalOcean, AWS RDS),
import `db/schema.sql` + `migration.sql` there, and point **both** the website and the
librarian app at it (see section 4). If you keep the database on a library PC, it must be reachable
with a fixed address — managed hosting is much simpler and safer.

### Website — option A: a hosting platform (simplest)
Works on Render, Railway, Fly.io, Koyeb, etc.
1. Put this folder in a GitHub repository.
2. Create a new **Web Service** from the repo. Build command: `npm install`. Start command: `npm start`.
3. Add the environment variables from `.env.example` (`DATABASE_URL`, `DB_SSL`, `SESSION_SECRET`,
   `NODE_ENV=production`, `TRUST_PROXY=true`).
4. Deploy. The platform gives you an `https://` address; you can attach your own domain in its settings.
5. Health check path: `/healthz`.

### Website — option B: your own server (VPS with Docker)
1. Point a domain's DNS **A record** at the server's IP. Edit `Caddyfile` with that domain.
2. Copy this folder to the server, copy `.env.example` to `.env` and fill it in.
3. Run `docker compose up -d --build`. Caddy gets the HTTPS certificate automatically.
4. Open ports 80 and 443 in the server firewall.

## 4. Point the librarian desktop app at the online database

The updated `DBConnection.java` reads these environment variables (falls back to localhost if unset):

| Variable | Example |
|---|---|
| `AUTOLIB_DB_HOST` | `your-db-host.example.com` |
| `AUTOLIB_DB_PORT` | `5432` |
| `AUTOLIB_DB_NAME` | `autolib_db` |
| `AUTOLIB_DB_USER` | your staff DB user |
| `AUTOLIB_DB_PASS` | its password |
| `AUTOLIB_DB_SSL`  | `true` (for managed databases) |

On Windows add `set AUTOLIB_DB_HOST=...` lines near the top of `run_autolib_fx.bat`.

## 5. How students sign in

1. **First time:** open the site → *First time? Activate* → enter Student ID, full name exactly as the
   library has it (word order and punctuation don't matter), and choose a password (8+ characters).
2. **Afterwards:** sign in with Student ID + password. Sessions last 2 hours.

**Forgot password?** A librarian/admin deletes the account row so the student can activate again:
```sql
DELETE FROM student_web_accounts WHERE student_id = '25-10834';
```

## 6. Security checklist (please do these before going public)

- Change the default database password (`postgres`/`postgres`) and the default staff login (`admin` / `admin123`).
  Note: `staff_users.password_hash` currently stores the password in **plain text** — worth fixing in the desktop app.
- Use SSL for database connections and restrict who can reach the database port (firewall / allow-list).
- Use the limited `autolib_web` role for the website (section 1).
- Set a long random `SESSION_SECRET`; never commit `.env`.
- Always serve over HTTPS (both options above do).
- Name-based activation is only as strong as the secrecy of student names. For higher assurance, issue
  one-time activation codes at the library counter.
- Login attempts are rate-limited in memory; if you run several server copies, add a shared limiter.

## Files

| File | Purpose |
|---|---|
| `server.js` | Web server + JSON API (only dependency: `pg`) |
| `public/` | The student website (HTML, CSS, JS) |
| `migration.sql` | One-time DB addition |
| `Dockerfile`, `docker-compose.yml`, `Caddyfile` | Option B deployment |
| `.env.example` | Settings template |
