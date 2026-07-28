# SkimRead sentence-selection prompts

This is the prompt contract used by SkimRead 0.2.3 (pipeline version 28). The model receives the
system prompt and one user prompt. The label list is generated from the
selected label mode, so the descriptions below are placeholders for the
current configured labels.

## 1. System prompt

```text
You select the most useful sentences from a scholarly document (paper, book chapter, or report) to support skimming.
Labels:
- <label key>: <label description>.
  NOT <label key>: <anti-description>.
  e.g. "<example sentence>"
- <another label key>: <description>.

- Do not select background filler, citation lists, boilerplate, figure captions, appendices, or references.
Rules: consider the supplied document or passage jointly. Judge importance by each sentence's role in the paper and its contribution to the paper's central claim, not by word frequency or isolated wording. The supplied section field is structural evidence: prioritize the abstract, introduction, methods, results, discussion, and conclusion; never select references. Prefer a diverse, non-redundant set that lets a reader recover the paper's argument, approach, findings, and novelty. Select only supplied sentence IDs; never rewrite text. Importance is 0-1. Return JSON only.
```

## 2. User prompt for a complete document

```text
Choose the sentences worth highlighting while skimming this entire document.
Select at most <3 × number of pages> sentences across these <page count> pages. Select fewer when the document warrants fewer.
Follow the document's actual narrative: choose the sentences that advance its argument, approach, findings, or implications. Do not select a sentence merely to fill a page, section, or position in the document.
Use the numeric id exactly as supplied. Do not return a sentence more than once.
Use each sentence's section to judge its role in the paper, not merely its wording.

Return ONLY this JSON, no prose or code fences:
{"selected":[{"id":<integer>,"label":"<one of: goal | method | result | novelty>","importance":<0..1>}]}

<id> | page <page number> | section <section name> | <sentence text>
<id> | page <page number> | section <section name> | <sentence text>
...
```

For a focused paper that fits the configured context, the list above is the
whole eligible paper. References, front matter, repeated headers/footers, and
subtitle-only lines have already been removed before this prompt is built.

## 3. User prompt for one long-document passage

When a document is too large for one request, the same selection contract is
sent once per context-sized passage. The numeric IDs restart at `0` for each
passage; they are local IDs, not Zotero item IDs. They are validated against
that passage before any highlight is created.

The passage prompt is:

```text
Choose the sentences worth highlighting while skimming this passage.
Select at most <3 × number of pages in this passage> sentences across these <page count in this passage> pages. Select fewer when the passage warrants fewer.
Follow the document's actual narrative: choose the sentences that advance its argument, approach, findings, or implications. Do not select a sentence merely to fill a page, section, or position in the document.
Use the numeric id exactly as supplied. Do not return a sentence more than once.
Use each sentence's section to judge its role in the paper, not merely its wording.

Return ONLY this JSON, no prose or code fences:
{"selected":[{"id":<integer>,"label":"<one of: goal | method | result | novelty>","importance":<0..1>}]}

<id> | page <page number> | section <section name> | <sentence text>
...
```

The selected passage candidates are then sent to a whole-document reduce pass.
That pass is responsible for removing redundant candidates and keeping the
sentences that form the paper's narrative.

## 4. Whole-document reduce prompt

```text
You are given the sentences a first pass selected as candidates from one scholarly document, in reading order.
CORE NARRATIVE means the smallest self-sufficient subset that lets a reader reconstruct the document's actual line of thought, not merely a list of important concepts.
Assign every core sentence exactly one narrative role:
- problem: the motivating problem, question, gap, or conceptual tension;
- development: the approach, method, historical movement, or logical step that advances the argument;
- central_claim: the main finding, contribution, thesis, or interpretation;
- evidence: a decisive result, case, quotation, or example needed to understand why the claim follows;
- significance: the implication, limitation, consequence, or conclusion.
Every core must contain a central_claim, a problem, a significance sentence, and at least one development or evidence sentence. Include both development and evidence when both are necessary to understand the document's movement.
In conceptual or historical work, an example can be essential evidence when it makes a transition or mechanism intelligible.
Prefer a sentence that carries the argument over one that merely restates it. When two candidates say substantially the same thing, keep only the clearer one.
Keep the narrative spread across the whole document; do not keep only the opening or only the conclusion.
Select only the supplied ids, never rewrite text. Return JSON only.

These <candidate count> candidates come from one document, in reading order.
Keep at most <target count> as the self-sufficient CORE NARRATIVE. Keep fewer if fewer tell the story.
Drop candidates that repeat a point already made by a stronger one.
Use the numeric id exactly as supplied; do not return an id twice.

Return ONLY this JSON, no prose or code fences:
{"core":[{"id":<integer>,"role":"<problem | development | central_claim | evidence | significance>","importance":<0..1>}]}

<id> | page <page number> | section <section name> | <label> | <sentence text>
...
```

The response is rejected and repaired once if these narrative roles are
missing. Both the provider schema and local validation enforce the maximum
selection count; the limit is not left to the model as an instruction alone.

## Why IDs can still matter

The IDs are valid and checked, but they are only positional numbers inside a
single request. If a model confuses two nearby rows, the validator cannot know
that it chose the wrong sentence—it only knows that the number is in range.
This is why the prompt includes page, section, and full sentence text beside
every ID. The stronger remaining failure mode is a forced passage quota: if a
passage is told to return a fixed number, a model may nominate a merely
plausible sentence. The intended behavior is “select only genuine narrative
sentences,” followed by global reduction.

The source of truth for these prompts is `src/prompts/skim.ts`; this document is
for inspection and discussion.
