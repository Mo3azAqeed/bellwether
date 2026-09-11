/** Verifies a Slack request's HMAC signature using the Web Crypto API
 * (there's no Node `crypto` module in Workers, and no Bolt receiver doing
 * this for us anymore now that we're off Socket Mode). See
 * https://api.slack.com/authentication/verifying-requests-from-slack */

const MAX_CLOCK_SKEW_SECONDS = 60 * 5;

let signingKeyPromise: Promise<CryptoKey> | undefined;

function getSigningKey(signingSecret: string): Promise<CryptoKey> {
  if (!signingKeyPromise) {
    signingKeyPromise = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
  }
  return signingKeyPromise;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison to avoid a timing side-channel on the
 * signature check. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySlackRequest(
  signingSecret: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  rawBody: string
): Promise<boolean> {
  if (!timestampHeader || !signatureHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > MAX_CLOCK_SKEW_SECONDS) return false;

  const base = `v0:${timestampHeader}:${rawBody}`;
  const key = await getSigningKey(signingSecret);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const expected = `v0=${toHex(mac)}`;

  return timingSafeEqual(expected, signatureHeader);
}
