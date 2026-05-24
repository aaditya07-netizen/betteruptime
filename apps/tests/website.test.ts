import { describe, it, expect, beforeAll } from "vitest";
import axios from "axios";
import { createUser } from "./testUtil";
import { BACKEND_URL } from "./config";

describe("Website gets created", () => {
    let token: string;

    beforeAll(async () => {
        const data = await createUser();
        token = data.jwt;
    })

    it("Website not created if url is not present", async () => {
        await expect(axios.post(`${BACKEND_URL}/website`, {}, {
            headers: { Authorization: token }
        })).rejects.toMatchObject({
            response: {
                status: 411
            }
        });
    })

    it("Website is created if url is present", async () => {
        const response = await axios.post(`${BACKEND_URL}/website`, {
            url: "https://google.com"
        }, {
            headers: { Authorization: token }
        })
        expect(response.data.id).not.toBeNull();
    })

    it("Website is not created if the header is not present", async () => {
        await expect(axios.post(`${BACKEND_URL}/website`, {
            url: "https://google.com"
        })).rejects.toMatchObject({
            response: {
                status: 403
            }
        });
    })
})

describe("Can fetch website", () => {
    let token1: string, userId1: string;
    let token2: string, userId2: string;

    beforeAll(async () => {
        const user1 = await createUser();
        const user2 = await createUser();
        token1 = user1.jwt;
        userId1 = user1.id;
        token2 = user2.jwt;
        userId2 = user2.id;
    });

    it("Is able to fetch a website that the user created", async () => {
        const websiteResponse = await axios.post(`${BACKEND_URL}/website`, {
            url: "https://hdjjhdhdjhdj.com/"
        }, {
            headers: { Authorization: token1 }
        })

        const getWebsiteResponse = await axios.get(`${BACKEND_URL}/status/${websiteResponse.data.id}`, {
            headers: { Authorization: token1 }
        })

        expect(getWebsiteResponse.data.id).toBe(websiteResponse.data.id)
        expect(getWebsiteResponse.data.user_id).toBe(userId1)
    })

    it("Cant access website created by other user", async () => {
        const websiteResponse = await axios.post(`${BACKEND_URL}/website`, {
            url: "https://hdjjhdhdjhdj.com/"
        }, {
            headers: { Authorization: token1 }
        })

        await expect(axios.get(`${BACKEND_URL}/status/${websiteResponse.data.id}`, {
            headers: { Authorization: token2 }
        })).rejects.toMatchObject({
            response: {
                status: 409
            }
        });
    })
})
