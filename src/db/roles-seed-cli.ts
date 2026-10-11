import { createPool, loadEnvFile, DEFAULT_ENV_FILE, pgSettingsFromEnv } from "./pool.js";
import { RolesRepo } from "./roles-repo.js";

// npm run roles:seed   (idempotent; the API also does this at start. Never overwrites a role a person edited.)
loadEnvFile(DEFAULT_ENV_FILE);
const pool = createPool(pgSettingsFromEnv(), { max: 2 });
try {
  console.log(JSON.stringify(await new RolesRepo(pool).seedCatalog()));
} finally {
  await pool.end();
}
