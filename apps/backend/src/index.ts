import jwt from "jsonwebtoken";
import express from "express"
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
const app = express();
import {prismaClient} from "@repo/store/client";
import { authMiddleware } from "./middleware.js";
import { AuthInput, OAuthInput, WebsiteInput } from "./types.js";

app.use(express.json());

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
        // JWT_SECRET and PORT can also be provided by the shell or process manager.
    }
}

loadLocalEnv();

const requiredEnvVars = ['DATABASE_URL', 'JWT_SECRET'] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

function hashPassword(password: string) {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");

    return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedPassword: string) {
    const [salt, hash] = storedPassword.split(":");

    if (!salt || !hash) {
        return password === storedPassword;
    }

    const incomingHash = scryptSync(password, salt, 64);
    const storedHash = Buffer.from(hash, "hex");

    return storedHash.length === incomingHash.length && timingSafeEqual(storedHash, incomingHash);
}

function signUserToken(userId: string) {
    return jwt.sign({
        sub: userId
    }, process.env.JWT_SECRET!)
}

app.get("/websites", authMiddleware, async (req, res) => {
    const websites = await prismaClient.website.findMany({
        where: {
            user_id: req.userId!,
        },
        orderBy: {
            time_added: "desc",
        },
        include: {
            ticks: {
                orderBy: {
                    createdAt: "desc",
                },
                take: 1,
            },
        },
    });

    res.json({
        websites: websites.map(({ ticks, ...website }) => ({
            ...website,
            latest_tick: ticks[0] ?? null,
        })),
    });
});

app.post("/website", authMiddleware, async (req, res) => {
    const data = WebsiteInput.safeParse(req.body);
    if (!data.success) {
        res.status(411).json({});
        return
    }
    const website = await prismaClient.website.create({
        data: {
            url: data.data.url,
            time_added: new Date(),
            user_id: req.userId!
        }
    })

    res.json({
        id: website.id
    })
});

app.get("/status/:websiteId", authMiddleware, async (req, res) => {
    const website = await prismaClient.website.findFirst({
        where: {
            user_id: req.userId!,
            //@ts-ignore
            id: req.params.websiteId,
        }
    })

    if (!website) {
        res.status(409).json({
            message: "Not found"
        })
        return;
    }

    const latestTick = await prismaClient.website_tick.findFirst({
        where: {
            website_id: website.id,
        },
        orderBy: {
            createdAt: "desc",
        },
    });

    res.json({
        url: website.url,
        id: website.id,
        user_id: website.user_id,
        latest_tick: latestTick
    })

})

app.post("/user/signup", async (req, res) => {
    const data = AuthInput.safeParse(req.body);
    if (!data.success) {
        console.log(data.error.toString());
        res.status(403).send("");
        return;
    }

    try {
        let user = await prismaClient.user.create({
            data: {
                username: data.data.username,
                password: hashPassword(data.data.password)
            }
    })
        res.json({
            id: user.id
        })
    } catch(e) {
        console.log(e);
        res.status(403).send("");
    }
})

app.post("/user/signin", async (req, res) => {
    const data = AuthInput.safeParse(req.body);
    if (!data.success) {
        res.status(403).send("");
        return;
    }

    let user = await prismaClient.user.findFirst({
        where: {
            username: data.data.username
        }
    })

    if (!user || !verifyPassword(data.data.password, user.password)) {
        res.status(403).send("");
        return;
    }

    res.json({
        jwt: signUserToken(user.id)
    })
})

app.post("/user/oauth", async (req, res) => {
    const data = OAuthInput.safeParse(req.body);
    if (!data.success) {
        res.status(403).send("");
        return;
    }

    const username = data.data.email.toLowerCase();
    const user = await prismaClient.user.upsert({
        where: {
            username,
        },
        update: {},
        create: {
            username,
            password: hashPassword(`oauth:${randomBytes(32).toString("hex")}`),
        },
    });

    res.json({
        id: user.id,
        jwt: signUserToken(user.id),
    });
})

app.listen(process.env.PORT || 3001);
