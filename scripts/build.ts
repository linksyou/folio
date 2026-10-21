import { build } from "esbuild";
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { EXTENSION_PUBLIC_KEY } from "../src/shared/extension-identity.js";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/extension", { recursive: true });
const [, host] = await Promise.all([
  build({
    entryPoints: ["src/extension/background.ts", "src/extension/content.ts", "src/extension/popup.ts", "src/extension/options.ts"],
    bundle: true, outdir: "dist/extension", platform: "browser", target: "chrome120",
    format: "iife", sourcemap: true, legalComments: "eof",
  }),
  build({
    entryPoints: ["src/host/main.ts"], bundle: true, outfile: "dist/host/main.cjs",
    platform: "node", target: "node22", format: "cjs", sourcemap: false, legalComments: "eof", metafile: true,
  }),
]);
// The copied host is self-contained; keep every bundled dependency's full license with it.
const packages = new Set(Object.keys(host.metafile!.inputs).flatMap((file) => {
  const match = /^(node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file);
  return match ? [match[1]] : [];
}));
for (const directory of [...packages].sort()) {
  const filename = (await readdir(directory)).find((name) => /^licen[cs]e(?:\.(?:md|txt))?$/i.test(name));
  if (!filename) throw new Error(`Missing dependency license: ${directory}`);
  const license = await readFile(`${directory}/${filename}`, "utf8");
  await appendFile("dist/host/main.cjs", `\n/* ${directory}\n${license.replaceAll("*/", "* /")}\n*/\n`);
}
for (const file of ["popup.html", "options.html", "ui.css"]) {
  await cp(`src/extension/${file}`, `dist/extension/${file}`);
}
await cp("src/extension/icons", "dist/extension/icons", { recursive: true });
const icons = Object.fromEntries([16, 32, 48, 128].map((size) => [size, `icons/icon-${size}.png`]));
await writeFile("dist/extension/manifest.json", JSON.stringify({
  manifest_version: 3,
  name: "Open Web Translator",
  version: "0.1.0",
  description: "使用 ChatGPT 或自定义 API，按网站自动翻译网页正文，支持双语或仅译文阅读。",
  minimum_chrome_version: "120",
  key: EXTENSION_PUBLIC_KEY,
  icons,
  permissions: ["activeTab", "scripting", "nativeMessaging", "storage"],
  // Only the existing brand image is exposed for the page-local floating button.
  web_accessible_resources: [{ resources: ["icons/icon-32.png"], matches: ["http://*/*", "https://*/*"] }],
  optional_host_permissions: ["http://*/*", "https://*/*"],
  commands: {
    "translate-page": { suggested_key: { default: "Alt+A" }, description: "翻译当前网页正文" },
    "restore-page": { suggested_key: { default: "Alt+R" }, description: "恢复当前网页原文" },
  },
  action: { default_popup: "popup.html", default_title: "翻译当前网页", default_icon: icons },
  options_ui: { page: "options.html", open_in_tab: true },
  background: { service_worker: "background.js" },
}, null, 2) + "\n");
console.log("已构建 dist/extension 和 dist/host/main.cjs。");
