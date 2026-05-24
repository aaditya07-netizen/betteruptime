import { readFileSync } from "fs";

function loadLocalEnv() {
  try {
    const envFile = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of envFile.split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
      const key = match?.[1];
      const value = match?.[2];
      if (!key || value === undefined || process.env[key]) continue;
      process.env[key] = value.trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // env vars provided by shell or process manager
  }
}

loadLocalEnv();

const requiredEnvVars = ['DATABASE_URL', 'REDIS_URL'] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

import {prismaClient} from "@repo/store/client";
import { xAddBulk } from "@repo/redisstream/components";


async function main() {
    let websites = await prismaClient.website.findMany({
        select: {
            url: true,
            id: true
        }
    })
  
    await xAddBulk(websites.map(w => ({
        url: w.url,
        id: w.id
    })));
}

setInterval(() => {
    main()
}, 3 * 1000 )

main()
