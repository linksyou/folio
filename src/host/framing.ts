import { AppError } from "../shared/errors.js";

const MAX_MESSAGE_BYTES = 1_048_576;

/** Chrome native messages use a 32-bit native-endian length followed by UTF-8 JSON. */
export function encodeMessage(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > MAX_MESSAGE_BYTES) throw new AppError("MESSAGE_TOO_LARGE", "本地消息过大。");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length);
  return Buffer.concat([header, json]);
}

export class MessageDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_MESSAGE_BYTES) {
        throw new AppError("INVALID_REQUEST", "本地消息长度不合法。");
      }
      if (this.buffer.length < length + 4) break;
      try { messages.push(JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8"))); }
      catch { throw new AppError("INVALID_REQUEST", "本地消息不是有效 JSON。"); }
      this.buffer = this.buffer.subarray(length + 4);
    }
    return messages;
  }

  get hasPartialMessage(): boolean { return this.buffer.length !== 0; }
}
