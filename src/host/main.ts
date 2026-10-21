import { homedir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ID } from "../shared/extension-identity.js";
import { publicError } from "../shared/errors.js";
import { ChatGPTAuth } from "./auth/index.js";
import { encodeMessage, MessageDecoder } from "./framing.js";
import { ModelProviders } from "./providers.js";
import { HostService } from "./service.js";
import { createHttpTransport } from "./http.js";
import { SettingsStore } from "./settings.js";
import { createProgressCoalescer } from "./stream-translations.js";
import { boundedString, record, validateCommand } from "../shared/validation.js";
import type { NativeProgress, Translation } from "../shared/protocol.js";

// Native Messaging supplies the calling extension origin. No general-purpose HTTP server.
if (process.argv[2] !== `chrome-extension://${EXTENSION_ID}/`) {
  process.stderr.write("This program must be launched by Folio.\n");
  process.exit(1);
}

const directory = process.env.FOLIO_DATA_DIR ??
  join(homedir(), ".local", "share", "folio", "data");
const http = createHttpTransport();
const auth = new ChatGPTAuth({ dataDir: directory, fetch: http.fetch });
const service = new HostService(
  new SettingsStore(directory), auth, new ModelProviders(auth, http.fetch, undefined, http.prepare),
);
const decoder = new MessageDecoder();
const pending = new Set<Promise<void>>();
const requestIds = new Set<string>();
const progressStreams = new Map<string, {
  jobId: string; batchId: string; stream: ReturnType<typeof createProgressCoalescer>;
}>();
let closing = false;

function finish(): void {
  if (closing && pending.size === 0) process.exitCode = 0;
}

async function dispatch(input: unknown): Promise<void> {
  if (!record(input) || !boundedString(input.id, 160) || !input.id || requestIds.has(input.id)) {
    throw new Error("Invalid native message");
  }
  const id = input.id;
  requestIds.add(id);
  try {
    validateCommand(input.command);
    const command = input.command;
    for (const entry of progressStreams.values()) {
      if ((command.type === "translate.cancel" && entry.jobId === command.jobId) ||
          (command.type === "translate.cancelBatch" && entry.jobId === command.jobId && entry.batchId === command.batchId) ||
          ["settings.save", "auth.login", "auth.logout", "auth.select"].includes(command.type)) entry.stream.close();
    }
    let onProgress: ((translations: Translation[]) => void) | undefined;
    if (command.type === "translate" && command.batchId) {
      const { jobId, batchId } = command;
      const stream = createProgressCoalescer((translations) => {
        // A deadline can abort between two deltas. Gate the trailing timer on
        // the service's combined signal, not only native cancellation messages.
        if (closing || !service.isTranslationActive(jobId, batchId)) { stream.close(); return; }
        process.stdout.write(encodeMessage({
          id, event: "translation.progress", translations,
        } satisfies NativeProgress));
      });
      progressStreams.set(id, { jobId, batchId, stream });
      onProgress = (translations) => stream.push(translations);
    }
    const result = await service.handle(command, onProgress);
    // The final reply contains the full batch. Do not emit a queued preview
    // after completion, cancellation, or failure.
    progressStreams.get(id)?.stream.close();
    if (!closing) process.stdout.write(encodeMessage({ id, ok: true, result }));
  } catch (error) {
    if (!closing) process.stdout.write(encodeMessage({ id, ok: false, error: publicError(error) }));
  } finally {
    progressStreams.get(id)?.stream.close();
    progressStreams.delete(id);
    requestIds.delete(id);
  }
}

function close(): void {
  if (closing) return;
  closing = true;
  for (const { stream } of progressStreams.values()) stream.close();
  service.close();
  process.stdin.pause();
  // Let an in-flight rotating-token refresh finish its atomic save before exit.
  void Promise.allSettled(pending).then(async () => {
    await http.close();
    finish();
  });
}

process.stdin.on("data", (chunk: Buffer) => {
  try {
    for (const input of decoder.push(chunk)) {
      if (pending.size >= 64) throw new Error("Too many requests");
      const task = dispatch(input).catch(close).finally(() => { pending.delete(task); finish(); });
      pending.add(task);
    }
  } catch { close(); }
});
process.stdin.on("end", close);
process.stdin.on("error", close);
process.stdout.on("error", close);
process.on("SIGTERM", close);
