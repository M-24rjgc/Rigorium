import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

let _instance: Tiktoken | null = null;

export function getTokenizer(): Tiktoken {
  if (!_instance) {
    _instance = new Tiktoken(o200k_base);
  }
  return _instance;
}

/**
 * js-tiktoken's merge loop degrades to O(n²) on very long unbroken character
 * runs (a 100KB+ minified word matches `\p{L}+` as a single piece and the
 * merge becomes quadratic). That turns a routine token-count into seconds —
 * budget checks and router usage estimation on such text stall the pipeline.
 * Pieces are therefore bounded: whitespace-delimited words longer than this
 * are sliced before encoding.
 */
const MAX_TOKENIZER_PIECE_CHARS = 200;

/**
 * Count the number of tokens in a text string using o200k_base encoding.
 * Returns 0 for empty strings without invoking the tokenizer.
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  if (text.length <= MAX_TOKENIZER_PIECE_CHARS) {
    return getTokenizer().encode(text).length;
  }
  let tokens = 0;
  let pieces = 0;
  for (const piece of splitBoundedPieces(text)) {
    tokens += getTokenizer().encode(piece).length;
    pieces += 1;
  }
  // Small conservative margin for tokens lost across chunk boundaries —
  // budget checks must err toward over-counting, never under-counting.
  return tokens + pieces;
}

function splitBoundedPieces(text: string): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of text.split(/(\s+)/u)) {
    if (word.length <= MAX_TOKENIZER_PIECE_CHARS) {
      current += word;
      if (current.length >= MAX_TOKENIZER_PIECE_CHARS) {
        pieces.push(current);
        current = "";
      }
      continue;
    }
    // Long unbroken run — slice it; separators are dropped per slice (the
    // margin above covers the boundary cost).
    if (current) {
      pieces.push(current);
      current = "";
    }
    for (let start = 0; start < word.length; start += MAX_TOKENIZER_PIECE_CHARS) {
      pieces.push(word.slice(start, start + MAX_TOKENIZER_PIECE_CHARS));
    }
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}
