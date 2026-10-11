import { createPool, loadEnvFile, DEFAULT_ENV_FILE, pgSettingsFromEnv } from "./pool.js";
import { migrate } from "./migrate.js";

// npm run db:migrate   (applies forward migrations to the dedicated S1 PostgreSQL; loads infra/.env)
loadEnvFile(DEFAULT_ENV_FILE);
const pool = createPool(pgSettingsFromEnv(), { max: 2 });
try {
  const result = await migrate(pool);
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
