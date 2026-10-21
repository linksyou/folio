import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXTENSION_ID } from "../src/shared/extension-identity.js";
import { HOST_NAME } from "../src/shared/protocol.js";

const MANAGED_MARKER = "folio managed file";
const INSTALL_MARKER = ".folio-install.json";
const MINIMUM_NODE = [22, 12] as const;
const NATIVE_DESCRIPTION = "Folio local native host";

export type BrowserTarget = "chrome" | "edge" | "all";

export interface CliOptions {
  uninstall: boolean;
  browser: BrowserTarget;
  manifestDir?: string;
}

export interface InstallOptions {
  browser?: BrowserTarget;
  /** Override registration location. Used by isolated Chromium runs and tests. */
  manifestDir?: string;
  /** Directory containing dist/host/main.cjs. */
  projectRoot?: string;
  /** Program files live here. Defaults to ~/.local/share/folio. */
  installRoot?: string;
  /** Credentials and settings live here and are never removed by uninstall. */
  dataDir?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  nodePath?: string;
}

export interface InstallLayout {
  installRoot: string;
  dataDir: string;
  sourceBundle: string;
  installedBundle: string;
  wrapper: string;
  marker: string;
  manifests: string[];
  nodePath: string;
}

export interface OperationResult {
  layout: InstallLayout;
  messages: string[];
}

interface NativeManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

function currentProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function requireAbsolute(label: string, value: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径：${value}`);
  return path.normalize(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function manifestFile(directory: string): string {
  return path.join(directory, `${HOST_NAME}.json`);
}

export function assertSupportedNode(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor < MINIMUM_NODE[1])) {
    throw new Error(`需要 Node.js >= ${MINIMUM_NODE.join(".")}，当前版本为 ${version}。`);
  }
}

export function parseInstallArgs(args: string[]): CliOptions {
  const result: CliOptions = { uninstall: false, browser: "all" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--uninstall") {
      result.uninstall = true;
      continue;
    }
    if (argument === "--browser" || argument.startsWith("--browser=")) {
      const value = argument === "--browser" ? args[++index] : argument.slice("--browser=".length);
      if (value !== "chrome" && value !== "edge" && value !== "all") {
        throw new Error("--browser 只支持 chrome、edge 或 all。");
      }
      result.browser = value;
      continue;
    }
    if (argument === "--manifest-dir" || argument.startsWith("--manifest-dir=")) {
      const value = argument === "--manifest-dir" ? args[++index] : argument.slice("--manifest-dir=".length);
      if (!value) throw new Error("--manifest-dir 缺少路径。");
      result.manifestDir = requireAbsolute("--manifest-dir", value);
      continue;
    }
    throw new Error(`未知参数：${argument}`);
  }
  return result;
}

export function nativeManifestDirectories(
  platform: NodeJS.Platform,
  homeDir: string,
  browser: BrowserTarget,
): string[] {
  const selected = browser === "all" ? ["chrome", "edge"] as const : [browser];
  if (platform === "darwin") {
    const directories = {
      chrome: path.join(homeDir, "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
      edge: path.join(homeDir, "Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
    };
    return selected.map((name) => directories[name]);
  }
  if (platform === "linux") {
    const directories = {
      chrome: path.join(homeDir, ".config/google-chrome/NativeMessagingHosts"),
      edge: path.join(homeDir, ".config/microsoft-edge/NativeMessagingHosts"),
    };
    return selected.map((name) => directories[name]);
  }
  throw new Error(`当前安装器仅支持 macOS 和 Linux，暂不支持 ${platform}。`);
}

export function resolveInstallLayout(options: InstallOptions = {}): InstallLayout {
  const platform = options.platform ?? process.platform;
  const home = path.resolve(options.homeDir ?? homedir());
  const projectRoot = path.resolve(options.projectRoot ?? currentProjectRoot());
  const installRoot = requireAbsolute(
    "installRoot",
    options.installRoot ?? path.join(home, ".local/share/folio"),
  );
  const dataDir = requireAbsolute("dataDir", options.dataDir ?? path.join(installRoot, "data"));
  const nodePath = requireAbsolute("Node 可执行文件", options.nodePath ?? process.execPath);
  const manifestDirectories = options.manifestDir
    ? [requireAbsolute("manifestDir", options.manifestDir)]
    : nativeManifestDirectories(platform, home, options.browser ?? "all");

  return {
    installRoot,
    dataDir,
    sourceBundle: path.join(projectRoot, "dist/host/main.cjs"),
    installedBundle: path.join(installRoot, "host/main.cjs"),
    wrapper: path.join(installRoot, "host/run-host.sh"),
    marker: path.join(installRoot, INSTALL_MARKER),
    manifests: manifestDirectories.map(manifestFile),
    nodePath,
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(file: string, contents: string | Uint8Array, mode: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isOwnedManifest(value: unknown): value is NativeManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<NativeManifest>;
  return manifest.name === HOST_NAME &&
    manifest.description === NATIVE_DESCRIPTION &&
    manifest.type === "stdio" &&
    Array.isArray(manifest.allowed_origins) &&
    manifest.allowed_origins.length === 1 &&
    manifest.allowed_origins[0] === `chrome-extension://${EXTENSION_ID}/`;
}

async function assertSafeTargets(layout: InstallLayout): Promise<void> {
  if (await exists(layout.marker)) {
    let marker: unknown;
    try { marker = JSON.parse(await readFile(layout.marker, "utf8")); } catch { marker = undefined; }
    if (!marker || typeof marker !== "object" || (marker as { name?: unknown }).name !== HOST_NAME) {
      throw new Error(`安装目录包含无法识别的标记，未覆盖：${layout.installRoot}`);
    }
  } else {
    for (const target of [layout.installedBundle, layout.wrapper]) {
      if (await exists(target)) throw new Error(`目标文件不属于本项目，未覆盖：${target}`);
    }
  }

  for (const manifestPath of layout.manifests) {
    if (!(await exists(manifestPath))) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(manifestPath, "utf8")); } catch { parsed = undefined; }
    if (!isOwnedManifest(parsed)) {
      throw new Error(`原生消息注册文件不属于本项目，未覆盖：${manifestPath}`);
    }
  }
}

function wrapperContents(layout: InstallLayout): string {
  return [
    "#!/bin/sh",
    `# ${MANAGED_MARKER}`,
    `export FOLIO_DATA_DIR=${shellQuote(layout.dataDir)}`,
    `exec ${shellQuote(layout.nodePath)} ${shellQuote(layout.installedBundle)} "$@"`,
    "",
  ].join("\n");
}

function manifestContents(layout: InstallLayout): string {
  const manifest: NativeManifest = {
    name: HOST_NAME,
    description: NATIVE_DESCRIPTION,
    path: layout.wrapper,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function installHost(options: InstallOptions = {}): Promise<OperationResult> {
  assertSupportedNode();
  const layout = resolveInstallLayout(options);
  if (!(await exists(layout.sourceBundle))) {
    throw new Error(`缺少本地主机构建产物：${layout.sourceBundle}\n请先运行 npm run build。`);
  }
  const sourceInfo = await stat(layout.sourceBundle);
  if (!sourceInfo.isFile()) throw new Error(`本地主机构建产物不是文件：${layout.sourceBundle}`);
  await assertSafeTargets(layout);

  const bundle = await readFile(layout.sourceBundle);
  await mkdir(layout.dataDir, { recursive: true, mode: 0o700 });
  await chmod(layout.dataDir, 0o700);
  await atomicWrite(layout.installedBundle, bundle, 0o644);
  await atomicWrite(layout.wrapper, wrapperContents(layout), 0o755);
  await atomicWrite(
    layout.marker,
    `${JSON.stringify({ name: HOST_NAME, version: 1 }, null, 2)}\n`,
    0o600,
  );
  for (const manifestPath of layout.manifests) {
    await atomicWrite(manifestPath, manifestContents(layout), 0o644);
  }

  return {
    layout,
    messages: [
      `本地辅助程序已安装：${layout.wrapper}`,
      `已注册 ${layout.manifests.length} 个浏览器原生消息入口。`,
      `用户数据目录：${layout.dataDir}`,
    ],
  };
}

export async function uninstallHost(options: InstallOptions = {}): Promise<OperationResult> {
  const layout = resolveInstallLayout(options);
  const messages: string[] = [];

  for (const manifestPath of layout.manifests) {
    if (!(await exists(manifestPath))) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(manifestPath, "utf8")); } catch { parsed = undefined; }
    if (!isOwnedManifest(parsed)) {
      messages.push(`跳过不属于本项目的注册文件：${manifestPath}`);
      continue;
    }
    await rm(manifestPath);
  }

  let retainedRegistration: string | undefined;
  if (!options.manifestDir) {
    const platform = options.platform ?? process.platform;
    const home = path.resolve(options.homeDir ?? homedir());
    const selected = new Set(layout.manifests);
    for (const directory of nativeManifestDirectories(platform, home, "all")) {
      const candidate = manifestFile(directory);
      if (selected.has(candidate) || !(await exists(candidate))) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(candidate, "utf8")); } catch { parsed = undefined; }
      if (isOwnedManifest(parsed) && parsed.path === layout.wrapper) {
        retainedRegistration = candidate;
        break;
      }
    }
  }

  let ownsInstall = false;
  if (await exists(layout.marker)) {
    try {
      const marker = JSON.parse(await readFile(layout.marker, "utf8")) as { name?: unknown };
      ownsInstall = marker.name === HOST_NAME;
    } catch {
      ownsInstall = false;
    }
  }
  if (ownsInstall && retainedRegistration) {
    messages.push(`仍有浏览器使用本地辅助程序，已保留程序文件：${retainedRegistration}`);
  } else if (ownsInstall) {
    await rm(layout.installedBundle, { force: true });
    await rm(layout.wrapper, { force: true });
    await rm(layout.marker, { force: true });
    await rmdir(path.dirname(layout.wrapper)).catch(() => undefined);
  } else if (await exists(layout.installedBundle) || await exists(layout.wrapper)) {
    messages.push(`跳过无法确认归属的程序文件：${path.dirname(layout.wrapper)}`);
  }

  messages.push(`卸载完成；用户数据保留在：${layout.dataDir}`);
  return { layout, messages };
}

async function main(): Promise<void> {
  try {
    const cli = parseInstallArgs(process.argv.slice(2));
    const operation = cli.uninstall ? uninstallHost : installHost;
    const result = await operation({ browser: cli.browser, manifestDir: cli.manifestDir });
    for (const message of result.messages) console.log(message);
  } catch (error) {
    const message = error instanceof Error ? error.message : "安装操作失败。";
    console.error(`错误：${message}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entry === import.meta.url) await main();
