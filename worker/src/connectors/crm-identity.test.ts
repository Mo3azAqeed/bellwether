import { describe, expect, it } from "vitest";
import { domainFromWebsite } from "./salesforce.js";
import { readCompanyIdentity } from "./attio.js";

/** Both CRM connectors resolve a Bellwether account from whatever the CRM
 * calls a domain, and both fields are free text a human typed — so these
 * guard the "don't guess, return undefined" boundary rather than the happy
 * path alone. Ingesting under the wrong account is worse than skipping. */

describe("domainFromWebsite (Salesforce)", () => {
  it("reads a bare domain", () => {
    expect(domainFromWebsite("acme.com")).toBe("acme.com");
  });

  it("strips scheme, www, path and query", () => {
    expect(domainFromWebsite("https://www.acme.com/careers?ref=x")).toBe("acme.com");
  });

  it("lowercases and trims", () => {
    expect(domainFromWebsite("  HTTP://Acme.COM  ")).toBe("acme.com");
  });

  it("keeps subdomains other than www", () => {
    expect(domainFromWebsite("https://eu.acme.com")).toBe("eu.acme.com");
  });

  it("returns undefined for empty, null and whitespace", () => {
    expect(domainFromWebsite(null)).toBeUndefined();
    expect(domainFromWebsite(undefined)).toBeUndefined();
    expect(domainFromWebsite("   ")).toBeUndefined();
  });

  it("returns undefined for a value with no dot rather than inventing a domain", () => {
    expect(domainFromWebsite("intranet")).toBeUndefined();
  });
});

describe("readCompanyIdentity (Attio)", () => {
  it("reads name and domain from the current attribute values", () => {
    expect(
      readCompanyIdentity({ values: { name: [{ value: "Northwind" }], domains: [{ domain: "northwind.io" }] } })
    ).toEqual({ name: "Northwind", domain: "northwind.io" });
  });

  it("falls back to full_domain when domain isn't present", () => {
    expect(readCompanyIdentity({ values: { domains: [{ full_domain: "www.Northwind.IO" }] } })).toEqual({
      name: undefined,
      domain: "northwind.io",
    });
  });

  it("falls back to a plain string value for the domain attribute", () => {
    expect(readCompanyIdentity({ values: { domains: [{ value: "northwind.io" }] } }).domain).toBe("northwind.io");
  });

  it("returns undefined domain when the value isn't domain-shaped", () => {
    expect(readCompanyIdentity({ values: { domains: [{ domain: "not-a-domain" }] } }).domain).toBeUndefined();
  });

  it("survives a record with no values at all", () => {
    expect(readCompanyIdentity({})).toEqual({ name: undefined, domain: undefined });
  });

  it("ignores a blank name", () => {
    expect(readCompanyIdentity({ values: { name: [{ value: "   " }] } }).name).toBeUndefined();
  });
});
