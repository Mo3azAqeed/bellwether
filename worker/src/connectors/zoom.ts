/** Zoom cloud-recording transcript connector. Webhook-only (no backfill
 * path like Fireflies' — Zoom's REST API for listing past recordings needs
 * a full OAuth app, not just a webhook secret; add that later if webhook
 * misses turn out to matter in practice).
 *
 * Setup, in Zoom's Marketplace app config: subscribe to
 * "All Recordings have completed transcription"
 * (`recording.transcript_completed`), point its event notification URL at
 * `.../webhooks/zoom`, and copy the Secret Token into
 * ZOOM_WEBHOOK_SECRET_TOKEN. Verify field names against
 * https://developers.zoom.us/docs/api/webhooks/ if Zoom's payload shape has
 * since changed. */

import type { Env } from "../env.js";
import { ingestDocument } from "../rag/ingest.js";
import { resolveAccountId } from "./resolve-account.js";
import { parseVtt } from "./vtt.js";

interface ZoomRecordingFile {
  file_type: string;
  download_url: string;
}

interface ZoomTranscriptCompletedPayload {
  event: string;
  payload: {
    object: {
      uuid: string;
      host_email: string;
      topic: string;
      start_time: string;
      /** Zoom's own web page for the recording. Optional because it is
       * absent on recordings with sharing disabled — in which case the
       * citation simply carries no link rather than a broken one. */
      share_url?: string;
      recording_files: ZoomRecordingFile[];
    };
  };
  // Zoom includes this alongside recording-related webhooks specifically so
  // you can download the files without a separate OAuth token.
  download_token?: string;
}

async function toHex(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(mac);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Zoom's one-time "endpoint.url_validation" handshake: echo back a hash of
 * the token they send, proving you hold the secret, before they'll deliver
 * real events to this URL. */
export async function handleZoomUrlValidation(secretToken: string, plainToken: string): Promise<{ plainToken: string; encryptedToken: string }> {
  return { plainToken, encryptedToken: await hmacHex(secretToken, plainToken) };
}

export async function verifyZoomSignature(
  secretToken: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  rawBody: string
): Promise<boolean> {
  if (!timestampHeader || !signatureHeader) return false;
  const expected = `v0=${await hmacHex(secretToken, `v0:${timestampHeader}:${rawBody}`)}`;
  return timingSafeEqual(expected, signatureHeader);
}

export async function ingestZoomTranscript(env: Env, body: ZoomTranscriptCompletedPayload): Promise<{ skipped: string } | { chunksStored: number }> {
  const { object } = body.payload;
  const transcriptFile = object.recording_files.find((f) => f.file_type === "TRANSCRIPT");
  if (!transcriptFile) return { skipped: "no TRANSCRIPT file in this recording.completed payload" };

  const existing = await env.DB.prepare(`SELECT 1 FROM context_chunks WHERE source = 'zoom' AND source_ref = ?1 LIMIT 1`)
    .bind(object.uuid)
    .first();
  if (existing) return { skipped: "already ingested" };

  const downloadUrl = body.download_token
    ? `${transcriptFile.download_url}?access_token=${body.download_token}`
    : transcriptFile.download_url;
  const resp = await fetch(downloadUrl);
  if (!resp.ok) throw new Error(`Failed to download Zoom transcript: HTTP ${resp.status}`);
  const vtt = await resp.text();
  const text = parseVtt(vtt);

  const accountId = await resolveAccountId(env, { emails: [object.host_email], title: object.topic });
  if (!accountId) return { skipped: `could not resolve an account for "${object.topic}"` };

  return ingestDocument(env, {
    accountId,
    source: "zoom",
    sourceRef: object.uuid,
    // A Zoom recording id can't be turned into a URL, so the payload's own
    // share_url is the only way a citation gets to link back to the call.
    sourceUrl: object.share_url,
    text: `${object.topic}\n\n${text}`,
    occurredAt: object.start_time.slice(0, 10),
  });
}
