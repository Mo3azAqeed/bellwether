/** The timeline as text, for the places that can't render HTML: a coding
 * agent over MCP, and a Slack reply.
 *
 * Same content as the page, same order, same rule about provenance — every
 * entry says where it came from and carries a link when the record has one.
 * A terminal reader should not get a worse answer than a browser reader,
 * only a plainer one.
 *
 * Pure: takes a Timeline, returns a string. */

import type { Timeline, TimelineEvent } from "./data.js";

function day(at: string): string {
  return at.slice(0, 10);
}

function tierWords(tier: string): string {
  return tier.replace("_", " ");
}

function eventLines(ev: TimelineEvent, link: (label: string, url: string) => string): string[] {
  if (ev.kind === "context") {
    const ref = ev.sourceRef ? ` ${ev.sourceRef}` : "";
    const chunks = ev.chunkCount > 1 ? ` · ${ev.chunkCount} chunks` : "";
    return [
      `${day(ev.at)}  ${ev.source}${ref}${chunks}`,
      ...(ev.url ? [`          ${link("open", ev.url)}`] : []),
      `          ${ev.excerpt}`,
    ];
  }

  if (ev.kind === "tier") {
    const movement = ev.from ? `${tierWords(ev.from)} → ${tierWords(ev.to)}` : `first reading: ${tierWords(ev.to)}`;
    return [
      `${day(ev.at)}  health tier — ${movement}`,
      `          ${ev.activeSeats} active seats, ${ev.deltaPct > 0 ? "+" : ""}${ev.deltaPct}% vs its own baseline`,
    ];
  }

  const used = ev.used.length
    ? ev.used.map((u) => `${u.source}${u.occurredAt ? ` · ${day(u.occurredAt)}` : ""}${u.url ? ` ${u.url}` : ""}`).join(", ")
    : "nothing — retrieval came back empty";
  return [
    `${day(ev.at)}  Bell was asked — ${ev.provider} (${ev.model})`,
    `          Q: ${ev.question}`,
    `          A: ${ev.answer}`,
    `          built from: ${used}`,
  ];
}

export function renderTimelineText(
  timeline: Timeline,
  options: { link?: (label: string, url: string) => string; limit?: number } = {}
): string {
  const link = options.link ?? ((_label, url) => url);
  const { account, events } = timeline;
  const shown = options.limit ? events.slice(0, options.limit) : events;

  const header = [
    `${account.name} — ${account.tier ? tierWords(account.tier) : "no health reading yet"}`,
    `${account.plan} plan · ${account.seatsPurchased} seats · renews ${account.renewalDate} · owner ${account.owner ?? "unassigned"}`,
    "",
  ];

  if (!shown.length) {
    return [
      ...header,
      "Nothing on file for this account yet. Connect a source and its calls, tickets and CRM notes will appear here.",
    ].join("\n");
  }

  const body = shown.flatMap((ev) => [...eventLines(ev, link), ""]);
  const footer =
    events.length > shown.length ? [`…and ${events.length - shown.length} older entries.`] : [];

  return [...header, "Newest first. Every entry is where a claim about this account can be checked.", "", ...body, ...footer]
    .join("\n")
    .trimEnd();
}
