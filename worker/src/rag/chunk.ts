/** Splits text into roughly-sized, overlapping chunks for embedding.
 * Prefers to break on paragraph/sentence boundaries so a chunk doesn't end
 * mid-thought — that matters more for retrieval quality here than hitting
 * an exact character count. Pure function, no I/O, so it's unit-testable
 * without a Workers runtime. */

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 150;

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function chunkText(
  text: string,
  maxChars: number = DEFAULT_MAX_CHARS,
  overlapChars: number = DEFAULT_OVERLAP_CHARS
): string[] {
  const normalized = text.trim().replace(/\r\n/g, "\n");
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const sentences = splitIntoSentences(normalized);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      const tail = current.slice(-overlapChars);
      current = `${tail} ${sentence}`.trim();
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
