import path from "node:path";
import { z } from "zod";
import type { Env } from "../db/pool.js";

const secret = z.string().min(32, "must be at least 32 characters");
const loopbackHost = z.enum(["127.0.0.1", "localhost", "::1"]);

const configSchema = z.object({
  host: loopbackHost,
  port: z.number().int().min(1024).max(65535),
  accessToken: secret,
  sessionSecret: secret,
  sessionTtlSeconds: z.number().int().min(60).max(24 * 3600),
  allowedOrigins: z.array(z.string().url()).min(1),
  maxUploadBytes: z.number().int().min(1024).max(10 * 1024 * 1024),
  uploadDir: z.string().min(1),
  aiBaseUrl: z.string().url(),
  aiServiceToken: secret,
  aiTimeoutMs: z.number().int().min(1000).max(300_000),
  userHandle: z.string().regex(/^[a-z0-9._-]{1,64}$/),
});
export type ApiConfig = z.infer<typeof configSchema>;

/** Throws with a message naming the variable, never its value. */
export function loadApiConfig(env: Env = process.env): ApiConfig {
  const origins = (env.JH_ALLOWED_ORIGINS ?? "http://127.0.0.1:4321,http://localhost:4321").split(",").map((s) => s.trim()).filter(Boolean);
  const aiHost = env.JH_AI_HOST ?? "127.0.0.1";
  const parsed = configSchema.safeParse({
    host: env.JH_API_HOST ?? "127.0.0.1",
    port: Number(env.JH_API_PORT ?? 8787),
    accessToken: env.JH_API_ACCESS_TOKEN,
    sessionSecret: env.JH_SESSION_SECRET,
    sessionTtlSeconds: Number(env.JH_SESSION_TTL_SECONDS ?? 8 * 3600),
    allowedOrigins: origins,
    maxUploadBytes: Number(env.JH_MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024),
    uploadDir: path.resolve(env.JH_UPLOAD_DIR ?? path.join("private-runtime", "s1-uploads")),
    aiBaseUrl: `http://${aiHost}:${Number(env.JH_AI_PORT ?? 8765)}`,
    aiServiceToken: env.JH_AI_SERVICE_TOKEN,
    aiTimeoutMs: Number(env.JH_AI_TIMEOUT_MS ?? 90_000),
    userHandle: env.JH_USER_HANDLE ?? "local",
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid API configuration: ${problems}`);
  }
  return parsed.data;
}
