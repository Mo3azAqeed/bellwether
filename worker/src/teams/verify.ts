/** Verifies the Bot Framework's JWT on every incoming Teams activity —
 * there's no shared-secret HMAC scheme here like Slack/Zoom; the Connector
 * Service signs each request with a short-lived RS256 JWT you verify
 * against its own published public keys. See
 * https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
 *
 * The three claim checks below (audience, issuer, expiry) are the
 * load-bearing security checks. A stricter implementation would also
 * pin the token's `serviceurl` claim to the activity's own serviceUrl —
 * not done here; worth adding if this is going in front of anything more
 * sensitive than a CS Slack-equivalent bot. */

const OPENID_CONFIG_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const EXPECTED_ISSUER = "https://api.botframework.com";

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

let cachedKeys: Promise<Jwk[]> | undefined;

async function fetchJwks(): Promise<Jwk[]> {
  if (!cachedKeys) {
    cachedKeys = (async () => {
      const configResp = await fetch(OPENID_CONFIG_URL);
      if (!configResp.ok) throw new Error(`Failed to fetch Bot Framework OpenID config: HTTP ${configResp.status}`);
      const { jwks_uri } = await configResp.json<{ jwks_uri: string }>();

      const jwksResp = await fetch(jwks_uri);
      if (!jwksResp.ok) throw new Error(`Failed to fetch Bot Framework JWKS: HTTP ${jwksResp.status}`);
      const { keys } = await jwksResp.json<{ keys: Jwk[] }>();
      return keys;
    })();
  }
  return cachedKeys;
}

function base64urlToUint8Array(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJson(base64url: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64urlToUint8Array(base64url)));
}

export async function verifyTeamsAuth(authHeader: string | null, expectedAppId: string): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { kid?: string; alg?: string };
  let payload: { aud?: string; iss?: string; exp?: number };
  try {
    header = decodeJson(headerB64) as typeof header;
    payload = decodeJson(payloadB64) as typeof payload;
  } catch {
    return false;
  }

  if (header.alg !== "RS256" || !header.kid) return false;
  if (payload.aud !== expectedAppId) return false;
  if (payload.iss !== EXPECTED_ISSUER) return false;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return false;

  let keys: Jwk[];
  try {
    keys = await fetchJwks();
  } catch (err) {
    console.error("failed to fetch Bot Framework JWKS", err);
    return false;
  }
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return false;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64urlToUint8Array(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
}
