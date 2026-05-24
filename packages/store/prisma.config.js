import { defineConfig } from "prisma/config";
import { readFileSync } from "node:fs";

try {
  const envFile = readFileSync(new URL("./.env", import.meta.url), "utf8");

  for (const line of envFile.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    const key = match?.[1];
    const value = match?.[2];
    if (!key || value === undefined || process.env[key]) {
      continue;
    }

    process.env[key] = value.trim().replace(/^["']|["']$/g, "");
  }
} catch {
  // DATABASE_URL may also be provided by the shell or process manager.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
});
