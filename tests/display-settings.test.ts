import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { DISPLAY_STORAGE_KEY, readDisplayMode, resolveDisplayMode, saveDisplayMode } from "../src/extension/display-settings.js";

function storage(t: TestContext, initial: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const values: Record<string, unknown> = { [DISPLAY_STORAGE_KEY]: initial };
  let writes = 0;
  const local = {
    get: async (_key: string) => ({ ...values }),
    set: async (update: Record<string, unknown>) => { writes += 1; Object.assign(values, update); },
  };
  Object.defineProperty(globalThis, "chrome", { value: { storage: { local } }, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "chrome", previous);
    else Reflect.deleteProperty(globalThis, "chrome");
  });
  return { local, values, writes: () => writes };
}

test("display resolution prefers valid browser storage and falls back to a validated legacy value", async (t) => {
  const { values, local } = storage(t, "bilingual");
  assert.equal(await resolveDisplayMode("translation-only"), "bilingual");
  values[DISPLAY_STORAGE_KEY] = "invalid";
  assert.equal(await readDisplayMode(), undefined);
  assert.equal(await resolveDisplayMode("translation-only"), "translation-only");
  assert.equal(await resolveDisplayMode("invalid"), "bilingual");
  local.get = async () => { throw new Error("unavailable"); };
  assert.equal(await resolveDisplayMode("translation-only"), "translation-only");
});

test("legacy display migration only writes missing preferences", async (t) => {
  const { values, writes } = storage(t, "bilingual");
  assert.equal(await saveDisplayMode("translation-only", true), "bilingual");
  assert.equal(writes(), 0);
  delete values[DISPLAY_STORAGE_KEY];
  assert.equal(await saveDisplayMode("translation-only", true), "translation-only");
  assert.equal(writes(), 1);
  await saveDisplayMode("bilingual");
  assert.equal(values[DISPLAY_STORAGE_KEY], "bilingual");
});

test("the extension-wide display lock prevents migration from overwriting a concurrent user selection", async (t) => {
  const { local, values, writes } = storage(t, undefined);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let tail = Promise.resolve<unknown>(undefined);
  Object.defineProperty(globalThis, "navigator", { value: { locks: {
    request: (_name: string, operation: () => Promise<unknown>) => {
      const current = tail.then(operation);
      tail = current.catch(() => undefined);
      return current;
    },
  } }, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  let commit!: () => void;
  const pending = new Promise<void>((resolve) => { commit = resolve; });
  const set = local.set;
  local.set = async (update) => { await pending; await set(update); };
  const user = saveDisplayMode("bilingual");
  const migration = saveDisplayMode("translation-only", true);
  commit();
  assert.deepEqual(await Promise.all([user, migration]), ["bilingual", "bilingual"]);
  assert.equal(values[DISPLAY_STORAGE_KEY], "bilingual");
  assert.equal(writes(), 1);
});
