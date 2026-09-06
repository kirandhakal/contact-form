import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getConfig } from "../config.js";

const { Client } = pg;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationPath = join(root, "migrations", "001_initial.sql");

async function main() {
  const config = getConfig();
  const sql = await readFile(migrationPath, "utf8");
  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
    console.log("Migrations applied");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
