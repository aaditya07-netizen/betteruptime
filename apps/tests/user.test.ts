import axios from "axios";
import { describe, expect, it } from "vitest";
import { BACKEND_URL } from "./config";

const USER_NAME = Math.random().toString();

describe("Signup endpoints", () => {
    it("Isnt able to sign up if body is incorrect", async () => {
        await expect(axios.post(`${BACKEND_URL}/user/signup`, {
            email: USER_NAME,
            password: "password"
        })).rejects.toMatchObject({
            response: {
                status: 403
            }
        });
    })

    it("Is able to sign up if body is correct", async () => {
        const res = await axios.post(`${BACKEND_URL}/user/signup`, {
            username: USER_NAME,
            password: "password"
        })
        expect(res.status).toBe(200);
        expect(res.data.id).toBeDefined();
    })
})

describe("Signin endpoints", () => {
    it("Isnt able to sign in if body is incorrect", async () => {
        await expect(axios.post(`${BACKEND_URL}/user/signin`, {
            email: USER_NAME,
            password: "password"
        })).rejects.toMatchObject({
            response: {
                status: 403
            }
        });
    })

    it("Is able to sign in if body is correct", async () => {
        const res = await axios.post(`${BACKEND_URL}/user/signin`, {
            username: USER_NAME,
            password: "password"
        });
        expect(res.status).toBe(200);
        expect(res.data.jwt).toBeDefined();
    })
})
