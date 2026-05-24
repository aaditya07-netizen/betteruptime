import { createClient } from "redis";

const client = await createClient({
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
})
    .on("error", (err) => console.log("Redis Client Error", err))
    .connect();

type WebsiteEvent = {url: string, id: string}
type MessageType = {
    id: string,
    message: {
        url: string,
        id: string
    }
    //@ts-ignore
}

const STREAM_NAME = "betteruptime:website";
const initializedConsumerGroups = new Set<string>();

async function ensureConsumerGroup(consumerGroup: string) {
    if (initializedConsumerGroups.has(consumerGroup)) {
        return;
    }

    try {
        await client.xGroupCreate(STREAM_NAME, consumerGroup, "0", {
            MKSTREAM: true,
        });
    } catch (e) {
        if (!(e instanceof Error) || !e.message.includes("BUSYGROUP")) {
            throw e;
        }
    }

    initializedConsumerGroups.add(consumerGroup);
}

async function xAdd({url, id}: WebsiteEvent) {
    await client.xAdd(
        STREAM_NAME, '*', {
            url,
            id
        }
    );
}

export async function xAddBulk(websites: WebsiteEvent[]) {
    for (let i = 0; i < websites.length; i++) {
        const website = websites[i];
        if (!website) {
            continue;
        }

        await xAdd({
            url: website.url,
            id: website.id
        });
    }
}

export async function xReadGroup(consumerGroup: string, workerId: string): Promise<MessageType[] | undefined> {
    await ensureConsumerGroup(consumerGroup);
    
    const res = await client.xReadGroup(
        consumerGroup, workerId, {
            key: STREAM_NAME,
            id: '>'
        }, {
        'COUNT': 5,
        'BLOCK': 5000
        }
    );

    //@ts-ignore
    let messages: MessageType[] | undefined = res?.[0]?.messages;

    return messages;
}

async function xAck(consumerGroup: string, eventId: string) {
    await client.xAck(STREAM_NAME, consumerGroup, eventId)
}

export async function xAckBulk(consumerGroup: string, eventIds: string[]) {
    await Promise.all(eventIds.map(eventId => xAck(consumerGroup, eventId)));
}
