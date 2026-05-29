import { z } from "zod";

export const AuthInput = z.object({
    username: z.string(),
    password: z.string()
})

export const OAuthInput = z.object({
    email: z.string().email(),
    name: z.string().optional().nullable()
})

export const WebsiteInput = z.object({
    url: z.string().url()
})
