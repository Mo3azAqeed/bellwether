/** Turning an account's context into an engineering ticket worth reading.
 *
 * The point isn't to save typing. It's that the ticket an engineer opens
 * carries the customer's own words and a link to where they said them —
 * so the first question ("is this real, or did someone relay it third-hand?")
 * is already answered, and the second ("what exactly did they hit?") doesn't
 * need a thread with the CSM.
 *
 * The draft is structured rather than a blob of markdown, because the two
 * trackers want different things: Linear takes markdown, and Jira Cloud's v3
 * API wants Atlassian Document Format — a nested JSON tree. Rendering both
 * from one structure beats writing a markdown-to-ADF converter, and keeps
 * the evidence machine-readable for whatever comes third.
 *
 * Pure: no env, no network. */

import type { RetrievedChunk } from "../rag/retrieve.js";

export interface TicketEvidence {
  /** The record's own words. Never paraphrased — the whole value is that
   * an engineer can quote it back. */
  quote: string;
  source: string;
  occurredAt: string | null;
  url: string | null;
}

export interface TicketDraft {
  title: string;
  accountName: string;
  /** Why this is being filed, in one paragraph — the CSM's framing. */
  summary: string;
  evidence: TicketEvidence[];
  /** Account facts an engineer needs to judge urgency: seats, renewal. */
  facts: string[];
}

const MAX_TITLE = 110;
const MAX_QUOTE = 400;
const MAX_EVIDENCE = 5;

/** Trackers show a truncated title everywhere; a long one is unreadable in
 * a list. Cuts on a word boundary rather than mid-syllable. */
export function ticketTitle(accountName: string, topic: string): string {
  const cleaned = topic.replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "");
  const prefix = `[${accountName}] `;
  const room = MAX_TITLE - prefix.length;
  if (cleaned.length <= room) return `${prefix}${cleaned}`;
  const cut = cleaned.slice(0, room - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${prefix}${(lastSpace > room * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export interface DraftInput {
  accountName: string;
  topic: string;
  summary: string;
  chunks: RetrievedChunk[];
  facts?: string[];
}

export function buildTicketDraft(input: DraftInput): TicketDraft {
  return {
    title: ticketTitle(input.accountName, input.topic),
    accountName: input.accountName,
    summary: input.summary.trim(),
    evidence: input.chunks.slice(0, MAX_EVIDENCE).map((c) => {
      const flat = c.chunkText.replace(/\s+/g, " ").trim();
      return {
        quote: flat.length > MAX_QUOTE ? `${flat.slice(0, MAX_QUOTE).trimEnd()}…` : flat,
        source: c.source,
        occurredAt: c.occurredAt,
        url: c.url,
      };
    }),
    facts: input.facts ?? [],
  };
}

function evidenceLabel(e: TicketEvidence): string {
  return `${e.source}${e.occurredAt ? ` · ${e.occurredAt}` : ""}`;
}

/** Markdown, for Linear and for showing a human what will be filed. */
export function renderTicketMarkdown(draft: TicketDraft): string {
  const lines: string[] = [draft.summary, ""];

  if (draft.facts.length) {
    lines.push(`**${draft.accountName}:** ${draft.facts.join(" · ")}`, "");
  }

  if (draft.evidence.length) {
    lines.push("### What the customer actually said", "");
    for (const e of draft.evidence) {
      lines.push(`> ${e.quote}`, "", e.url ? `— [${evidenceLabel(e)}](${e.url})` : `— ${evidenceLabel(e)}`, "");
    }
  } else {
    lines.push("_No customer records were attached to this ticket._", "");
  }

  lines.push("---", "Filed from Bellwether. Every quote above links to the record it came from.");
  return lines.join("\n");
}

/** Atlassian Document Format, which Jira Cloud's v3 API requires for rich
 * text fields — a plain string in `description` is rejected. Only the node
 * types needed here, built directly rather than parsed out of markdown. */
type AdfNode = Record<string, unknown>;

function paragraph(text: string): AdfNode {
  return { type: "paragraph", content: text ? [{ type: "text", text }] : [] };
}

function linkedParagraph(label: string, url: string | null): AdfNode {
  if (!url) return paragraph(`— ${label}`);
  return {
    type: "paragraph",
    content: [
      { type: "text", text: "— " },
      { type: "text", text: label, marks: [{ type: "link", attrs: { href: url } }] },
    ],
  };
}

export function renderTicketAdf(draft: TicketDraft): AdfNode {
  const content: AdfNode[] = [paragraph(draft.summary)];

  if (draft.facts.length) {
    content.push(paragraph(`${draft.accountName}: ${draft.facts.join(" · ")}`));
  }

  if (draft.evidence.length) {
    content.push({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "What the customer actually said" }],
    });
    for (const e of draft.evidence) {
      content.push({ type: "blockquote", content: [paragraph(e.quote)] });
      content.push(linkedParagraph(evidenceLabel(e), e.url));
    }
  } else {
    content.push(paragraph("No customer records were attached to this ticket."));
  }

  content.push({ type: "rule" });
  content.push(paragraph("Filed from Bellwether. Every quote above links to the record it came from."));

  return { type: "doc", version: 1, content };
}
