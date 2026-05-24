import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;

    try {
        let data = jwt.verify(token!, process.env.JWT_SECRET!);
        req.userId = data.sub as string;
        next();
    } catch(e) {
        console.log(e);
        res.status(403).send("");
    }
}
