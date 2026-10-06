import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const apiOrigin = "https://api.addons.microsoftedge.microsoft.com";
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const productIdentifier =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Location 可能是操作 ID 或完整地址；仅提取本产品的操作 ID，不向返回的任意地址发送密钥。
export function uploadOperationId(location, productId) {
  if (typeof location !== "string" || !location)
    throw new Error("上传响应缺少操作 ID，请在后台检查草稿");
  if (identifier.test(location)) return location;
  const url = new URL(location, apiOrigin);
  const prefix = `/v1/products/${productId}/submissions/draft/package/operations/`;
  const id = url.pathname.slice(prefix.length);
  if (
    url.origin !== apiOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix) ||
    !identifier.test(id)
  ) {
    throw new Error("上传响应的操作地址不属于当前 Edge 草稿，请在后台检查");
  }
  return id;
}

export async function uploadEdgeDraft({
  packagePath,
  expectedSha256,
  productId,
  clientId,
  apiKey,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxPolls = 60,
}) {
  if (!productIdentifier.test(productId ?? ""))
    throw new Error("EDGE_PRODUCT_ID 必须是 Partner Center 的产品 GUID");
  if (!clientId?.trim() || !apiKey?.trim())
    throw new Error("缺少 EDGE_CLIENT_ID 或 EDGE_API_KEY");
  if (![clientId, apiKey].every((value) => !/[\r\n]/.test(value)))
    throw new Error("Edge 凭据格式无效");
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? "") || !packagePath?.endsWith(".zip"))
    throw new Error("必须提供已验收 ZIP 及其 SHA-256");
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 60)
    throw new Error("无效的状态轮询预算");
  const bytes = await readFile(packagePath);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error("安装包 SHA-256 不匹配，未上传");
  const headers = { Authorization: `ApiKey ${apiKey}`, "X-ClientID": clientId };
  const path = `/v1/products/${productId}/submissions/draft/package`;
  // POST 只发送一次。断网或超时后结果可能不确定，不能自动重复提交。
  let upload;
  try {
    upload = await fetchImpl(`${apiOrigin}${path}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/zip" },
      body: bytes,
      redirect: "error",
      signal: AbortSignal.timeout(300_000),
    });
  } catch {
    throw new Error("上传请求结果未知；请先在 Partner Center 检查草稿，勿直接重复上传");
  }
  if (upload.status !== 202)
    throw new Error(
      `Edge 未接受上传（HTTP ${upload.status}），请检查产品、凭据和后台状态`,
    );
  const operationId = uploadOperationId(upload.headers.get("Location"), productId);
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    let response;
    try {
      response = await fetchImpl(`${apiOrigin}${path}/operations/${operationId}`, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error(`无法确认上传状态（操作 ${operationId}），请检查后台；未重复上传`);
    }
    if (response.status !== 200)
      throw new Error(
        `状态查询失败（HTTP ${response.status}，操作 ${operationId}），请检查后台`,
      );
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`状态响应无效（操作 ${operationId}），请检查后台`);
    }
    if (result.status === "Succeeded")
      return { status: "Succeeded", operationId, sha256: actualSha256 };
    if (result.status !== "InProgress")
      throw new Error(`安装包未通过处理（操作 ${operationId}），请查看后台错误详情`);
    if (attempt + 1 < maxPolls) await sleep(5_000);
  }
  throw new Error(`上传仍在处理（操作 ${operationId}），请到后台确认；未重复上传`);
}

// 此入口只写草稿，没有提交审核或发布接口。凭据只从环境读取，不输出服务端原文。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4)
      throw new Error("用法：node scripts/upload-edge-draft.mjs <package.zip> <sha256>");
    const result = await uploadEdgeDraft({
      packagePath: process.argv[2],
      expectedSha256: process.argv[3],
      productId: process.env.EDGE_PRODUCT_ID,
      clientId: process.env.EDGE_CLIENT_ID,
      apiKey: process.env.EDGE_API_KEY,
    });
    console.log(
      `Edge 草稿包处理成功：${result.operationId}，SHA-256 ${result.sha256}。尚未提交审核或发布。`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
