// @flare-dispatch/review-agent — JSON extraction from model text.
//
// `mode: "json"` providers return free-form text that should contain one JSON
// object — but reasoning models (DeepSeek-R1 distills, etc.) wrap it in
// `<think>…</think>` prose, and many models fence it in ```json blocks.
// `extractJsonText` strips both and isolates the outermost JSON object/array so
// `JSON.parse` sees clean input. Pure + dependency-free.

/**
 * Strip `<think>…</think>` reasoning blocks (case-insensitive, across newlines).
 * An unterminated `<think>` (model truncated) drops everything from the tag on.
 */
export const stripThinkBlocks = (text: string): string =>
  text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // Unterminated opener — drop the trailing reasoning.
    .replace(/<think>[\s\S]*$/i, "");

/**
 * Strip a leading/wrapping markdown code fence (``` or ```json) so the JSON body
 * is exposed. Handles fences anywhere in the text by taking the fenced content
 * when a fence is present.
 */
export const stripCodeFences = (text: string): string => {
  const fenced = text.match(/```(?:json|jsonc)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1] !== undefined) return fenced[1];
  return text;
};

/**
 * Isolate the outermost JSON value (object `{…}` or array `[…]`) in `text` by
 * bracket-matching, ignoring brackets inside strings. Returns `undefined` when
 * no balanced top-level value is found.
 */
const isolateJsonValue = (text: string): string | undefined => {
  const start = (() => {
    const obj = text.indexOf("{");
    const arr = text.indexOf("[");
    if (obj === -1) return arr;
    if (arr === -1) return obj;
    return Math.min(obj, arr);
  })();
  if (start === -1) return undefined;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
};

/**
 * Best-effort isolation of the JSON payload from a model's text response:
 * strip `<think>` blocks, strip code fences, then bracket-match the outermost
 * JSON value. Returns the trimmed candidate text, or `undefined` when no
 * JSON-looking value remains.
 */
export const extractJsonText = (text: string): string | undefined => {
  const cleaned = stripCodeFences(stripThinkBlocks(text)).trim();
  if (cleaned === "") return undefined;
  const isolated = isolateJsonValue(cleaned);
  return isolated ?? undefined;
};
