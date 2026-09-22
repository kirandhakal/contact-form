import { hashPassword } from "../admin-auth.js";
import { getConfig } from "../config.js";
import { PostgresStore } from "./postgres-store.js";

const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase() || "admin@contact";
const password = process.env.SEED_ADMIN_PASSWORD || "Kiran@123456";

async function main() {
  const config = getConfig();
  const store = new PostgresStore(config.DATABASE_URL);
  try {
    const existing = await store.getAdminByEmail(email);
    if (existing) {
      console.log(`Admin ${email} already exists; no changes made.`);
      return;
    }
    await store.createAdmin(email, await hashPassword(password), "service", null);
    console.log(`Created contact service admin: ${email}`);
    console.log("Change the seeded password after the first login.");
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
