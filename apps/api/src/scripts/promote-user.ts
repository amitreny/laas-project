// Ops tooling, deliberately not an API endpoint: making someone an admin requires shell access.
// Usage: npm run users:promote <email>
import { UserStore } from '../auth/users.js';
import { openDb } from '../db.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('usage: npm run users:promote <email>');
  process.exit(1);
}
if (!new UserStore(openDb()).setRole(email, 'admin')) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}
console.log(`${email} is now an admin`);
