import { describe, it, expect } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, "../../..");
const ECOSYSTEM_PATH = path.join(ROOT, "ecosystem.config.cjs");

describe("PM2 ecosystem configuration", () => {
  it("loads without syntax errors and defines valid apps", () => {
    const config = require(ECOSYSTEM_PATH);
    expect(config).toBeDefined();
    expect(Array.isArray(config.apps)).toBe(true);

    const appNames = config.apps.map((app: { name: string }) => app.name);
    expect(appNames).toContain("slippay-api");
    expect(appNames).toContain("slippay-listener");
  });

  it("exports consistent database and network environment in apiEnv and listenerEnv", () => {
    const config = require(ECOSYSTEM_PATH);
    const apiApp = config.apps.find((app: { name: string }) => app.name === "slippay-api");
    const listenerApp = config.apps.find((app: { name: string }) => app.name === "slippay-listener");

    expect(apiApp).toBeDefined();
    expect(listenerApp).toBeDefined();
    expect(apiApp.env.SLIPPAY_DB_SCHEMA).toBe(listenerApp.env.SLIPPAY_DB_SCHEMA);
    expect(apiApp.env.STELLAR_NETWORK).toBe(listenerApp.env.STELLAR_NETWORK);
  });
});
