import { assert } from "chai";
import {
  abbreviateFlagLabel,
  buildStructuredPage,
  marginFlagLayout,
  type PageChar,
} from "../src/reader/adapter";

function lineChars(
  text: string,
  fontSize: number,
  baseline: number,
  x1: number,
): PageChar[] {
  const width = Math.max(3, fontSize * 0.48);
  return [...text].map((character, index) => ({
    c: character,
    rect: [
      x1 + index * width,
      baseline,
      x1 + (index + 1) * width,
      baseline + fontSize,
    ],
    baseline,
    fontSize,
  }));
}

describe("reader structure", function () {
  it("excludes metadata, title, creator, headings, and keywords", function () {
    const chars = [
      ...lineChars(
        "For critical researchers, this opening paragraph contains genuine prose.",
        10,
        360,
        63,
      ),
      ...lineChars("DOI: 10.1177/example", 8, 660, 450),
      ...lineChars("1 Utrecht University, The Netherlands", 8, 145, 323),
      ...lineChars("The Platformization of Everything:", 18, 685, 63),
      ...lineChars("From the End of the Like Button to AI", 18, 665, 63),
      ...lineChars("Infrastructure in Space", 18, 645, 63),
      ...lineChars("Anne Helmond", 12, 595, 63),
      ...lineChars("Abstract", 10, 548, 63),
      ...lineChars(
        "A decade after the term emerged, this article traces the shift to AI platforms.",
        10,
        536,
        63,
      ),
      ...lineChars("Keywords", 10, 423, 63),
      ...lineChars("platformization, platforms, social media, AI", 10, 411, 63),
    ];
    const page = buildStructuredPage(0, chars, 612, {
      title:
        "The Platformization of Everything: From the End of the Like Button to AI Infrastructure in Space",
      creators: ["Anne Helmond"],
    });
    assert.include(page.text, "opening paragraph contains genuine prose");
    assert.include(page.text, "A decade after the term emerged");
    assert.notInclude(page.text, "Platformization of Everything");
    assert.notInclude(page.text, "Anne Helmond");
    assert.notInclude(page.text, "Abstract");
    assert.notInclude(page.text, "Utrecht University");
    assert.notInclude(page.text, "platformization, platforms");
  });

  it("places spanning abstract prose before two-column body prose", function () {
    const chars = [
      ...lineChars("Left column first sentence continues here.", 10, 360, 63),
      ...lineChars("Left column second sentence continues here.", 10, 340, 63),
      ...lineChars("Left column third sentence ends here.", 10, 320, 63),
      ...lineChars("Right column first sentence continues here.", 10, 360, 323),
      ...lineChars(
        "Right column second sentence continues here.",
        10,
        340,
        323,
      ),
      ...lineChars("Right column third sentence ends here.", 10, 320, 323),
      ...lineChars(
        "The abstract spans the page and states the central contribution clearly.",
        10,
        536,
        63,
      ),
    ];
    const page = buildStructuredPage(0, chars, 612);
    assert.isBelow(
      page.text.indexOf("The abstract spans"),
      page.text.indexOf("Left column"),
    );
    assert.isBelow(
      page.text.indexOf("Left column"),
      page.text.indexOf("Right column"),
    );
  });

  it("splits repeated two-column gutters just under twelve points", function () {
    const leftX = 63;
    const fontSize = 10;
    const leftLines = [
      "Left alpha column text continues here.",
      "Left bravo column text continues here.",
      "Left gamma column text concludes here.",
    ];
    const rightLines = [
      "Right alpha column text continues here.",
      "Right bravo column text continues here.",
      "Right gamma column text concludes here.",
    ];
    const characterWidth = fontSize * 0.48;
    const rightX = leftX + leftLines[0].length * characterWidth + 11.9;
    const chars = leftLines.flatMap((left, index) => {
      const baseline = 560 - index * 20;
      return [
        ...lineChars(left, fontSize, baseline, leftX),
        ...lineChars(rightLines[index], fontSize, baseline, rightX),
      ];
    });

    const page = buildStructuredPage(1, chars, 612);

    assert.include(page.text, "Left gamma");
    assert.include(page.text, "Right alpha");
    assert.isBelow(
      page.text.indexOf("Left gamma"),
      page.text.indexOf("Right alpha"),
    );
  });

  it("keeps offset two-column text in column-major reading order", function () {
    const chars = [
      // Both columns sit left of the physical midpoint because this synthetic
      // page has a large right margin. Midpoint-based assignment interleaves
      // them as left-1, right-1, left-2, right-2.
      ...lineChars("Left passage one continues here.", 10, 560, 70),
      ...lineChars("Right passage one continues here.", 10, 560, 360),
      ...lineChars("Left passage two continues here.", 10, 540, 70),
      ...lineChars("Right passage two continues here.", 10, 540, 360),
      ...lineChars("Left passage three ends here.", 10, 520, 70),
      ...lineChars("Right passage three ends here.", 10, 520, 360),
    ];
    const page = buildStructuredPage(1, chars, 1000);
    assert.isBelow(
      page.text.indexOf("Left passage three"),
      page.text.indexOf("Right passage one"),
    );
  });

  it("does not mistake consecutive indented blocks for columns", function () {
    const chars = [
      ...lineChars("Opening paragraph one continues here.", 10, 700, 70),
      ...lineChars("Opening paragraph two continues here.", 10, 680, 70),
      ...lineChars("Opening paragraph three ends here.", 10, 660, 70),
      ...lineChars("Indented quotation one continues here.", 10, 420, 330),
      ...lineChars("Indented quotation two continues here.", 10, 400, 330),
      ...lineChars("Indented quotation three ends here.", 10, 380, 330),
    ];
    const page = buildStructuredPage(1, chars, 1000);
    assert.isBelow(
      page.text.indexOf("Opening paragraph three"),
      page.text.indexOf("Indented quotation one"),
    );
  });

  it("separates first-page columns before filtering publisher and keyword blocks", function () {
    const chars = [
      ...lineChars("Contents lists available at ScienceDirect", 9, 700, 210),
      ...lineChars(
        "Faculté des sciences, Université Laval, Québec, Canada",
        9,
        620,
        39,
      ),
      ...lineChars("A R T I C L E I N F O", 9, 540, 39),
      ...lineChars("A B S T R A C T", 9, 540, 198),
      // PDF object order can place both columns on the same baseline.
      ...lineChars("Keywords", 9, 520, 39),
      ...lineChars("This article develops a discursive account", 9, 520, 198),
      ...lineChars("Generative AI", 9, 500, 39),
      ...lineChars(
        "of how machines influence management practice.",
        9,
        500,
        198,
      ),
      ...lineChars("Technological solutionism", 9, 480, 39),
      ...lineChars(
        "The account distinguishes two interacting discourses.",
        9,
        480,
        198,
      ),
      ...lineChars(
        "The introduction begins with a motivating encounter.",
        9,
        300,
        50,
      ),
    ];
    const page = buildStructuredPage(0, chars, 544);
    assert.include(page.text, "This article develops a discursive account");
    assert.include(page.text, "two interacting discourses");
    assert.include(page.text, "introduction begins");
    assert.notInclude(page.text, "ScienceDirect");
    assert.notInclude(page.text, "Université Laval");
    assert.notInclude(page.text, "Generative artificial intelligence");
    assert.notInclude(page.text, "Technological solutionism");
  });

  describe("margin flag layout", function () {
    it("uses compact badges for long labels", function () {
      assert.strictEqual(abbreviateFlagLabel("Operational Mechanism"), "OM");
      assert.strictEqual(abbreviateFlagLabel("Conceptual Definition"), "CD");
      assert.strictEqual(abbreviateFlagLabel("Result"), "RE");
    });

    it("keeps a short label immediately before the text boundary", function () {
      assert.deepEqual(marginFlagLayout(64, 40), {
        left: 20,
        maxWidth: 58,
      });
    });

    it("clips a long label instead of allowing it into the text", function () {
      assert.deepEqual(marginFlagLayout(40, 90), {
        left: 2,
        maxWidth: 34,
      });
    });
  });
});
