import { describe, expect, it } from "vitest";
import { verifyTeamsAuth } from "./verify.js";

function base64url(obj: unknown): string {
  const json = JSON.stringify(obj);
  return btoa(json).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Builds a syntactically valid but unsigned-garbage JWT — enough to reach
 * (and be rejected by) each claim check without ever needing a real
 * signature or network access to fetch Bot Framework's JWKS. */
function fakeJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${base64url(header)}.${base64url(payload)}.deadbeef`;
}

const APP_ID = "11111111-2222-3333-4444-555555555555";
const now = Math.floor(Date.now() / 1000);

describe("verifyTeamsAuth", () => {
  it("rejects a missing Authorization header", async () => {
    expect(await verifyTeamsAuth(null, APP_ID)).toBe(false);
  });

  it("rejects a header that isn't a Bearer token", async () => {
    expect(await verifyTeamsAuth("Basic abc123", APP_ID)).toBe(false);
  });

  it("rejects a token that isn't three dot-separated parts", async () => {
    expect(await verifyTeamsAuth("Bearer not.a.valid.jwt.at.all", APP_ID)).toBe(false);
  });

  it("rejects an algorithm other than RS256", async () => {
    const token = fakeJwt({ alg: "HS256", kid: "k1" }, { aud: APP_ID, iss: "https://api.botframework.com", exp: now + 3600 });
    expect(await verifyTeamsAuth(`Bearer ${token}`, APP_ID)).toBe(false);
  });

  it("rejects a token with no kid", async () => {
    const token = fakeJwt({ alg: "RS256" }, { aud: APP_ID, iss: "https://api.botframework.com", exp: now + 3600 });
    expect(await verifyTeamsAuth(`Bearer ${token}`, APP_ID)).toBe(false);
  });

  it("rejects a token addressed to a different app id", async () => {
    const token = fakeJwt({ alg: "RS256", kid: "k1" }, { aud: "some-other-app-id", iss: "https://api.botframework.com", exp: now + 3600 });
    expect(await verifyTeamsAuth(`Bearer ${token}`, APP_ID)).toBe(false);
  });

  it("rejects a token from an unexpected issuer", async () => {
    const token = fakeJwt({ alg: "RS256", kid: "k1" }, { aud: APP_ID, iss: "https://not-botframework.example.com", exp: now + 3600 });
    expect(await verifyTeamsAuth(`Bearer ${token}`, APP_ID)).toBe(false);
  });

  it("rejects an expired token", async () => {
    const token = fakeJwt({ alg: "RS256", kid: "k1" }, { aud: APP_ID, iss: "https://api.botframework.com", exp: now - 3600 });
    expect(await verifyTeamsAuth(`Bearer ${token}`, APP_ID)).toBe(false);
  });

  it("rejects a token with no exp claim at all", async () => {
    const token = fakeJwt({ alg: "RS256", kid: "k1" }, { aud: APP_ID, iss: "https://api.botframework.com" });
    expect(await verifyTeamsAuth(`Bearer ${token}`, APP_ID)).toBe(false);
  });

  it("rejects unparseable base64/JSON in the header or payload", async () => {
    expect(await verifyTeamsAuth("Bearer not-base64.also-not-base64.sig", APP_ID)).toBe(false);
  });
});
