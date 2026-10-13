import { readFile } from "node:fs/promises";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { uploadEdgeDraft, uploadOperationId } from "./upload-edge-draft.mjs";
import { verifyPackages } from "./package-github-release.mjs";
import { compareVersions } from "./verify-latest-store-release.mjs";

const chromeOrigin = "https://chromewebstore.googleapis.com";
const edgeOrigin = "https://api.addons.microsoftedge.microsoft.com";
const scope = "https://www.googleapis.com/auth/chromewebstore";
const tokenUrl = "https://oauth2.googleapis.com/token";
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 商店响应可能含个人信息或凭据。只报告固定阶段、HTTP 状态和已校验的操作 ID。
async function jsonRequest(fetchImpl, url, options, stage, emptyResponse = false) {
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
  // cancelSubmission 成功没有 JSON。仍须另查状态，不能把空响应当作取消已生效。
  if (emptyResponse) {
    if (![200, 204].includes(response.status))
      throw new Error(`${stage}结果未确认，请检查商店后台；没有自动重试写请求`);
    return;
  }
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
  replacePendingReview = false,
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
    maxPolls > 60 ||
    typeof replacePendingReview !== "boolean"
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
  const versionsOf = (revision) => {
    if (!revision) return [];
    const channels = revision.distributionChannels;
    if (
      !Array.isArray(channels) ||
      !channels.length ||
      channels.some((channel) => !versionPattern.test(channel?.crxVersion ?? ""))
    )
      throw new Error("Chrome 商店版本信息不完整，停止写入");
    return [...new Set(channels.map((channel) => channel.crxVersion))];
  };
  const checkStatus = (status) => {
    if (status.takenDown) throw new Error("Chrome 扩展已被下架，请先检查后台");
    const published = status.publishedItemRevisionStatus;
    const submitted = status.submittedItemRevisionStatus;
    if (published && published.state !== "PUBLISHED")
      throw new Error("Chrome 已发布状态未知或不是公开发行，停止写入");
    const publishedVersions = versionsOf(published);
    if (publishedVersions.some((value) => compareVersions(value, version) > 0))
      throw new Error("Chrome 已发布更新版本，停止旧工作流写入");
    // 已结束的取消/拒绝记录可能没有渠道信息；只对活动提交要求确切版本。
    if (
      submitted &&
      !["PENDING_REVIEW", "STAGED", "PUBLISHED", "REJECTED", "CANCELLED"].includes(
        submitted.state,
      )
    )
      throw new Error("Chrome 提交状态未知，停止写入");
    const submittedVersions = ["PENDING_REVIEW", "STAGED", "PUBLISHED"].includes(
      submitted?.state,
    )
      ? versionsOf(submitted)
      : [];
    if (submittedVersions.length > 1)
      throw new Error("Chrome 待审核版本不唯一，停止写入");
    if (submittedVersions.some((value) => compareVersions(value, version) > 0))
      throw new Error("Chrome 已有其他待审核的更新版本，停止旧工作流写入");
    if (submitted?.state === "PENDING_REVIEW" && submittedVersions[0] === version)
      return { state: "PENDING_REVIEW", alreadySubmitted: true, version };
    if (submitted?.state === "PUBLISHED" && submittedVersions[0] === version)
      return { state: "PUBLISHED", alreadySubmitted: true, version };
    if (published?.state === "PUBLISHED" && publishedVersions.includes(version))
      return { state: "PUBLISHED", alreadySubmitted: true, version };
  };
  let before = await getStatus();
  const existing = checkStatus(before);
  if (existing) return existing;
  let cancelledVersion;
  if (before.submittedItemRevisionStatus?.state === "STAGED")
    throw new Error("Chrome 已有其他待审核/待发布版本；已通过审核的版本须手动处理");
  if (before.submittedItemRevisionStatus?.state === "PENDING_REVIEW") {
    if (!replacePendingReview)
      throw new Error("Chrome 已有其他待审核/待发布版本，请先处理后台状态");
    const oldVersion = versionsOf(before.submittedItemRevisionStatus)[0];
    // 取消接口没有版本条件参数。临写前再读一次；串行锁之外请勿同时人工送审。
    before = await getStatus();
    const changed = checkStatus(before);
    if (changed) return changed;
    if (
      before.submittedItemRevisionStatus?.state !== "PENDING_REVIEW" ||
      versionsOf(before.submittedItemRevisionStatus)[0] !== oldVersion
    )
      throw new Error("Chrome 审核状态已变化，未取消或上传，请重新核对后台");
    await jsonRequest(
      fetchImpl,
      `${url}:cancelSubmission`,
      { method: "POST", headers },
      "Chrome 取消旧审核",
      true,
    );
    let cancelled = false;
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const status = await getStatus();
      const already = checkStatus(status);
      if (already) return already;
      const active = status.submittedItemRevisionStatus;
      if (!active || ["CANCELLED", "REJECTED"].includes(active.state)) {
        cancelled = true;
        break;
      }
      if (active.state !== "PENDING_REVIEW" || versionsOf(active)[0] !== oldVersion)
        throw new Error("Chrome 取消期间审核状态已变化，停止上传");
      if (attempt + 1 < maxPolls) await sleep(5000);
    }
    if (!cancelled) throw new Error("Chrome 旧审核取消尚未确认，未上传新包；请检查后台");
    cancelledVersion = oldVersion;
  }
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
  // 上传可能耗时数分钟，送审前再核对活动版本，不能覆盖同时发生的人工提交。
  const ready = await getStatus();
  const submitted = checkStatus(ready);
  if (submitted) return submitted;
  if (["PENDING_REVIEW", "STAGED"].includes(ready.submittedItemRevisionStatus?.state))
    throw new Error("Chrome 上传期间出现其他活动提交，停止送审，请核对后台");
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
  return {
    state: result.state,
    alreadySubmitted: false,
    version,
    ...(cancelledVersion ? { cancelledVersion } : {}),
  };
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
    const replace = process.env.CHROME_REPLACE_PENDING_REVIEW ?? "0";
    if (store === "chrome" && !["0", "1"].includes(replace))
      throw new Error("CHROME_REPLACE_PENDING_REVIEW 仅支持 0 或 1");
    const result =
      store === "chrome"
        ? await publishChrome({
            ...common,
            publisherId: process.env.CHROME_PUBLISHER_ID,
            extensionId: process.env.CHROME_EXTENSION_ID,
            replacePendingReview: replace === "1",
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
    const summary = `${store} ${evidence.version}: ${result.state}${result.alreadySubmitted ? "（该版本已送审/发布，没有重复上传）" : ""}${result.cancelledVersion ? `（已取消旧版本 ${result.cancelledVersion} 的审核）` : ""}；最终上架仍由商店审核决定。\n`;
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
