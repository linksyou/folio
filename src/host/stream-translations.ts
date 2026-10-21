import { AppError } from "../shared/errors.js";
import type { TextBlock, Translation } from "../shared/protocol.js";

type State = "start" | "itemOrEnd" | "item" | "key" | "colon" | "value" |
  "objectEnd" | "arrayEnd" | "end";

/** A bounded, incremental parser for [{"id":"…","text":"…"}].
 * Previews are never completion evidence: callers must validate the final JSON
 * and the provider terminal event separately. No repair, eval, or JSON regexes.
 */
export class TranslationPreviewParser {
  private state: State = "start";
  private readonly expected: Set<string>;
  private readonly seen = new Set<string>();
  private readonly latest = new Map<string, string>();
  private readonly emitted = new Map<string, string>();
  private current?: { id?: string; text?: string };
  private keys = new Set<string>();
  private key = "";
  private stringKind?: "key" | "value";
  private value = "";
  private escaped = false;
  private unicode?: string;
  private characters = 0;
  private fenced = false;

  constructor(blocks: TextBlock[]) {
    this.expected = new Set(blocks.map((block) => block.id));
  }

  append(chunk: string): Translation[] | undefined {
    this.characters += chunk.length;
    if (this.characters > 1_048_576) this.invalid();
    // Legacy fenced JSON remains acceptable to final parsing, but does not get
    // speculative previews. Prompts explicitly request an unwrapped JSON array.
    if (this.fenced) return;
    for (const character of chunk) {
      if (this.stringKind) {
        this.stringCharacter(character);
        continue;
      }
      if (/^[\t\r\n ]$/.test(character)) continue;
      switch (this.state) {
        case "start":
          if (character === "`") { this.fenced = true; return; }
          if (character !== "[") this.invalid();
          this.state = "itemOrEnd";
          break;
        case "itemOrEnd":
          if (character === "]") { this.state = "end"; break; }
          this.beginItem(character);
          break;
        case "item": this.beginItem(character); break;
        case "key":
          if (character !== '"') this.invalid();
          this.beginString("key");
          break;
        case "colon":
          if (character !== ":") this.invalid();
          this.state = "value";
          break;
        case "value":
          if (character !== '"') this.invalid();
          this.beginString("value");
          break;
        case "objectEnd":
          if (character === ",") { this.state = "key"; break; }
          if (character !== "}" || !this.current?.id || !this.current.text?.trim()) this.invalid();
          this.latest.set(this.current!.id!, this.current!.text!);
          this.current = undefined;
          this.state = "arrayEnd";
          break;
        case "arrayEnd":
          if (character === ",") this.state = "item";
          else if (character === "]") this.state = "end";
          else this.invalid();
          break;
        case "end": this.invalid();
      }
    }
    if (this.current?.id) {
      const text = this.stringKind === "value" && this.key === "text" ? this.value : this.current.text;
      if (text) {
        // A split \uD83D\uDE00 pair must never expose its half-decoded prefix.
        const safe = text.replace(/[\uD800-\uDBFF]$/, "");
        if (safe.trim()) this.latest.set(this.current.id, safe);
      }
    }
    if (![...this.latest].some(([id, text]) => this.emitted.get(id) !== text)) return;
    this.emitted.clear();
    const snapshot: Translation[] = [];
    for (const id of this.expected) {
      const text = this.latest.get(id);
      if (text !== undefined) { this.emitted.set(id, text); snapshot.push({ id, text }); }
    }
    return snapshot;
  }

  private beginItem(character: string): void {
    if (character !== "{" || this.seen.size >= this.expected.size) this.invalid();
    this.current = {};
    this.keys = new Set();
    this.state = "key";
  }

  private beginString(kind: "key" | "value"): void {
    this.stringKind = kind;
    this.value = "";
    this.escaped = false;
    this.unicode = undefined;
  }

  private stringCharacter(character: string): void {
    if (this.unicode !== undefined) {
      if (!/^[\da-f]$/i.test(character)) this.invalid();
      this.unicode += character;
      if (this.unicode.length === 4) {
        this.value += String.fromCharCode(Number.parseInt(this.unicode, 16));
        this.unicode = undefined;
      }
    } else if (this.escaped) {
      this.escaped = false;
      if (character === "u") this.unicode = "";
      else {
        const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (!Object.hasOwn(escapes, character)) this.invalid();
        this.value += escapes[character];
      }
    } else if (character === "\\") this.escaped = true;
    else if (character === '"') {
      if (this.stringKind === "key") {
        if (!["id", "text"].includes(this.value) || this.keys.has(this.value)) this.invalid();
        this.key = this.value;
        this.keys.add(this.key);
        this.state = "colon";
      } else {
        if (this.key === "id") {
          if (!this.expected.has(this.value) || this.seen.has(this.value)) this.invalid();
          this.seen.add(this.value);
          this.current!.id = this.value;
        } else this.current!.text = this.value;
        this.state = "objectEnd";
      }
      this.stringKind = undefined;
    } else {
      if (character.charCodeAt(0) < 0x20) this.invalid();
      this.value += character;
    }
    const limit = this.stringKind === "key" ? 4 : this.key === "id" ? 160 : 49_999;
    if (this.value.length > limit) this.invalid();
  }

  private invalid(): never {
    throw new AppError("INVALID_RESPONSE", "模型返回的段落格式或编号无效，请重试这些段落。");
  }
}

/** Merge cumulative text by id; never drop another paragraph's only update. */
export function createProgressCoalescer(
  emit: (translations: Translation[]) => void,
  intervalMs = 40,
): { push(translations: Translation[]): void; flush(): void; close(): void } {
  const latest = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSentAt = -Infinity;
  let dirty = false;
  let closed = false;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (closed || !dirty) return;
    dirty = false;
    lastSentAt = performance.now();
    emit([...latest].map(([id, text]) => ({ id, text })));
  };
  return {
    push(translations) {
      if (closed) return;
      for (const { id, text } of translations) {
        if (latest.get(id) !== text) { latest.set(id, text); dirty = true; }
      }
      if (!dirty) return;
      const wait = intervalMs - (performance.now() - lastSentAt);
      if (wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    },
    flush,
    close() {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      latest.clear();
      dirty = false;
    },
  };
}
