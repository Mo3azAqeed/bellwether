/** Minimal WebVTT parser — just enough to turn a transcript file (what
 * Zoom's cloud recording transcripts are) into plain text. Strips the
 * "WEBVTT" header, cue-number lines, and timestamp lines; keeps everything
 * else (Zoom's cue text is usually already "Speaker Name: said this"). Pure
 * function, unit-testable without a Workers runtime. */

const TIMESTAMP_LINE = /-->/;
const CUE_NUMBER_LINE = /^\d+$/;

export function parseVtt(vtt: string): string {
  const lines = vtt.replace(/\r\n/g, "\n").split("\n");
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "WEBVTT") continue;
    if (CUE_NUMBER_LINE.test(trimmed)) continue;
    if (TIMESTAMP_LINE.test(trimmed)) continue;
    textLines.push(trimmed);
  }

  return textLines.join("\n");
}
