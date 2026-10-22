/**
 * Create or update a console account.
 *
 *   npm run user:add -- --email admin2@corp.com --name "李四" --password "至少8位"
 *   npm run user:add -- --list
 *
 * Re-running with an existing email resets that password and revokes its
 * sessions (token_version + 1), so it doubles as "forgot password".
 */
import "dotenv/config";
import { randomBytes, scryptSync } from "node:crypto";
import pg from "pg";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

const client = new pg.Client({
  host: process.env.PG_HOST || "127.0.0.1",
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER || "postgres",
  password: (process.env.PG_PASSWORD || "").replace(/^["']|["']$/g, ""),
  database: process.env.PG_DATABASE || "ai_hub",
});

await client.connect();

if (process.argv.includes("--list")) {
  const { rows } = await client.query(
    `SELECT id, name, email, role,
            (password_hash <> '') AS can_sign_in,
            last_login
       FROM marmot_users
      ORDER BY id`
  );
  console.log("id | email | name | role | can sign in | last login");
  for (const r of rows) {
    console.log([r.id, r.email, r.name, r.role, r.can_sign_in ? "yes" : "no", r.last_login || "-"].join(" | "));
  }
  await client.end();
  process.exit(0);
}

const email = arg("email").trim().toLowerCase();
const password = arg("password");
const name = arg("name").trim() || email.split("@")[0];
const role = arg("role", "Admin").trim() || "Admin";

if (!email || !email.includes("@")) {
  console.error("Missing or invalid --email.");
  process.exit(1);
}
if (password.length < 8) {
  console.error("--password must be at least 8 characters.");
  process.exit(1);
}

const id = `u-${Date.now()}`;
const { rows } = await client.query(
  `INSERT INTO marmot_users (id, name, email, role, last_login, password_hash, token_version)
   VALUES ($1, $2, $3, $4, '', $5, 0)
   ON CONFLICT (email) DO UPDATE
     SET name          = EXCLUDED.name,
         role          = EXCLUDED.role,
         password_hash = EXCLUDED.password_hash,
         token_version = marmot_users.token_version + 1
   RETURNING id, email, role,
             (xmax = 0) AS inserted`,
  [id, name, email, role, hashPassword(password)]
);

const row = rows[0];
console.log(
  row.inserted
    ? `Created ${row.email} (${row.id}, role ${row.role}).`
    : `Updated ${row.email} (${row.id}): password reset, existing sessions revoked.`
);
console.log("Sign in with this email and password; no restart needed.");

await client.end();
