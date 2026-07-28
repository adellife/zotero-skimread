import { assert } from "chai";
import {
  DEFAULT_LABELS,
  buildDocumentSelectionPrompt,
  buildDocumentSelectionSchema,
  buildReducePrompt,
  validateDocumentSelection,
  validateReduce,
} from "../src/prompts/skim";
import {
  chunkSentences,
  sectionAtPageStart,
  splitIntoBands,
} from "../src/modules/skim";

describe("document selection", function () {
  it("keeps stable IDs and page context in the full-document prompt", function () {
    const prompt = buildDocumentSelectionPrompt([
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
    ]);
    assert.include(prompt, "0 | page 1");
    assert.include(prompt, "1 | page 3");
    assert.include(prompt, "section introduction");
    assert.include(prompt, "section results");
    assert.include(prompt, "actual narrative");
    assert.notInclude(prompt, "Cover every major section");
    assert.notInclude(prompt, "roughly 2 per page");
    assert.include(
      buildDocumentSelectionPrompt(
        [
          {
            id: 0,
            pageIndex: 0,
            section: "body",
            text: "A sentence in a long-document passage.",
          },
        ],
        DEFAULT_LABELS,
        "passage",
      ),
      "this passage",
    );
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

  it("allows an explicitly empty passage selection", function () {
    assert.deepEqual(
      validateDocumentSelection({ selected: [] }, DEFAULT_LABELS, 2, true),
      [],
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

  it("does not treat a footer mention of supplementary material as an appendix heading", function () {
    assert.isNull(
      sectionAtPageStart({
        pageIndex: 0,
        text: "Article information. A version in French is provided as Online Supplementary material. The abstract follows.",
        charMap: [],
        chars: [],
      }),
    );
  });

  it("enforces the model and validator selection limits", function () {
    const schema = buildDocumentSelectionSchema(DEFAULT_LABELS, 2);
    assert.strictEqual(schema.properties.selected.maxItems, 2);
    assert.deepEqual(
      validateDocumentSelection(
        {
          selected: [
            { id: 0, label: "goal", importance: 0.6 },
            { id: 1, label: "method", importance: 0.95 },
            { id: 2, label: "result", importance: 0.8 },
          ],
        },
        DEFAULT_LABELS,
        3,
        false,
        2,
      ),
      [
        { id: 1, label: "method", importance: 0.95 },
        { id: 2, label: "result", importance: 0.8 },
      ],
    );
  });

  describe("core narrative reduction", function () {
    it("requires roles that reconstruct an argument", function () {
      assert.isNull(
        validateReduce(
          {
            core: [
              { id: 0, role: "problem", importance: 0.9 },
              { id: 1, role: "central_claim", importance: 0.9 },
              { id: 2, role: "significance", importance: 0.8 },
            ],
          },
          5,
          4,
        ),
      );
      assert.deepEqual(
        validateReduce(
          {
            core: [
              { id: 0, role: "problem", importance: 0.9 },
              { id: 1, role: "development", importance: 0.7 },
              { id: 2, role: "central_claim", importance: 0.95 },
              { id: 3, role: "significance", importance: 0.8 },
            ],
          },
          5,
          4,
        ),
        [
          { id: 0, role: "problem", importance: 0.9 },
          { id: 1, role: "development", importance: 0.7 },
          { id: 2, role: "central_claim", importance: 0.95 },
          { id: 3, role: "significance", importance: 0.8 },
        ],
      );
    });

    it("caps Core while preserving required narrative roles", function () {
      const result = validateReduce(
        {
          core: [
            { id: 0, role: "problem", importance: 0.7 },
            { id: 1, role: "development", importance: 0.8 },
            { id: 2, role: "central_claim", importance: 0.99 },
            { id: 3, role: "evidence", importance: 0.4 },
            { id: 4, role: "significance", importance: 0.6 },
            { id: 5, role: "evidence", importance: 0.95 },
          ],
        },
        6,
        4,
      );
      assert.lengthOf(result || [], 4);
      const roles = (result || []).map((entry) => entry.role);
      assert.includeMembers(roles, [
        "problem",
        "central_claim",
        "significance",
      ]);
      assert.isTrue(
        roles.includes("development") || roles.includes("evidence"),
      );
    });

    it("tells the model to use section context and exact limits", function () {
      const prompt = buildReducePrompt(
        [
          {
            id: 0,
            pageIndex: 1,
            section: "discussion",
            label: "argument",
            text: "The interpretation follows from the preceding case.",
          },
        ],
        4,
      );
      assert.include(prompt, "Keep at most 4");
      assert.include(prompt, "section discussion");
      assert.include(prompt, '"role"');
    });
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
