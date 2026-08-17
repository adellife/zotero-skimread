import { assert } from "chai";
import {
  parseAntigravityCurrentModel,
  parseAntigravityEnvelope,
  parseAntigravityModels,
} from "../src/llm/ollama";

describe("provider output", function () {
  it("unwraps Antigravity structured output and usage", function () {
    const result = parseAntigravityEnvelope(
      [
        "warning: harmless CLI notice",
        JSON.stringify({
          status: "SUCCESS",
          response: '```json\n{"ok":true}\n```',
          structured_output: { ok: true },
          usage: { input_tokens: 22919, output_tokens: 30 },
        }),
      ].join("\n"),
    );
    assert.deepEqual(result, {
      value: { ok: true },
      inputTokens: 22919,
      outputTokens: 30,
    });
  });

  it("falls back to JSON embedded in the response", function () {
    const result = parseAntigravityEnvelope(
      JSON.stringify({
        status: "SUCCESS",
        response: 'The result is:\n```json\n{"ok":true}\n```',
      }),
    );
    assert.deepEqual(result.value, { ok: true });
  });

  it("surfaces an unsuccessful Antigravity status", function () {
    assert.throws(
      () =>
        parseAntigravityEnvelope(
          JSON.stringify({ status: "FAILED", error: "not signed in" }),
        ),
      "not signed in",
    );
  });

  it("parses Antigravity model tables with tabs, spaces, and progress text", function () {
    assert.deepEqual(
      parseAntigravityModels(
        [
          "Fetching available models...",
          "\u001b[2K⠋gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
          "claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)",
          "gemini-3.7-flash-low\tduplicate",
        ].join("\n"),
      ),
      ["gemini-3.7-flash-low", "claude-sonnet-4-6"],
    );
  });

  it("parses the current Antigravity model from the print command", function () {
    assert.equal(
      parseAntigravityCurrentModel(
        JSON.stringify({
          status: "SUCCESS",
          response: "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n",
          usage: { input_tokens: 0, output_tokens: 0 },
          command: {
            name: "model",
            data: { id: "gemini-3.7-flash-high" },
          },
        }),
      ),
      "gemini-3.7-flash-high",
    );
  });
});
