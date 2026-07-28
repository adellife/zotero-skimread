/**
 * Make extracted scholarly text readable without changing its source geometry.
 * PDF text layers commonly expose discretionary hyphens, line-end hyphenation,
 * and missing whitespace between adjacent sentences.
 */
export function cleanAnnotationText(value: string): string {
  return String(value || "")
    .replace(/\u00ad/g, "")
    .replace(/([A-Za-zÀ-ÖØ-öø-ÿ]{2,})-\s+([a-zà-öø-ÿ]{2,})/g, "$1$2")
    .replace(/([a-zà-öø-ÿ0-9])([.!?])(?=[A-ZÀ-ÖØ-Þ])/g, "$1$2 ")
    .replace(
      /([.!?]\s+)A(?=(?:decade|century|year|study|paper|new|further|similar|key|major|central|second|first|third|few|number|series|case|closer|later|more|different|single|brief|large|small|growing|recent)\b)/gi,
      "$1A ",
    )
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
