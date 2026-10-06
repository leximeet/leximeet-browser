import fs from "node:fs";
import path from "node:path";

// 公开文档必须能独立阅读：本仓相对链接与图片不能依赖私人过程目录。
const root = path.resolve(import.meta.dirname, "..");
const documents = [];
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (
      entry.isDirectory() &&
      !["assets", ".chat", ".git", "node_modules"].includes(entry.name)
    )
      collect(full);
    else if (entry.isFile() && entry.name.endsWith(".md")) documents.push(full);
  }
}
collect(path.join(root, "docs"));
for (const entry of fs.readdirSync(root)) {
  if (entry.endsWith(".md") && fs.statSync(path.join(root, entry)).isFile())
    documents.push(path.join(root, entry));
}
let links = 0;
const errors = [];
for (const file of documents) {
  const text = fs.readFileSync(file, "utf8");
  const name = path.relative(root, file);
  if (/\/Users\/|\/private\/var\/folders\/|dcs\/opensource\//.test(text))
    errors.push(`${name}: 公开文档包含私人路径或过程目录`);
  if ((text.match(/^```/gm) || []).length % 2 !== 0)
    errors.push(`${name}: Markdown代码围栏未闭合`);
  const references = [
    ...text.matchAll(/\]\(([^)\n]+)\)/g),
    ...text.matchAll(/(?:src|srcset)="([^"]+)"/g),
  ];
  for (const reference of references) {
    const url = reference[1].trim().replace(/^<|>$/g, "");
    if (/^file:/i.test(url)) {
      errors.push(`${name}: 文件链接不能依赖本机绝对路径`);
      continue;
    }
    if (/^(?:[a-z]+:|#|\/\/)/i.test(url)) continue;
    const target = decodeURIComponent(url.split("#")[0]);
    if (!target) continue;
    links++;
    const full = path.resolve(path.dirname(file), target);
    if (!full.startsWith(root + path.sep) || !fs.existsSync(full))
      errors.push(`${name}: 无效本仓引用 ${target}`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log(`公开文档 ${documents.length} 篇，${links} 个本仓引用通过`);
