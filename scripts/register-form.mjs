import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const definitionPath = process.argv[2];
const apiBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3100"}`).replace(/\/$/, "");
const adminApiKey = process.env.ADMIN_API_KEY;

if (!definitionPath) {
  console.error("Usage: npm run register:form -- forms/project-form.json");
  process.exit(1);
}
if (!adminApiKey) {
  console.error("ADMIN_API_KEY is required in the backend .env file.");
  process.exit(1);
}

const definition = JSON.parse(await readFile(resolve(definitionPath), "utf8"));
const response = await fetch(`${apiBaseUrl}/v1/admin/forms`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${adminApiKey}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify(definition)
});
const result = await response.json().catch(() => null);

if (!response.ok) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log(`Created ${definition.name}`);
console.log(`Public key: ${result.publicKey}`);
console.log(`Submit URL: ${result.submitUrl}`);
