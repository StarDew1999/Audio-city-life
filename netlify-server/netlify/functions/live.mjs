import { getStore } from "@netlify/blobs";
import { handle } from "../../lib/core.mjs";

export default async (req) => handle(req, getStore({ name: "live", consistency: "strong" }), { bridgeKey: process.env.BRIDGE_KEY || "" });

export const config = { path: "/api/live" };
