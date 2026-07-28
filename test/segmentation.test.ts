import { assert } from "chai";
import type { PageChar, PageText } from "../src/reader/adapter";
import { segmentSentences } from "../src/modules/skim";

function pageFromLines(
  lines: Array<{ text: string; fontSize: number }>,
): PageText {
  const chars: PageChar[] = [];
  const charMap: number[] = [];
  let text = "";
  for (const [lineIndex, line] of lines.entries()) {
    if (lineIndex) {
      text += " ";
      charMap.push(-1);
    }
    for (const char of line.text) {
      const index = chars.length;
      chars.push({
        c: char,
        rect: [index, 700 - lineIndex * 24, index + 1, 710 - lineIndex * 24],
        baseline: 700 - lineIndex * 24,
        fontSize: line.fontSize,
      });
      text += char;
      charMap.push(index);
    }
  }
  return { pageIndex: 0, text, charMap, chars };
}

describe("sentence segmentation", function () {
  it("removes a numbered subtitle fused to the first prose sentence", function () {
    const sentences = segmentSentences(
      pageFromLines([
        { text: "2.3 Analytical Framework", fontSize: 14 },
        {
          text: "The framework explains how participants interpret evidence in context.",
          fontSize: 10,
        },
      ]),
    );
    assert.lengthOf(sentences, 1);
    assert.strictEqual(
      sentences[0].text,
      "The framework explains how participants interpret evidence in context.",
    );
  });

  it("drops a standalone subtitle instead of offering it to the model", function () {
    const sentences = segmentSentences(
      pageFromLines([{ text: "FUTURE DIRECTIONS", fontSize: 14 }]),
    );
    assert.deepEqual(sentences, []);
  });

  it("keeps normal body prose that is not structurally a subtitle", function () {
    const text =
      "The authors compare the two approaches using a held-out validation set.";
    const sentences = segmentSentences(pageFromLines([{ text, fontSize: 10 }]));
    assert.deepEqual(
      sentences.map((sentence) => sentence.text),
      [text],
    );
  });
});
