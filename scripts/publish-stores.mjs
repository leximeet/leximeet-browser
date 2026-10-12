import { readFile } from "node:fs/promises";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { uploadEdgeDraft, uploadOperationId } from "./upload-edge-draft.mjs";
import { verifyPackages } from "./package-github-release.mjs";

const chromeOrigin = "https://chromewebstore.googleapis.com";
const edgeOrigin = "https://api.addons.microsoftedge.microsoft.com";
const scope = "https://www.googleapis.com/auth/chromewebstore";
const tokenUrl = "https://oauth2.googleapis.com/token";
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 商店响应可能含个人信息或凭据。只报告固定阶段、HTTP 状态和已校验的操作 ID。
async function jsonRequest(fetchImpl, url, options, stage) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(options.body instanceof Uint8Array ? 300_000 : 30_000),
    });
  } catch {
    throw new Error(`${stage}结果未知，请先检查商店后台；没有自动重试写请求`);
  }
  if (!response.ok)
    throw new Error(`${stage}失败（HTTP ${response.status}），请检查商店后台`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${stage}响应无效，请检查商店后台`);
  }
}

async function checkedZip(packagePath, expectedSha256) {
  if (!packagePath?.endsWith(".zip") || !/^[0-9a-f]{64}$/.test(expectedSha256 ?? ""))
    throw new Error("必须提供验收 ZIP 与 SHA-256");
  const bytes = await readFile(packagePath);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
    throw new Error("安装包 SHA-256 不匹配，未访问商店");
  return bytes;
}

// 使用 Google 官方服务账号 JWT 交换规范；只申请 Chrome Web Store scope，不代入个人账号。
export async function chromeAccessToken(
  serviceAccountJson,
  fetchImpl = fetch,
  now = Date.now(),
) {
  let account, key;
  try {
    account = JSON.parse(serviceAccountJson);
    if (
      account.type !== "service_account" ||
      !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(account.client_email)
    )
      throw new Error();
    key = createPrivateKey(account.private_key);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
  } catch {
    throw new Error("CHROME_SERVICE_ACCOUNT_JSON 必须是有效的 RSA 服务账号 JSON 密钥");
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issued = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope, aud: tokenUrl, iat: issued, exp: issued + 3600 })}`;
  const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
  const result = await jsonRequest(
    fetchImpl,
    tokenUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
    "Google 服务账号认证",
  );
  if (
    result.token_type !== "Bearer" ||
    typeof result.access_token !== "string" ||
    !result.access_token ||
    /[\r\n]/.test(result.access_token)
  )
    throw new Error("Google 没有返回有效 access token");
  return result.access_token;
}

export async function publishChrome({
  packagePath,
  expectedSha256,
  version,
  publisherId,
  extensionId,
  accessToken,
  fetchImpl = fetch,
  sleep = pause,
  maxPolls = 60,
}) {
  if (
    !versionPattern.test(version ?? "") ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(publisherId ?? "") ||
    !/^[a-p]{32}$/.test(extensionId ?? "")
  )
    throw new Error("Chrome 版本、Publisher ID 或扩展 ID 无效");
  if (
    !accessToken?.trim() ||
    /[\r\n]/.test(accessToken) ||
    !Number.isInteger(maxPolls) ||
    maxPolls < 1 ||
    maxPolls > 60
  )
    throw new Error("Chrome 凭据或轮询预算无效");
  const bytes = await checkedZip(packagePath, expectedSha256);
  const name = `publishers/${publisherId}/items/${extensionId}`;
  const url = `${chromeOrigin}/v2/${name}`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  const identity = (value) => {
    if (value.name !== name || value.itemId !== extensionId)
      throw new Error("Chrome 响应不是当前扩展，停止发布");
    return value;
  };
  const getStatus = async () =>
    identity(
      await jsonRequest(
        fetchImpl,
        `${url}:fetchStatus`,
        { method: "GET", headers },
        "Chrome 状态查询",
      ),
    );
  const before = await getStatus();
  if (before.takenDown) throw new Error("Chrome 扩展已被下架，请先检查后台");
  // 补跑失败任务时，已发布/已送审的同版本不再上传。不同版本正在审核时不能覆盖。
  for (const revision of [
    before.submittedItemRevisionStatus,
    before.publishedItemRevisionStatus,
  ]) {
    const versions =
      revision?.distributionChannels?.map((channel) => channel.crxVersion) ?? [];
    if (
      ["PENDING_REVIEW", "PUBLISHED"].includes(revision?.state) &&
      versions.includes(version)
    )
      return { state: revision.state, alreadySubmitted: true, version };
  }
  if (["PENDING_REVIEW", "STAGED"].includes(before.submittedItemRevisionStatus?.state))
    throw new Error("Chrome 已有其他待审核/待发布版本，请先处理后台状态");
  const upload = identity(
    await jsonRequest(
      fetchImpl,
      `${chromeOrigin}/upload/v2/${name}:upload`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/zip" },
        body: bytes,
      },
      "Chrome 上传",
    ),
  );
  if (upload.crxVersion && upload.crxVersion !== version)
    throw new Error("Chrome 接收的版本与标签不同，未提交审核");
  let uploadState = upload.uploadState;
  for (let attempt = 0; uploadState === "IN_PROGRESS" && attempt < maxPolls; attempt++) {
    await sleep(5000);
    uploadState = (await getStatus()).lastAsyncUploadState;
  }
  if (uploadState !== "SUCCEEDED")
    throw new Error("Chrome 上传未确认成功，未提交审核；请检查后台");
  const result = identity(
    await jsonRequest(
      fetchImpl,
      `${url}:publish`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ publishType: "DEFAULT_PUBLISH", skipReview: false }),
      },
      "Chrome 提交审核",
    ),
  );
  if (!["PENDING_REVIEW", "PUBLISHED"].includes(result.state))
    throw new Error("Chrome 未返回待审核或已发布状态，请检查后台；未重复提交");
  return { state: result.state, alreadySubmitted: false, version };
}

export async function publishEdge(options) {
  const {
    productId,
    clientId,
    apiKey,
    notes,
    fetchImpl = fetch,
    sleep = pause,
    maxPolls = 60,
  } = options;
  if (typeof notes !== "string" || !notes.trim() || notes.length > 2000)
    throw new Error("Edge 审核说明须为 1–2000 个字符");
  // 保留原来的草稿接口；确认原样包上传成功后才启动提交，不盲目重复 POST。
  const uploaded = await uploadEdgeDraft({ ...options, fetchImpl, sleep, maxPolls });
  const headers = { Authorization: `ApiKey ${apiKey}`, "X-ClientID": clientId };
  const url = `${edgeOrigin}/v1/products/${productId}/submissions`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Edge 提交审核结果未知，请检查后台；未重复提交");
  }
  if (response.status !== 202)
    throw new Error(`Edge 未接受提交审核（HTTP ${response.status}），请检查后台`);
  const operationId = uploadOperationId(
    response.headers.get("Location"),
    productId,
    "submission",
  );
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const result = await jsonRequest(
      fetchImpl,
      `${url}/operations/${operationId}`,
      { method: "GET", headers },
      "Edge 提交状态查询",
    );
    if (result.status === "Succeeded")
      return { state: "SUBMITTED", operationId, uploadOperationId: uploaded.operationId };
    if (result.status !== "InProgress")
      throw new Error(`Edge 提交未成功（操作 ${operationId}），请检查后台`);
    if (attempt + 1 < maxPolls) await sleep(5000);
  }
  throw new Error(`Edge 提交仍在处理（操作 ${operationId}），请检查后台；未重复提交`);
}

// 仅发布经过 CI 门禁的原样 ZIP，CLI 不能使用任意路径绕过标签、来源和大小摘要校验。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [store, directory] = process.argv.slice(2);
    if (!["chrome", "edge"].includes(store) || !directory || process.argv.length !== 4)
      throw new Error(
        "用法：node scripts/publish-stores.mjs <chrome|edge> <验收附件目录>",
      );
    const evidence = JSON.parse(
      await readFile(path.join(directory, "store-packages.json"), "utf8"),
    );
    const files = verifyPackages(
      directory,
      evidence,
      process.env.GITHUB_REF_NAME,
      process.env.GITHUB_SHA,
    );
    const item = files.find((file) => file.file.endsWith(`-${store}.zip`));
    const common = {
      packagePath: path.join(directory, item.file),
      expectedSha256: item.sha256,
      version: evidence.version,
    };
    const result =
      store === "chrome"
        ? await publishChrome({
            ...common,
            publisherId: process.env.CHROME_PUBLISHER_ID,
            extensionId: process.env.CHROME_EXTENSION_ID,
            accessToken: await chromeAccessToken(process.env.CHROME_SERVICE_ACCOUNT_JSON),
          })
        : await publishEdge({
            ...common,
            productId: process.env.EDGE_PRODUCT_ID,
            clientId: process.env.EDGE_CLIENT_ID,
            apiKey: process.env.EDGE_API_KEY,
            notes: await readFile(
              new URL("./store-certification-notes.txt", import.meta.url),
              "utf8",
            ),
          });
    const summary = `${store} ${evidence.version}: ${result.state}${result.alreadySubmitted ? "（该版本已送审/发布，没有重复上传）" : ""}；最终上架仍由商店审核决定。\n`;
    console.log(summary.trim());
    if (process.env.GITHUB_STEP_SUMMARY)
      await (
        await import("node:fs/promises")
      ).appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
