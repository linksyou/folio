import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { EXTENSION_ID } from "../src/shared/extension-identity.js";
import { HOST_NAME } from "../src/shared/protocol.js";
import {
  installHost,
  nativeManifestDirectories,
  parseInstallArgs,
  resolveInstallLayout,
  uninstallHost,
} from "../scripts/install-host.js";

async function temporaryProject(): Promise<{ root: string; project: string; installRoot: string; manifestDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "owt-install-"));
  const project = path.join(root, "project");
  const installRoot = path.join(root, "install root's files");
  const manifestDir = path.join(root, "Chromium Native Hosts");
  await mkdir(path.join(project, "dist/host"), { recursive: true });
  await writeFile(
    path.join(project, "dist/host/main.cjs"),
    "process.stdout.write(JSON.stringify({data:process.env.OPEN_WEB_TRANSLATOR_DATA_DIR,args:process.argv.slice(2)}));\n",
  );
  return { root, project, installRoot, manifestDir };
}

function run(file: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("isolated install writes an owned manifest and a safely quoted executable wrapper", async (t) => {
  const fixture = await temporaryProject();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const dataDir = path.join(fixture.installRoot, "data dir's value");
  const result = await installHost({
    projectRoot: fixture.project,
    installRoot: fixture.installRoot,
    dataDir,
    manifestDir: fixture.manifestDir,
    nodePath: process.execPath,
  });

  assert.deepEqual(result.layout.manifests, [path.join(fixture.manifestDir, `${HOST_NAME}.json`)]);
  const manifest = JSON.parse(await readFile(result.layout.manifests[0]!, "utf8")) as Record<string, unknown>;
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.path, result.layout.wrapper);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal((await stat(result.layout.wrapper)).mode & 0o777, 0o755);

  const invoked = await run(result.layout.wrapper, ["chrome-extension://test/"]);
  assert.equal(invoked.code, 0, invoked.stderr);
  assert.deepEqual(JSON.parse(invoked.stdout), {
    data: dataDir,
    args: ["chrome-extension://test/"],
  });
});

test("uninstall removes only managed program files and keeps user data", async (t) => {
  const fixture = await temporaryProject();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const options = {
    projectRoot: fixture.project,
    installRoot: fixture.installRoot,
    manifestDir: fixture.manifestDir,
  };
  const installed = await installHost(options);
  const userFile = path.join(installed.layout.dataDir, "settings.json");
  await writeFile(userFile, "user data");

  const removed = await uninstallHost(options);
  await assert.rejects(stat(removed.layout.wrapper));
  await assert.rejects(stat(removed.layout.installedBundle));
  await assert.rejects(stat(removed.layout.manifests[0]!));
  assert.equal(await readFile(userFile, "utf8"), "user data");
});

test("uninstalling Chrome keeps the shared host while Edge is still registered", async (t) => {
  const fixture = await temporaryProject();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const homeDir = path.join(fixture.root, "home");
  const common = {
    projectRoot: fixture.project,
    installRoot: fixture.installRoot,
    platform: "darwin" as const,
    homeDir,
  };
  const installed = await installHost({ ...common, browser: "all" });
  const [chromeManifest, edgeManifest] = installed.layout.manifests;

  const chromeOnly = await uninstallHost({ ...common, browser: "chrome" });
  await assert.rejects(stat(chromeManifest!));
  assert.equal((await stat(edgeManifest!)).isFile(), true);
  assert.equal((await stat(chromeOnly.layout.wrapper)).isFile(), true);
  assert.match(chromeOnly.messages.join("\n"), /仍有浏览器使用/);

  await uninstallHost({ ...common, browser: "edge" });
  await assert.rejects(stat(chromeOnly.layout.wrapper));
  await assert.rejects(stat(chromeOnly.layout.installedBundle));
});

test("install refuses to replace a foreign native manifest", async (t) => {
  const fixture = await temporaryProject();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(fixture.manifestDir, { recursive: true });
  const manifest = path.join(fixture.manifestDir, `${HOST_NAME}.json`);
  const foreign = '{"name":"someone.else","path":"/tmp/foreign"}\n';
  await writeFile(manifest, foreign);

  await assert.rejects(
    installHost({
      projectRoot: fixture.project,
      installRoot: fixture.installRoot,
      manifestDir: fixture.manifestDir,
    }),
    /不属于本项目/,
  );
  assert.equal(await readFile(manifest, "utf8"), foreign);
});

test("argument and platform helpers expose deterministic browser paths", () => {
  assert.deepEqual(parseInstallArgs(["--browser", "edge", "--manifest-dir", "/tmp/native"]), {
    uninstall: false,
    browser: "edge",
    manifestDir: "/tmp/native",
  });
  assert.deepEqual(nativeManifestDirectories("darwin", "/Users/test", "all"), [
    "/Users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts",
    "/Users/test/Library/Application Support/Microsoft Edge/NativeMessagingHosts",
  ]);
  assert.deepEqual(nativeManifestDirectories("linux", "/home/test", "chrome"), [
    "/home/test/.config/google-chrome/NativeMessagingHosts",
  ]);
  assert.throws(() => nativeManifestDirectories("win32", "C:\\Users\\test", "all"), /仅支持/);
  assert.throws(() => parseInstallArgs(["--manifest-dir", "relative"]), /绝对路径/);

  const layout = resolveInstallLayout({
    platform: "linux",
    homeDir: "/home/test",
    projectRoot: "/project",
    installRoot: "/install",
    nodePath: "/node",
    browser: "edge",
  });
  assert.equal(layout.dataDir, "/install/data");
  assert.deepEqual(layout.manifests, [
    `/home/test/.config/microsoft-edge/NativeMessagingHosts/${HOST_NAME}.json`,
  ]);
});
