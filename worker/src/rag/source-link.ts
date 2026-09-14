/** Turns a stored chunk back into a link to the record it came from.
 *
 * A citation that says "intercom · 2026-08-22" tells you a ticket exists.
 * It doesn't tell you which one, and it can't be checked. That gap is the
 * difference between a tool a CSM trusts on a renewal call and one they
 * quietly stop believing — so every source Bellwether can link, it links.
 *
 * Two ways a link is found, in this order:
 *
 *   1. The URL the connector stored at ingest. Some vendors hand one over
 *      in the payload (Zoom's share_url), and theirs is always right.
 *   2. Derived from the source's own id plus workspace config we already
 *      hold — a Zendesk subdomain, a Salesforce instance URL.
 *
 * Anything else returns undefined, and undefined renders as no link. A
 * wrong link is worse than no link: it sends someone to a 404 while
 * claiming the evidence exists, which is exactly the trust this feature is
 * supposed to buy.
 *
 * Pure — takes config, returns a string. The settings lookup lives in
 * retrieve.ts, so this stays testable without a database. */

/** Workspace identifiers a link can be derived from. Every one is optional:
 * a missing identifier costs that source its links, nothing more. */
export interface SourceLinkConfig {
  /** "yourcompany" in yourcompany.zendesk.com */
  zendeskSubdomain?: string;
  /** https://acme.my.salesforce.com */
  salesforceInstanceUrl?: string;
  /** Intercom workspace ("app") id — Intercom's own URLs need it. */
  intercomAppId?: string;
  /** HubSpot portal/hub id, the number in every app.hubspot.com URL. */
  hubspotPortalId?: string;
}

/** The settings keys `SourceLinkConfig` is built from, so retrieve.ts can
 * fetch exactly these in one call. */
export const SOURCE_LINK_SETTING_KEYS = [
  "ZENDESK_SUBDOMAIN",
  "SALESFORCE_INSTANCE_URL",
  "INTERCOM_APP_ID",
  "HUBSPOT_PORTAL_ID",
] as const;

export function configFromSettings(settings: Record<string, string | undefined>): SourceLinkConfig {
  return {
    zendeskSubdomain: settings.ZENDESK_SUBDOMAIN,
    salesforceInstanceUrl: settings.SALESFORCE_INSTANCE_URL,
    intercomAppId: settings.INTERCOM_APP_ID,
    hubspotPortalId: settings.HUBSPOT_PORTAL_ID,
  };
}

export interface LinkableChunk {
  source: string;
  sourceRef?: string | null;
  /** Captured at ingest, when the connector's payload carried one. */
  sourceUrl?: string | null;
}

/** Only http(s). A stored value comes from a vendor payload, and a payload
 * is data, not a promise — a `javascript:` URL rendered into a Slack
 * message would be someone else's bug report. */
function safeUrl(candidate: string | null | undefined): string | undefined {
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function trimSlashes(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** HubSpot's object-type id for a Note. Their record URLs are built from
 * the object type rather than a friendly name. */
const HUBSPOT_NOTE_OBJECT = "0-46";

export function sourceLink(chunk: LinkableChunk, config: SourceLinkConfig = {}): string | undefined {
  // A URL the vendor gave us always wins over one we reconstruct.
  const stored = safeUrl(chunk.sourceUrl);
  if (stored) return stored;

  const ref = chunk.sourceRef?.trim();
  if (!ref) return undefined;

  // Some connectors already store a URL as the ref itself.
  const refAsUrl = safeUrl(ref);
  if (refAsUrl) return refAsUrl;

  // An id with a slash or a space in it isn't an id we recognise, and
  // pasting it into a URL template would produce a plausible-looking link
  // to nothing.
  if (/[\s/?#]/.test(ref)) return undefined;

  switch (chunk.source) {
    case "fireflies":
      return `https://app.fireflies.ai/view/${encodeURIComponent(ref)}`;

    case "zendesk":
      return config.zendeskSubdomain
        ? `https://${config.zendeskSubdomain.trim()}.zendesk.com/agent/tickets/${encodeURIComponent(ref)}`
        : undefined;

    case "salesforce": {
      const host = config.salesforceInstanceUrl ? safeUrl(config.salesforceInstanceUrl) : undefined;
      return host ? `${trimSlashes(host)}/lightning/r/Task/${encodeURIComponent(ref)}/view` : undefined;
    }

    case "intercom":
      return config.intercomAppId
        ? `https://app.intercom.com/a/apps/${encodeURIComponent(config.intercomAppId.trim())}/conversations/${encodeURIComponent(ref)}`
        : undefined;

    case "hubspot":
      return config.hubspotPortalId
        ? `https://app.hubspot.com/contacts/${encodeURIComponent(config.hubspotPortalId.trim())}/record/${HUBSPOT_NOTE_OBJECT}/${encodeURIComponent(ref)}`
        : undefined;

    // zoom, google-meet and attio have no id-to-URL rule that holds without
    // more workspace context than we store, so they rely on the connector
    // capturing a URL at ingest. manual/generic ingests have no record to
    // link to at all.
    default:
      return undefined;
  }
}

/** How a citation names its source in prose: the source, its date, and —
 * when there is one — somewhere to go and read it. */
export function citationLabel(chunk: LinkableChunk & { occurredAt?: string | null }): string {
  return `${chunk.source}${chunk.occurredAt ? ` · ${chunk.occurredAt}` : ""}`;
}
