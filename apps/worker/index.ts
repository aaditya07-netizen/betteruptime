import axios from "axios";
import { readFileSync } from "fs";
import { xAckBulk, xReadGroup } from "@repo/redisstream/components";
import {prismaClient} from "@repo/store/client";

function loadLocalEnv() {
    try {
        const envFile = readFileSync(new URL("../.env", import.meta.url), "utf8");

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
        // REGION_ID and WORKER_ID can also be provided by the shell or process manager.
    }
}

loadLocalEnv();

const requiredEnvVars = ["DATABASE_URL", "REDIS_URL", "REGION_ID", "WORKER_ID"] as const;
for (const key of requiredEnvVars) {
    if (!process.env[key]) {
        console.error(`Missing required environment variable: ${key}`);
        process.exit(1);
    }
}

const REGION_ID = process.env.REGION_ID!;
const WORKER_ID = process.env.WORKER_ID!;

async function main() {
    while(1) {
        try {
            const response = await xReadGroup(REGION_ID, WORKER_ID);

            if (!response?.length) {
                continue;
            }

            let promises = response.map(({message}) => fetchWebsite(message.url, message.id))
            await Promise.all(promises);
            console.log(promises.length);

            await xAckBulk(REGION_ID, response.map(({id}) => id));
        } catch (e) {
            console.error(e);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

async function fetchWebsite(url: string, websiteId: string) {
    return new Promise<void>((resolve, reject) => {
        const startTime = Date.now();

        axios.get(url, { timeout: 10000 })
            .then(async () => { 
                const endTime = Date.now();
                await prismaClient.website_tick.create({
                    data: {
                        response_time_ms: endTime - startTime,
                        status: "Up",
                        region_id: REGION_ID,
                        website_id: websiteId
                    }
                })
                resolve()
            })
            .catch(async () => {
                const endTime = Date.now();
                await prismaClient.website_tick.create({
                    data: {
                        response_time_ms: endTime - startTime,
                        status: "Down",
                        region_id: REGION_ID,
                        website_id: websiteId
                    }
                })
                resolve()
            })
    })
}

main();
