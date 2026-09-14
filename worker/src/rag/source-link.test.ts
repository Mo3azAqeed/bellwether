import { describe, expect, it } from "vitest";
import { configFromSettings, sourceLink, SOURCE_LINK_SETTING_KEYS } from "./source-link.js";

/** These guard the thing that makes a citation worth having: it goes to the
 * right record, or it doesn't pretend to go anywhere. A link to a 404 is
 * worse than no link, because it claims evidence exists and then can't
 * produce it — on a renewal call that is the whole credibility of the tool. */

const CONFIG = {
  zendeskSubdomain: "northwind",
  salesforceInstanceUrl: "https://acme.my.salesforce.com",
  intercomAppId: "abc12345",
  hubspotPortalId: "7788990",
};

describe("sourceLink — a URL the connector captured", () => {
  it("prefers the stored URL over anything it could derive", () => {
    const link = sourceLink(
      { source: "zendesk", sourceRef: "4412", sourceUrl: "https://northwind.zendesk.com/agent/tickets/4412?from=webhook" },
      CONFIG
    );
    expect(link).toBe("https://northwind.zendesk.com/agent/tickets/4412?from=webhook");
  });

  it("carries a URL for sources it has no id-to-URL rule for", () => {
    expect(sourceLink({ source: "zoom", sourceRef: "abc==", sourceUrl: "https://zoom.us/rec/share/xyz" })).toBe(
      "https://zoom.us/rec/share/xyz"
    );
  });

  it("refuses a stored value that isn't an http(s) URL", () => {
    // Stored values come from vendor payloads, which are data, not promises.
    expect(sourceLink({ source: "zoom", sourceRef: "x", sourceUrl: "javascript:alert(1)" })).toBeUndefined();
    expect(sourceLink({ source: "zoom", sourceRef: "x", sourceUrl: "not a url" })).toBeUndefined();
  });

  it("falls back to deriving when the stored URL is unusable", () => {
    expect(sourceLink({ source: "fireflies", sourceRef: "tr-99", sourceUrl: "ftp://nope" })).toBe(
      "https://app.fireflies.ai/view/tr-99"
    );
  });
});

describe("sourceLink — derived from an id", () => {
  it("links a Fireflies transcript without needing any configuration", () => {
    expect(sourceLink({ source: "fireflies", sourceRef: "01HXYZ" })).toBe("https://app.fireflies.ai/view/01HXYZ");
  });

  it("links a Zendesk ticket into the agent view", () => {
    expect(sourceLink({ source: "zendesk", sourceRef: "4412" }, CONFIG)).toBe(
      "https://northwind.zendesk.com/agent/tickets/4412"
    );
  });

  it("links a Salesforce task into Lightning, on the org's own host", () => {
    expect(sourceLink({ source: "salesforce", sourceRef: "00T5g00000ABCDE" }, CONFIG)).toBe(
      "https://acme.my.salesforce.com/lightning/r/Task/00T5g00000ABCDE/view"
    );
  });

  it("doesn't double a slash when the instance URL has a trailing one", () => {
    expect(sourceLink({ source: "salesforce", sourceRef: "00T1" }, { salesforceInstanceUrl: "https://acme.my.salesforce.com/" })).toBe(
      "https://acme.my.salesforce.com/lightning/r/Task/00T1/view"
    );
  });

  it("links an Intercom conversation and a HubSpot note", () => {
    expect(sourceLink({ source: "intercom", sourceRef: "9981" }, CONFIG)).toBe(
      "https://app.intercom.com/a/apps/abc12345/conversations/9981"
    );
    expect(sourceLink({ source: "hubspot", sourceRef: "551" }, CONFIG)).toBe(
      "https://app.hubspot.com/contacts/7788990/record/0-46/551"
    );
  });

  it("treats a ref that is already a URL as the link", () => {
    expect(sourceLink({ source: "manual", sourceRef: "https://wiki.internal/notes/42" })).toBe(
      "https://wiki.internal/notes/42"
    );
  });
});

describe("sourceLink — when it declines to guess", () => {
  it("returns nothing without the workspace identifier a source needs", () => {
    expect(sourceLink({ source: "zendesk", sourceRef: "4412" })).toBeUndefined();
    expect(sourceLink({ source: "salesforce", sourceRef: "00T1" })).toBeUndefined();
    expect(sourceLink({ source: "intercom", sourceRef: "9981" })).toBeUndefined();
    expect(sourceLink({ source: "hubspot", sourceRef: "551" })).toBeUndefined();
  });

  it("returns nothing for a source with no linkable record", () => {
    expect(sourceLink({ source: "manual", sourceRef: "pasted-export" }, CONFIG)).toBeUndefined();
    expect(sourceLink({ source: "google-meet", sourceRef: "spaces/abc" }, CONFIG)).toBeUndefined();
    expect(sourceLink({ source: "attio", sourceRef: "n-4412" }, CONFIG)).toBeUndefined();
  });

  it("returns nothing when there is no ref to build from", () => {
    expect(sourceLink({ source: "zendesk", sourceRef: null }, CONFIG)).toBeUndefined();
    expect(sourceLink({ source: "zendesk", sourceRef: "   " }, CONFIG)).toBeUndefined();
    expect(sourceLink({ source: "fireflies" })).toBeUndefined();
  });

  it("won't splice a ref containing path or query characters into a template", () => {
    // "4412/../../admin" in a URL template is a plausible-looking link to
    // the wrong place, which is the failure this whole module exists to avoid.
    expect(sourceLink({ source: "zendesk", sourceRef: "4412/../../admin" }, CONFIG)).toBeUndefined();
    expect(sourceLink({ source: "zendesk", sourceRef: "4412?x=1" }, CONFIG)).toBeUndefined();
    expect(sourceLink({ source: "fireflies", sourceRef: "a b" })).toBeUndefined();
  });

  it("escapes a ref that is odd but still a single segment", () => {
    expect(sourceLink({ source: "fireflies", sourceRef: "a&b" })).toBe("https://app.fireflies.ai/view/a%26b");
  });
});

describe("configFromSettings", () => {
  it("maps every documented key, and survives a completely empty settings table", () => {
    expect(configFromSettings({ ZENDESK_SUBDOMAIN: "northwind", HUBSPOT_PORTAL_ID: "7788990" })).toEqual({
      zendeskSubdomain: "northwind",
      salesforceInstanceUrl: undefined,
      intercomAppId: undefined,
      hubspotPortalId: "7788990",
    });
    expect(sourceLink({ source: "zendesk", sourceRef: "1" }, configFromSettings({}))).toBeUndefined();
  });

  it("names exactly the keys retrieval needs to fetch", () => {
    expect([...SOURCE_LINK_SETTING_KEYS]).toEqual([
      "ZENDESK_SUBDOMAIN",
      "SALESFORCE_INSTANCE_URL",
      "INTERCOM_APP_ID",
      "HUBSPOT_PORTAL_ID",
    ]);
  });
});
