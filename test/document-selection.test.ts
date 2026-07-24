import { assert } from "chai";
import {
  DEFAULT_LABELS,
  buildDocumentSelectionPrompt,
  validateDocumentSelection,
} from "../src/prompts/skim";
import { chunkSentences, splitIntoBands } from "../src/modules/skim";

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

  it("keeps the first of duplicate ids and drops later ones", function () {
    assert.deepEqual(
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
      [{ id: 0, label: "goal", importance: 0.8 }],
    );
  });

  it("returns null when nothing is usable (out-of-range or unknown label)", function () {
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

  it("tolerates string ids, aliased score fields, and label casing", function () {
    assert.deepEqual(
      validateDocumentSelection(
        {
          selected: [
            { id: "1", label: "Goal", confidence: 0.6 },
            { id: 0, label: "method" },
          ],
        },
        DEFAULT_LABELS,
        3,
      ),
      [
        { id: 1, label: "goal", importance: 0.6 },
        { id: 0, label: "method", importance: 0.7 },
      ],
    );
  });

  describe("chunked selection for long documents", function () {
    const sentence = (
      pageIndex: number,
      section:
        | "front matter"
        | "abstract"
        | "introduction"
        | "methods"
        | "results"
        | "discussion"
        | "conclusion"
        | "appendix"
        | "references"
        | "body",
      text: string,
    ) => ({ pageIndex, startChar: 0, endChar: text.length, text, section });

    it("keeps a short document in a single chunk", async function () {
      const sentences = [
        sentence(0, "abstract", "A".repeat(100)),
        sentence(1, "introduction", "B".repeat(100)),
      ];
      const chunks = chunkSentences(sentences, 10_000);
      assert.lengthOf(chunks, 1);
      assert.lengthOf(chunks[0], 2);
    });

    it("splits an oversized document, preserving order and completeness", async function () {
      const sentences = [];
      for (let page = 0; page < 30; page++) {
        const section = page < 15 ? "introduction" : "discussion";
        for (let index = 0; index < 5; index++) {
          sentences.push(
            sentence(page, section, `p${page}s${index} ` + "x".repeat(200)),
          );
        }
      }
      const budget = 1500;
      const chunks = chunkSentences(sentences, budget);
      assert.isAbove(chunks.length, 1);
      // completeness + order
      const flattened = chunks.flat();
      assert.lengthOf(flattened, sentences.length);
      flattened.forEach((entry, index) =>
        assert.strictEqual(entry.text, sentences[index].text),
      );
      // every chunk respects the budget (chars/3.5 estimate + 20 overhead)
      for (const chunk of chunks) {
        const estimate = Math.ceil(
          chunk.reduce((total, s) => total + s.text.length + 20, 0) / 3.5,
        );
        assert.isAtMost(estimate, budget);
      }
    });

    it("prefers section boundaries when cutting", async function () {
      const sentences = [
        ...Array.from({ length: 8 }, (_, index) =>
          sentence(0, "introduction", `intro ${index} ` + "x".repeat(150)),
        ),
        ...Array.from({ length: 8 }, (_, index) =>
          sentence(1, "methods", `methods ${index} ` + "x".repeat(150)),
        ),
      ];
      // Budget fits ~12 sentences; the boundary after intro (index 8) is past
      // 40% of the chunk, so the cut should land exactly there.
      const chunks = chunkSentences(sentences, 600);
      assert.strictEqual(
        chunks[0][chunks[0].length - 1].section,
        "introduction",
      );
      assert.strictEqual(chunks[1]?.[0]?.section, "methods");
    });

    it("splits into the requested number of contiguous bands, order preserved", function () {
      const sentences = Array.from({ length: 40 }, (_, index) =>
        sentence(Math.floor(index / 2), "body", `s${index} ` + "x".repeat(60)),
      );
      const bands = splitIntoBands(sentences, 8, 100_000);
      assert.lengthOf(bands, 8);
      const flattened = bands.flat();
      assert.lengthOf(flattened, 40);
      flattened.forEach((entry, index) =>
        assert.strictEqual(entry.text, sentences[index].text),
      );
      // each band is a contiguous run
      assert.strictEqual(bands[0][0].text, "s0 " + "x".repeat(60));
      assert.strictEqual(
        bands[7][bands[7].length - 1].text,
        sentences[39].text,
      );
    });
  });
});
