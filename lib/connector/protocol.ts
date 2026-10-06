import contract from "./contracts/contract.json" with { type: "json" };
import methods from "./contracts/methods.json" with { type: "json" };
import hostMethods from "./contracts/host-methods.json" with { type: "json" };
import desktop from "./contracts/desktop-api.v1.schema.json" with { type: "json" };
import reading from "./contracts/reading-domain.v1.schema.json" with { type: "json" };
import host from "./contracts/browser-host.v1.schema.json" with { type: "json" };
import dictionary from "./contracts/dictionary-entry.v2.schema.json" with { type: "json" };
import { LmcpError } from "./types.ts";
import type { HelloResult } from "./types.ts";

export const LMCP_CONTRACT = Object.freeze({
  apiMajor: 1 as const,
  apiVersion: contract.apiVersion,
  version: contract.packageVersion,
  digest: contract.contractDigest,
  nativeHost: contract.browserBinding.nativeHostName,
  maxFrameBytes: contract.browserBinding.maxFrameBytes,
  requiredCapabilities: Object.freeze([...contract.requiredCapabilities]),
});
export const LMCP_METHODS = Object.freeze(
  methods.map((method) => Object.freeze({ ...method })),
);
export const LMCP_HOST_METHODS = Object.freeze(
  hostMethods.map((method) => Object.freeze({ ...method })),
);

// 版本按三段整数比较，不能用字符串或浮点数比较 1.10 与 1.9。
export function assertApiCompatibility(
  actual: string,
  minimum = LMCP_CONTRACT.apiVersion,
  major = LMCP_CONTRACT.apiMajor,
): void {
  const parse = (value: string) => {
    if (
      value.length > 40 ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)
    )
      throw new LmcpError("UNSUPPORTED_VERSION", "Desktop API 版本格式不受支持");
    return value.split(".").map(BigInt) as [bigint, bigint, bigint];
  };
  const needed = parse(minimum),
    peer = parse(actual);
  if (
    needed[0] !== BigInt(major) ||
    peer[0] !== needed[0] ||
    peer[1] < needed[1] ||
    (peer[1] === needed[1] && peer[2] < needed[2])
  )
    throw new LmcpError("UNSUPPORTED_VERSION", "Desktop 未满足插件的最低 API 版本");
}

/**
 * 正式 1.x 按最低 API 与必需能力协商；规范摘要是本端构建身份，不是正式版本连接锁。
 * 任一端是预发布候选时仍要求合同版本和摘要完全相同，不提供旧候选兼容双栈。
 */
export function assertHelloCompatibility(
  hello: HelloResult,
  local: Pick<
    typeof LMCP_CONTRACT,
    "apiMajor" | "apiVersion" | "version" | "digest" | "requiredCapabilities"
  > = LMCP_CONTRACT,
): void {
  assertApiCompatibility(hello.apiVersion, local.apiVersion, local.apiMajor);
  if (
    (local.version.includes("-") || hello.contractVersion.includes("-")) &&
    (hello.contractVersion !== local.version || hello.contractDigest !== local.digest)
  )
    throw new LmcpError("CONTRACT_MISMATCH", "预发布 LMCP 候选不同，请更新到同一合同");
  if (
    local.requiredCapabilities.some(
      (capability) => !hello.capabilities.includes(capability),
    ) ||
    LMCP_METHODS.some(
      (method) => method.required && !hello.methods.includes(method.method),
    )
  )
    throw new LmcpError(
      "CAPABILITY_UNAVAILABLE",
      "Desktop 未提供遇见与采集需要的完整能力",
    );
}

type Schema = Record<string, unknown>;
const roots: Record<string, Schema> = {
  [desktop.$id]: desktop,
  [reading.$id]: reading,
  [host.$id]: host,
  [dictionary.$id]: dictionary,
};
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (object(a) && object(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
    );
  return false;
}
function resolve(ref: string, root: Schema): [Schema, Schema] {
  const [uri, fragment = ""] = ref.split("#");
  const target = uri ? roots[uri] : root;
  if (!target) throw new Error("LMCP 合同引用未固定");
  const node = fragment
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (value, part) =>
        object(value) ? value[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined,
      target,
    );
  if (!object(node)) throw new Error("LMCP 合同引用不存在");
  return [node, target];
}
// 只实现并完整测试当前冻结合同使用的 JSON Schema 关键字；不抓取网络 Schema。
function validate(schema: Schema, value: unknown, root: Schema, depth = 0): boolean {
  if (depth > 100) return false;
  if (typeof schema.$ref === "string") {
    const [target, targetRoot] = resolve(schema.$ref, root);
    if (!validate(target, value, targetRoot, depth + 1)) return false;
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const count = branches.filter(
      (branch) => object(branch) && validate(branch, value, root, depth + 1),
    ).length;
    if (
      (key === "anyOf" && count === 0) ||
      (key === "oneOf" && count !== 1) ||
      (key === "allOf" && count !== branches.length)
    )
      return false;
  }
  if (object(schema.if)) {
    const branch = validate(schema.if, value, root, depth + 1)
      ? schema.then
      : schema.else;
    if (object(branch) && !validate(branch, value, root, depth + 1)) return false;
  }
  if (Object.hasOwn(schema, "const") && !equal(schema.const, value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => equal(allowed, value)))
    return false;
  if (schema.type !== undefined) {
    const kinds = Array.isArray(schema.type) ? schema.type : [schema.type];
    const valid = kinds.some((kind) =>
      kind === "null"
        ? value === null
        : kind === "object"
          ? object(value)
          : kind === "array"
            ? Array.isArray(value)
            : kind === "integer"
              ? typeof value === "number" && Number.isSafeInteger(value)
              : kind === "number"
                ? typeof value === "number" && Number.isFinite(value)
                : typeof value === kind,
    );
    if (!valid) return false;
  }
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (typeof schema.minLength === "number" && length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return false;
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern, "u").test(value)
    )
      return false;
    if (
      schema.format === "date-time" &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value)
    )
      return false;
    if (
      schema.format === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      return false;
  }
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      (typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum))
  )
    return false;
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      return false;
    if (
      schema.uniqueItems === true &&
      value.some((item, index) =>
        value.slice(0, index).some((other) => equal(item, other)),
      )
    )
      return false;
    if (
      object(schema.items) &&
      !value.every((item) => validate(schema.items as Schema, item, root, depth + 1))
    )
      return false;
  }
  if (object(value)) {
    if (
      Array.isArray(schema.required) &&
      schema.required.some((key) => typeof key === "string" && !Object.hasOwn(value, key))
    )
      return false;
    const properties = object(schema.properties) ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
      // 仅合同声明的自有字段可绕过 additionalProperties，原型名称同样视为额外字段。
      const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (object(property)) {
        if (!validate(property, item, root, depth + 1)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (
        object(schema.additionalProperties) &&
        !validate(schema.additionalProperties, item, root, depth + 1)
      )
        return false;
    }
  }
  return true;
}
export type SchemaName = "Request" | "Response" | "HostRequest" | "HostResponse";
export function validFrame(schema: SchemaName, value: unknown): boolean {
  const root = schema.startsWith("Host") ? host : desktop;
  return validate(
    (root.$defs as unknown as Record<string, Schema>)[schema]!,
    value,
    root,
  );
}
export function assertFrame(schema: SchemaName, value: unknown): void {
  if (!validFrame(schema, value))
    throw new LmcpError("INVALID_FRAME", "LMCP 消息不符合当前合同");
}
export function validValue(
  name: string,
  value: unknown,
  source: "desktop" | "host" | "reading" = "desktop",
): boolean {
  const root = source === "desktop" ? desktop : source === "host" ? host : reading;
  const schema = (root.$defs as unknown as Record<string, Schema>)[name];
  return Boolean(schema && validate(schema, value, root));
}
export function encodedFrameBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new LmcpError("INVALID_FRAME", "LMCP 消息无法编码为 JSON");
  }
}

// 范围按 UTF-16 半开区间校验，既不截断代理对，也不接受没有实际选中词的语境。
export function assertCaptureSemantics(value: unknown): void {
  if (!validValue("recordEncounterParams", value))
    throw new LmcpError("INVALID_FRAME", "采集参数不符合当前合同");
  const data = (value as import("./types.ts").RecordEncounterParams).data;
  const check = (text: string, ranges: import("./types.ts").TextRange[]) => {
    if (!text.isWellFormed())
      throw new LmcpError("INVALID_UNICODE", "采集语境含无效字符");
    const insidePair = (i: number) =>
      i > 0 &&
      i < text.length &&
      text.charCodeAt(i - 1) >= 0xd800 &&
      text.charCodeAt(i - 1) <= 0xdbff &&
      text.charCodeAt(i) >= 0xdc00 &&
      text.charCodeAt(i) <= 0xdfff;
    if (
      ranges.some(
        ({ start, end }) =>
          end <= start ||
          end > text.length ||
          insidePair(start) ||
          insidePair(end) ||
          text.slice(start, end) !== data.surface,
      )
    )
      throw new LmcpError(
        "INVALID_OCCURRENCE_RANGE",
        "采集词必须与语境中的选词范围完全一致",
      );
  };
  check(data.originalSentence, data.occurrenceRanges);
  check(data.savedExcerpt, data.excerptRanges);
  if (data.source.kind === "web") {
    let url: URL;
    try {
      url = new URL(data.source.url ?? "");
    } catch {
      throw new LmcpError("INVALID_SOURCE_URL", "采集来源需要有效网页地址");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new LmcpError(
        "INVALID_SOURCE_URL",
        "采集来源只接受不含凭据和片段的 HTTP/HTTPS 地址",
      );
  } else if (data.source.url !== null)
    throw new LmcpError("INVALID_SOURCE_URL", "手动采集不携带网页地址");
}
