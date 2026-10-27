import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

const serverEnvShape = {
  DATABASE_URL: z.url().optional(),
  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  BIRDEYE_API_KEY: z.string().min(1).optional(),
  X_BEARER_TOKEN: z.string().min(1).optional(),
};

const clientEnvShape = {
  NEXT_PUBLIC_APP_URL: z.url(),
};

/** Format checks for server secrets. Empty strings are treated as unset by createEnv. */
export const serverEnvSchema = z.object(serverEnvShape);

/** Format checks for variables that are safe to expose to the browser. */
export const clientEnvSchema = z.object(clientEnvShape);

export const env = createEnv({
  server: serverEnvShape,
  client: clientEnvShape,
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY,
    X_BEARER_TOKEN: process.env.X_BEARER_TOKEN,
    NEXT_PUBLIC_APP_URL:
      process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  },
  emptyStringAsUndefined: true,
  skipValidation: process.env.SKIP_ENV_VALIDATION === "true",
});

export const serverSecretNames = [
  "DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "BIRDEYE_API_KEY",
  "X_BEARER_TOKEN",
] as const satisfies readonly (keyof typeof serverEnvShape)[];

export type ServerSecretName = (typeof serverSecretNames)[number];

/**
 * Reads a secret at the point a provider needs it.
 * Startup validation only checks the format of values that are already set,
 * so the app can boot before Birdeye, X, Postgres, or Redis is configured.
 */
export function readServerSecret(name: ServerSecretName): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Set it in .env.local (see .env.example).`,
    );
  }
  return value;
}
