import { PrismaClient } from "../generated/prisma/client.js";
import { readFileSync } from "fs";

function loadEnvFile(url: URL) {
    try {
        const envFile = readFileSync(url, "utf8");

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
        // Services may provide DATABASE_URL through the process environment instead.
    }
}

loadEnvFile(new URL("../.env", import.meta.url));

export const prismaClient = new PrismaClient();
