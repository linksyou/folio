import type { HostStatus, NativeMessage, NativeRequest } from "../../src/shared/protocol.js";

/** Installed-extension fixture: replace only the native port, never contact a real Host. */
export function installNativeFixture() {
  const fixture = {
    mode: "partial", delay: 30, preflight: "", calls: [] as string[], jobs: [] as string[],
    disconnect: () => {},
  };
  (globalThis as unknown as { nativeFixture: typeof fixture }).nativeFixture = fixture;
  chrome.runtime.connectNative = () => {
    const listeners: Array<(message: NativeMessage) => void> = [];
    const disconnects: Array<() => void> = [];
    const emit = (message: NativeMessage) => listeners.forEach(listener => listener(message));
    fixture.disconnect = () => disconnects.forEach(listener => listener());
    return {
      onMessage: { addListener: (listener: (message: NativeMessage) => void) => listeners.push(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnects.push(listener) },
      disconnect() {},
      postMessage({ id, command }: NativeRequest) {
        if (command.type === "status") {
          const status: HostStatus = {
            protocolVersion: 1, settingsRevision: "fixture",
            settings: { provider: "custom", customBaseUrl: "http://127.0.0.1/v1", customModel: "fixture", chatgptModel: "", hasApiKey: false },
            auth: { state: "signed_out", profiles: [], planEnabled: false },
          };
          queueMicrotask(() => emit(fixture.preflight
            ? { id, ok: false, error: { code: fixture.preflight, message: "secret-fixture-canary" } }
            : { id, ok: true, result: status }));
          return;
        }
        if (command.type === "translate") {
          fixture.calls.push(...command.blocks.map(block => block.text));
          fixture.jobs.push(command.jobId);
          const mode = fixture.mode;
          const fails = mode === "all" || mode === "partial" && command.blocks.some(block => block.text.includes("Fourth"))
            || mode.startsWith("error:");
          setTimeout(() => {
            // Ignore cancellation deliberately: content must reject late replies.
            emit(fails ? { id, ok: false, error: {
              code: mode.startsWith("error:") ? mode.slice(6) : "NETWORK_ERROR", message: "secret-fixture-canary",
            } } : { id, ok: true, result: command.blocks.map(block => ({ id: block.id, text: "这是一段用于验证阅读体验的模拟译文。" + block.text })) });
          }, fixture.delay);
          return;
        }
        queueMicrotask(() => emit({ id, ok: true, result: command.type === "connection.prepare" ? { ready: true } : {} }));
      },
    } as unknown as chrome.runtime.Port;
  };
}

declare global {
  var nativeFixture: {
    mode: string; delay: number; preflight: string; calls: string[]; jobs: string[]; disconnect(): void;
  };
}
