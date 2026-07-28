import { assert } from "chai";
import { annotationLabelFields } from "../src/modules/annotations";
import { cleanAnnotationText } from "../src/utils/text";

describe("annotation text", function () {
  it("removes PDF soft hyphens and line-end hyphenation", function () {
    assert.strictEqual(
      cleanAnnotationText(
        "Program\u00admability and recen- tralizing platformi- zed systems.",
      ),
      "Programmability and recentralizing platformized systems.",
    );
  });

  it("restores missing spacing between adjacent sentences", function () {
    assert.strictEqual(
      cleanAnnotationText(
        "It changed in many other ways.Adecade later, the argument continued.",
      ),
      "It changed in many other ways. A decade later, the argument continued.",
    );
  });

  it("normalizes extraction whitespace without changing punctuation", function () {
    assert.strictEqual(
      cleanAnnotationText("  A result  , followed by   its implication. "),
      "A result, followed by its implication.",
    );
  });

  it("can save labels as comments for Zotero note extraction", function () {
    assert.deepEqual(annotationLabelFields("Core Argument", "comment"), {
      comment: "Core Argument",
      tags: [],
    });
    assert.deepEqual(annotationLabelFields("Core Argument", "comment", true), {
      comment: "SkimRead: Core Argument",
      tags: [],
    });
  });

  it("can save labels as tags or omit them", function () {
    assert.deepEqual(annotationLabelFields("Method", "tag"), {
      comment: "",
      tags: [{ name: "Method" }],
    });
    assert.deepEqual(annotationLabelFields("Method", "none"), {
      comment: "",
      tags: [],
    });
  });
});
