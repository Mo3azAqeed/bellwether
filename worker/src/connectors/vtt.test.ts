import { describe, expect, it } from "vitest";
import { parseVtt } from "./vtt.js";

describe("parseVtt", () => {
  it("strips the header, cue numbers, and timestamps, keeping speaker text", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:00.000 --> 00:00:03.000",
      "Maya: Hey Northwind, thanks for joining.",
      "",
      "2",
      "00:00:03.000 --> 00:00:06.000",
      "Alex (Northwind): Sure, happy to be here.",
      "",
    ].join("\n");

    expect(parseVtt(vtt)).toBe(
      "Maya: Hey Northwind, thanks for joining.\nAlex (Northwind): Sure, happy to be here."
    );
  });

  it("handles CRLF line endings", () => {
    const vtt = "WEBVTT\r\n\r\n1\r\n00:00:00.000 --> 00:00:01.000\r\nHello\r\n";
    expect(parseVtt(vtt)).toBe("Hello");
  });
});
