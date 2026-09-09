/**
 * A from-scratch reader + runtime for the HuggingFace `tokenizers` library's
 * `tokenizer.json` format, implementing exactly the pipeline Model2Vec's
 * static models declare: `BertNormalizer` -> `BertPreTokenizer` -> WordPiece.
 * No other model type or normalizer/pre-tokenizer combination is supported;
 * `loadTokenizer` throws rather than silently mis-tokenizing a model that
 * turns out to use BPE/Unigram or a different normalizer.
 *
 * Verified against `minishlab/potion-code-16M-v2`'s tokenizer.json: its
 * `model.type` is `WordPiece`, `normalizer.type` is `BertNormalizer`
 * (`clean_text: true, handle_chinese_chars: true, strip_accents: null,
 * lowercase: true`), `pre_tokenizer.type` is `BertPreTokenizer`, and
 * `post_processor` is null (no `[CLS]`/`[SEP]` added). Model2Vec always
 * calls the underlying tokenizer with `add_special_tokens=False`, so we
 * never emit special tokens either — see model2vec's `StaticModel.tokenize`.
 *
 * WordPiece offsets are tracked back to the *original* (pre-normalization)
 * string so `truncateToTokens` can cut on a real token boundary without
 * re-deriving normalization math in reverse.
 */

export interface WordPieceTokenizer {
  readonly vocabSize: number;
  readonly unkTokenId: number;
  readonly padTokenId: number | null;
  /** Raw token ids for `text`, no special tokens, no truncation. */
  encode(text: string): number[];
  /** Token count using the same pipeline as `encode` (UNK tokens count as one token each). */
  countTokens(text: string): number;
  /** Truncate `text` to at most `maxTokens` tokens, cutting only at a token boundary. */
  truncateToTokens(text: string, maxTokens: number): string;
}

interface RawTokenizerJson {
  readonly model?: { readonly type?: string };
  readonly normalizer?: { readonly type?: string } | null;
  readonly pre_tokenizer?: { readonly type?: string } | null;
  readonly post_processor?: unknown;
}

function assertSupportedShape(raw: RawTokenizerJson): void {
  const modelType = raw.model?.type;
  if (modelType !== 'WordPiece') {
    throw new Error(
      `tokenizer.json: unsupported model type '${String(modelType)}' — only WordPiece is implemented`,
    );
  }
  const normalizerType = raw.normalizer?.type ?? null;
  if (normalizerType !== 'BertNormalizer') {
    throw new Error(
      `tokenizer.json: unsupported normalizer '${String(normalizerType)}' — only BertNormalizer is implemented`,
    );
  }
  const preTokenizerType = raw.pre_tokenizer?.type ?? null;
  if (preTokenizerType !== 'BertPreTokenizer') {
    throw new Error(
      `tokenizer.json: unsupported pre_tokenizer '${String(preTokenizerType)}' — only BertPreTokenizer is implemented`,
    );
  }
  if (raw.post_processor !== null && raw.post_processor !== undefined) {
    throw new Error(
      'tokenizer.json: a post_processor is configured, but this reader assumes none (Model2Vec encodes with add_special_tokens=False)',
    );
  }
}

interface BertNormalizerConfig {
  readonly cleanText: boolean;
  readonly handleChineseChars: boolean;
  readonly stripAccents: boolean;
  readonly lowercase: boolean;
}

function parseNormalizerConfig(raw: RawTokenizerJson): BertNormalizerConfig {
  const n = raw.normalizer as unknown as {
    clean_text?: boolean;
    handle_chinese_chars?: boolean;
    strip_accents?: boolean | null;
    lowercase?: boolean;
  } | null;
  const lowercase = n?.lowercase ?? true;
  // HuggingFace's BertNormalizer: when strip_accents is null, it defaults to
  // the value of lowercase.
  const stripAccents = n?.strip_accents ?? lowercase;
  return {
    cleanText: n?.clean_text ?? true,
    handleChineseChars: n?.handle_chinese_chars ?? true,
    stripAccents,
    lowercase,
  };
}

interface WordPieceModelConfig {
  readonly vocab: ReadonlyMap<string, number>;
  readonly unkToken: string;
  readonly continuingSubwordPrefix: string;
  readonly maxInputCharsPerWord: number;
}

function parseWordPieceConfig(raw: RawTokenizerJson): WordPieceModelConfig {
  const m = raw.model as unknown as {
    vocab?: Record<string, number>;
    unk_token?: string;
    continuing_subword_prefix?: string;
    max_input_chars_per_word?: number;
  };
  const vocabObj = m.vocab;
  if (!vocabObj || typeof vocabObj !== 'object') {
    throw new Error('tokenizer.json: model.vocab is missing');
  }
  return {
    vocab: new Map(Object.entries(vocabObj)),
    unkToken: m.unk_token ?? '[UNK]',
    continuingSubwordPrefix: m.continuing_subword_prefix ?? '##',
    maxInputCharsPerWord: m.max_input_chars_per_word ?? 100,
  };
}

/* -------------------------------------------------------------------- *
 * BertNormalizer, applied one char at a time so each output char keeps a
 * pointer back to the original-string index it came from. Combining marks
 * dropped by accent-stripping simply have no output char. Inserted spacer
 * characters (around CJK) inherit the triggering char's original index.
 * -------------------------------------------------------------------- */

interface NormalizedChar {
  readonly ch: string;
  /** Index into the original string this char is attributable to. */
  readonly orig: number;
}

const ACCENT_MARK = /\p{Mn}/u;
const CHINESE_CHAR = /\p{Script=Han}/u;
// Matches HuggingFace's is_whitespace: ' ', '\t', '\n', '\r', or category Zs.
const WHITESPACE = /[ \t\n\r]|\p{Zs}/u;
// Matches HuggingFace's is_control: category C*, excluding '\t', '\n', '\r'.
const CONTROL = /\p{C}/u;
// Matches HuggingFace's is_punctuation: ASCII punctuation ranges, or category P*.
function isPunctuation(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if (
    (cp >= 33 && cp <= 47) ||
    (cp >= 58 && cp <= 64) ||
    (cp >= 91 && cp <= 96) ||
    (cp >= 123 && cp <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(ch);
}

function normalizeWithMap(text: string, config: BertNormalizerConfig): NormalizedChar[] {
  let chars: NormalizedChar[] = [];
  // clean_text: drop control chars (keep \t\n\r, which get treated as
  // whitespace below), collapse any whitespace char to a plain space.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (config.cleanText && ch !== '\t' && ch !== '\n' && ch !== '\r' && CONTROL.test(ch)) {
      continue;
    }
    if (config.cleanText && WHITESPACE.test(ch)) {
      chars.push({ ch: ' ', orig: i });
      continue;
    }
    chars.push({ ch, orig: i });
  }

  // handle_chinese_chars: pad CJK ideographs with spaces on both sides so
  // the pre-tokenizer's whitespace split isolates them as single-char words.
  if (config.handleChineseChars) {
    const next: NormalizedChar[] = [];
    for (const c of chars) {
      if (CHINESE_CHAR.test(c.ch)) {
        next.push({ ch: ' ', orig: c.orig }, c, { ch: ' ', orig: c.orig });
      } else {
        next.push(c);
      }
    }
    chars = next;
  }

  // strip_accents: NFD-decompose each char individually and drop combining
  // marks. Per-char (not whole-string) NFD avoids reordering base/combining
  // pairs across original-index boundaries.
  if (config.stripAccents) {
    const next: NormalizedChar[] = [];
    for (const c of chars) {
      const decomposed = c.ch.normalize('NFD');
      for (const d of decomposed) {
        if (!ACCENT_MARK.test(d)) next.push({ ch: d, orig: c.orig });
      }
    }
    chars = next;
  }

  if (config.lowercase) {
    const next: NormalizedChar[] = [];
    for (const c of chars) {
      for (const lower of c.ch.toLowerCase()) {
        next.push({ ch: lower, orig: c.orig });
      }
    }
    chars = next;
  }

  return chars;
}

/* -------------------------------------------------------------------- *
 * BertPreTokenizer: split on whitespace (dropped), and split punctuation
 * characters out as their own single-char words.
 * -------------------------------------------------------------------- */

interface WordSpan {
  /** Normalized text of the word. */
  readonly text: string;
  /** Original-string [start, end) this word covers, end exclusive. */
  readonly origStart: number;
  readonly origEnd: number;
}

function preTokenize(chars: readonly NormalizedChar[]): WordSpan[] {
  const spans: WordSpan[] = [];
  let current: NormalizedChar[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    const text = current.map((c) => c.ch).join('');
    const origStart = current[0]!.orig;
    const origEnd = current[current.length - 1]!.orig + 1;
    spans.push({ text, origStart, origEnd });
    current = [];
  };

  for (const c of chars) {
    if (c.ch === ' ') {
      flush();
      continue;
    }
    if (isPunctuation(c.ch)) {
      flush();
      spans.push({ text: c.ch, origStart: c.orig, origEnd: c.orig + 1 });
      continue;
    }
    current.push(c);
  }
  flush();
  return spans;
}

/* -------------------------------------------------------------------- *
 * WordPiece: greedy longest-match-first from the start of each word.
 * -------------------------------------------------------------------- */

function wordPieceEncodeWord(word: string, config: WordPieceModelConfig, unkId: number): number[] {
  if (word.length > config.maxInputCharsPerWord) return [unkId];
  const ids: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let matchedId: number | null = null;
    while (start < end) {
      let candidate = word.slice(start, end);
      if (start > 0) candidate = config.continuingSubwordPrefix + candidate;
      const id = config.vocab.get(candidate);
      if (id !== undefined) {
        matchedId = id;
        break;
      }
      end--;
    }
    if (matchedId === null) return [unkId];
    ids.push(matchedId);
    start = end;
  }
  return ids;
}

class WordPieceTokenizerImpl implements WordPieceTokenizer {
  readonly vocabSize: number;
  readonly unkTokenId: number;
  readonly padTokenId: number | null;

  private readonly normalizerConfig: BertNormalizerConfig;
  private readonly wordPieceConfig: WordPieceModelConfig;

  // Node's unflagged TypeScript type-stripping (used to run tests directly)
  // rejects constructor parameter properties as non-erasable syntax, hence
  // the explicit field declarations and assignments here.
  constructor(normalizerConfig: BertNormalizerConfig, wordPieceConfig: WordPieceModelConfig) {
    this.normalizerConfig = normalizerConfig;
    this.wordPieceConfig = wordPieceConfig;
    this.vocabSize = wordPieceConfig.vocab.size;
    const unkId = wordPieceConfig.vocab.get(wordPieceConfig.unkToken);
    if (unkId === undefined) {
      throw new Error(
        `tokenizer.json: unk_token '${wordPieceConfig.unkToken}' not present in vocab`,
      );
    }
    this.unkTokenId = unkId;
    this.padTokenId = wordPieceConfig.vocab.get('[PAD]') ?? null;
  }

  private wordsOf(text: string): WordSpan[] {
    const normalized = normalizeWithMap(text, this.normalizerConfig);
    return preTokenize(normalized);
  }

  /** Tokenize with per-token original-string spans, for truncation. */
  private encodeWithSpans(text: string): Array<{ id: number; origStart: number; origEnd: number }> {
    const words = this.wordsOf(text);
    const out: Array<{ id: number; origStart: number; origEnd: number }> = [];
    for (const word of words) {
      const ids = wordPieceEncodeWord(word.text, this.wordPieceConfig, this.unkTokenId);
      // Sub-token character spans within a word aren't separately tracked;
      // every sub-token of one word shares the word's original span. This
      // only affects truncation granularity when a single word both spans
      // a truncation boundary and splits into multiple WordPiece ids, in
      // which case truncation backs off to the whole word rather than the
      // sub-token — still a true token boundary, just slightly coarser.
      for (const id of ids) {
        out.push({ id, origStart: word.origStart, origEnd: word.origEnd });
      }
    }
    return out;
  }

  encode(text: string): number[] {
    return this.encodeWithSpans(text).map((t) => t.id);
  }

  countTokens(text: string): number {
    return this.encode(text).length;
  }

  truncateToTokens(text: string, maxTokens: number): string {
    if (maxTokens <= 0) return '';
    const spans = this.encodeWithSpans(text);
    if (spans.length <= maxTokens) return text;
    const cutoff = spans[maxTokens - 1]!.origEnd;
    return text.slice(0, cutoff);
  }
}

/** Parse a `tokenizer.json` document (already JSON.parse'd) into a runtime tokenizer. */
export function loadTokenizer(json: unknown): WordPieceTokenizer {
  const raw = json as RawTokenizerJson;
  assertSupportedShape(raw);
  const normalizerConfig = parseNormalizerConfig(raw);
  const wordPieceConfig = parseWordPieceConfig(raw);
  return new WordPieceTokenizerImpl(normalizerConfig, wordPieceConfig);
}
