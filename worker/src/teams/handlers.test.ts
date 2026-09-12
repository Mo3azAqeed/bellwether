import { describe, expect, it } from "vitest";
import { stripMentionEntities, extractActionValue, type TeamsActivity } from "./handlers.js";

function baseActivity(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    conversation: { id: "conv-1" },
    serviceUrl: "https://smba.example.com/",
    recipient: { id: "28:bot-id" },
    ...overrides,
  };
}

describe("stripMentionEntities", () => {
  it("removes the bot's own mention tag, leaving the rest of the text", () => {
    const activity = baseActivity({
      text: "<at>Bell</at> how is Northwind doing?",
      entities: [{ type: "mention", text: "<at>Bell</at>", mentioned: { id: "28:bot-id", name: "Bell" } }],
    });
    expect(stripMentionEntities(activity)).toBe("how is Northwind doing?");
  });

  it("leaves a mention of someone other than the bot alone", () => {
    const activity = baseActivity({
      text: "<at>Jane</at> can you check on Northwind? <at>Bell</at> why is it declining?",
      entities: [
        { type: "mention", text: "<at>Jane</at>", mentioned: { id: "28:jane-id", name: "Jane" } },
        { type: "mention", text: "<at>Bell</at>", mentioned: { id: "28:bot-id", name: "Bell" } },
      ],
    });
    expect(stripMentionEntities(activity)).toBe("<at>Jane</at> can you check on Northwind? why is it declining?");
  });

  it("handles no entities at all (a DM, or a plain message)", () => {
    const activity = baseActivity({ text: "how is Northwind doing?", entities: undefined });
    expect(stripMentionEntities(activity)).toBe("how is Northwind doing?");
  });
});

describe("extractActionValue", () => {
  it("reads .value off a plain message activity (the classic Action.Submit delivery)", () => {
    const activity = baseActivity({ type: "message", value: { action: "explain_account", accountId: "acct-001" } });
    expect(extractActionValue(activity)).toEqual({ action: "explain_account", accountId: "acct-001" });
  });

  it("reads nested action.data off an invoke activity (Universal Actions model)", () => {
    const activity = baseActivity({
      type: "invoke",
      name: "adaptiveCard/action",
      value: { action: { type: "Action.Execute", data: { action: "explain_account", accountId: "acct-001" } } },
    });
    expect(extractActionValue(activity)).toEqual({ action: "explain_account", accountId: "acct-001" });
  });

  it("returns undefined for a plain message with no value (not a button click)", () => {
    const activity = baseActivity({ type: "message", text: "hello" });
    expect(extractActionValue(activity)).toBeUndefined();
  });

  it("returns undefined for an unrelated invoke activity", () => {
    const activity = baseActivity({ type: "invoke", name: "some/other/invoke", value: { foo: "bar" } });
    expect(extractActionValue(activity)).toBeUndefined();
  });
});
