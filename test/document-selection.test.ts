import { assert } from "chai";
import {
  DEFAULT_LABELS,
  buildDocumentSelectionPrompt,
  validateDocumentSelection,
} from "../src/prompts/skim";

describe("document selection", function () {
  it("keeps stable IDs and page context in the full-document prompt", function () {
    const prompt = buildDocumentSelectionPrompt(
      [
        {
          id: 0,
          pageIndex: 0,
          section: "introduction",
          text: "The study introduces a new method.",
        },
        {
          id: 1,
          pageIndex: 2,
          section: "results",
          text: "The method improves accuracy.",
        },
      ],
      10,
    );
    assert.include(prompt, "0 | page 1");
    assert.include(prompt, "1 | page 3");
    assert.include(prompt, "section introduction");
    assert.include(prompt, "section results");
    assert.include(prompt, "at most 10 selected sentences per page");
  });

  it("accepts unique in-range selected IDs", function () {
    const result = validateDocumentSelection(
      {
        selected: [
          { id: 0, label: "goal", importance: 0.8 },
          { id: 2, label: "result", importance: 1.2 },
        ],
      },
      DEFAULT_LABELS,
      3,
    );
    assert.deepEqual(result, [
      { id: 0, label: "goal", importance: 0.8 },
      { id: 2, label: "result", importance: 1 },
    ]);
  });

  it("rejects duplicate, out-of-range, and unknown-label selections", function () {
    assert.isNull(
      validateDocumentSelection(
        {
          selected: [
            { id: 0, label: "goal", importance: 0.8 },
            { id: 0, label: "result", importance: 0.9 },
          ],
        },
        DEFAULT_LABELS,
        2,
      ),
    );
    assert.isNull(
      validateDocumentSelection(
        { selected: [{ id: 2, label: "goal", importance: 0.8 }] },
        DEFAULT_LABELS,
        2,
      ),
    );
    assert.isNull(
      validateDocumentSelection(
        { selected: [{ id: 0, label: "unknown", importance: 0.8 }] },
        DEFAULT_LABELS,
        2,
      ),
    );
  });
});
