/** Google Meet transcript connector. Pull-based only (nightly backfill via
 * the cron in src/index.ts), not a webhook: Workspace's push notifications
 * for Meet go through Cloud Pub/Sub, which is a separate piece of GCP
 * infrastructure to stand up — not worth it until a nightly pull turns out
 * to be too slow in practice. A day's lag is the tradeoff for "day one,
 * nothing to deploy outside Cloudflare".
 *
 * Requires a Google Cloud service account with Workspace domain-wide
 * delegation (Admin console → Security → API controls → Domain-wide
 * delegation), scoped to `meetings.space.readonly`, impersonating a real
 * Workspace user via GOOGLE_WORKSPACE_IMPERSONATE_EMAIL — Meet API calls
 * only see meetings that user could see.
 *
 * NOTE: the Meet API v2 request shapes below (list filter syntax, entry
 * pagination) are implemented from documentation, not tested against a
 * live Workspace tenant — verify against
 * https://developers.google.com/workspace/meet/api/reference/rest if
 * responses don't parse as expected. The OAuth2 JWT-bearer flow itself is
 * standard and shouldn't need adjustment.
 *
 * Account resolution is the weak point: this API surface doesn't expose a
 * meeting title or participant emails without also calling Calendar/People
 * APIs (not implemented here), so it falls back to whatever participant
 * display names Meet shows — only routes correctly if those happen to
 * mention the account. Worth a Calendar API correlation as a fast follow
 * if that turns out to be too unreliable in practice. */

import type { Env } from "../env.js";
import { ingestDocument } from "../rag/ingest.js";
import { resolveAccountId } from "./resolve-account.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MEET_API_BASE = "https://meet.googleapis.com/v2";
const SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";

function base64url(bytes: ArrayBuffer | string): string {
  const raw = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
}

async function getAccessToken(env: Env): Promise<string> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || !env.GOOGLE_WORKSPACE_IMPERSONATE_EMAIL) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, and GOOGLE_WORKSPACE_IMPERSONATE_EMAIL are required");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
      sub: env.GOOGLE_WORKSPACE_IMPERSONATE_EMAIL,
    })
  );
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64url(signature)}`;

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) throw new Error(`Google OAuth token exchange failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  const json = await resp.json<{ access_token: string }>();
  return json.access_token;
}

interface ConferenceRecord {
  name: string; // "conferenceRecords/{id}"
  startTime: string;
}

async function meetApiGet<T>(accessToken: string, path: string): Promise<T> {
  const resp = await fetch(`${MEET_API_BASE}/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) throw new Error(`Meet API request failed: HTTP ${resp.status} — ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

async function listRecentConferenceRecords(accessToken: string, sinceISO: string): Promise<ConferenceRecord[]> {
  const data = await meetApiGet<{ conferenceRecords?: ConferenceRecord[] }>(
    accessToken,
    `conferenceRecords?filter=${encodeURIComponent(`start_time>="${sinceISO}"`)}`
  );
  return data.conferenceRecords ?? [];
}

/** There's no reliable "meeting title" or participant email on this API
 * surface without also calling Calendar/People APIs, which this connector
 * doesn't do (see module note). Falls back to whatever display names Meet
 * shows for participants — works only if your org's names happen to
 * include the account name (e.g. "Jane (Northwind)"), which is weak but
 * better than nothing until a Calendar API correlation gets added. */
async function fetchParticipantNames(accessToken: string, conferenceRecordName: string): Promise<string[]> {
  const data = await meetApiGet<{
    participants?: { signedinUser?: { displayName?: string }; anonymousUser?: { displayName?: string }; phoneUser?: { displayName?: string } }[];
  }>(accessToken, `${conferenceRecordName}/participants`);
  return (data.participants ?? [])
    .map((p) => p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName)
    .filter((n): n is string => !!n);
}

async function fetchTranscriptText(accessToken: string, conferenceRecordName: string): Promise<string | undefined> {
  const { transcripts } = await meetApiGet<{ transcripts?: { name: string }[] }>(accessToken, `${conferenceRecordName}/transcripts`);
  const transcript = transcripts?.[0];
  if (!transcript) return undefined;

  const lines: string[] = [];
  let pageToken: string | undefined;
  do {
    const qs = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
    const page = await meetApiGet<{
      transcriptEntries?: { text: string; participant?: string }[];
      nextPageToken?: string;
    }>(accessToken, `${transcript.name}/entries${qs}`);
    for (const entry of page.transcriptEntries ?? []) lines.push(entry.text);
    pageToken = page.nextPageToken;
  } while (pageToken);

  return lines.join("\n");
}

export async function backfillRecentGoogleMeet(env: Env): Promise<void> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL) return; // connector not configured

  const accessToken = await getAccessToken(env);
  const sinceISO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const records = await listRecentConferenceRecords(accessToken, sinceISO);

  for (const record of records) {
    try {
      const existing = await env.DB.prepare(`SELECT 1 FROM context_chunks WHERE source = 'google_meet' AND source_ref = ?1 LIMIT 1`)
        .bind(record.name)
        .first();
      if (existing) continue;

      const text = await fetchTranscriptText(accessToken, record.name);
      if (!text) continue;

      const participantNames = await fetchParticipantNames(accessToken, record.name);
      const accountId = await resolveAccountId(env, { emails: [], title: participantNames.join(" ") });
      if (!accountId) continue;

      await ingestDocument(env, {
        accountId,
        source: "google_meet",
        sourceRef: record.name,
        text,
        occurredAt: record.startTime.slice(0, 10),
      });
    } catch (err) {
      console.error(`google meet backfill failed for ${record.name}`, err);
    }
  }
}
