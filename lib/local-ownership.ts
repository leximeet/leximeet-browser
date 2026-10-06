// 独立资料只保留一份。连接期间原地封存，业务事实和偏好全部停止写入。
export const INDEPENDENT_OWNERSHIP_KEY = "independent-ownership";
const FORMAT = "leximeet.independent-ownership/1" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IndependentOwnership = {
  format: typeof FORMAT;
  state: "independent" | "frozen";
  generation: number;
  archiveId: string | null;
  frozenAt: string | null;
};

export class IndependentWorkspaceFrozenError extends Error {
  readonly code = "INDEPENDENT_WORKSPACE_FROZEN";
  constructor() {
    super("独立资料已封存；请明确断开桌面端连接后再修改");
    this.name = "IndependentWorkspaceFrozenError";
  }
}

const transactionFailures = new WeakMap<IDBTransaction, Error>();

function initialOwnership(): IndependentOwnership {
  return {
    format: FORMAT,
    state: "independent",
    generation: 0,
    archiveId: null,
    frozenAt: null,
  };
}

// 未建立控制记录的当前独立资料默认可写；未知格式拒绝保留，不做旧格式转换。
function ownershipRecord(value: unknown): IndependentOwnership {
  if (value === undefined) return initialOwnership();
  const item = value as IndependentOwnership;
  if (
    !item ||
    typeof item !== "object" ||
    Array.isArray(item) ||
    item.format !== FORMAT ||
    !Number.isSafeInteger(item.generation) ||
    item.generation < 0 ||
    (item.state !== "independent" && item.state !== "frozen") ||
    (item.state === "frozen"
      ? typeof item.archiveId !== "string" ||
        !UUID.test(item.archiveId) ||
        typeof item.frozenAt !== "string" ||
        !Number.isFinite(Date.parse(item.frozenAt))
      : item.archiveId !== null || item.frozenAt !== null)
  )
    throw new Error("独立资料归属记录无法识别，原资料未修改");
  return item;
}

/**
 * 所有业务写事务共享 meta 锁，归属检查必须是同一事务的首个请求。
 * 不先异步检查再创建事务：否则另一窗口可能在两步之间封存资料。
 * 即使调用方已排队 put，冻结时 abort 也会回滚整个事务。
 */
export function beginIndependentWrite(
  db: IDBDatabase,
  stores: string | string[],
): IDBTransaction {
  const names = typeof stores === "string" ? [stores] : stores;
  const tx = db.transaction([...new Set(["meta", ...names])], "readwrite");
  const check = tx.objectStore("meta").get(INDEPENDENT_OWNERSHIP_KEY);
  check.onsuccess = () => {
    try {
      if (ownershipRecord(check.result).state === "frozen")
        throw new IndependentWorkspaceFrozenError();
    } catch (error) {
      transactionFailures.set(tx, error as Error);
      tx.abort();
    }
  };
  return tx;
}

export function independentWriteFailure(tx: IDBTransaction, fallback: Error): Error {
  return transactionFailures.get(tx) || tx.error || fallback;
}

export async function readIndependentOwnership(
  db: IDBDatabase,
): Promise<IndependentOwnership> {
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("meta", "readonly")
      .objectStore("meta")
      .get(INDEPENDENT_OWNERSHIP_KEY);
    request.onsuccess = () => {
      try {
        resolve(ownershipRecord(request.result));
      } catch (error) {
        reject(error);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

// 只有连接控制可写归属记录；封存与业务写因共享 meta 而跨实例串行。
export async function freezeIndependentOwnership(
  db: IDBDatabase,
): Promise<IndependentOwnership> {
  return changeOwnership(db, (current) =>
    current.state === "frozen"
      ? current
      : {
          format: FORMAT,
          state: "frozen",
          generation: current.generation + 1,
          archiveId: crypto.randomUUID(),
          frozenAt: new Date().toISOString(),
        },
  );
}

// 明确断开才恢复；旧封存 token 不能解除后一次连接的封存。
export async function resumeIndependentOwnership(
  db: IDBDatabase,
  archiveId: string,
): Promise<IndependentOwnership> {
  if (!UUID.test(archiveId || "")) throw new Error("封存标识无效");
  return changeOwnership(db, (current) => {
    if (current.state === "independent") return current;
    if (current.archiveId !== archiveId)
      throw new Error("封存标识已变化，不能恢复另一份连接的独立资料");
    return {
      format: FORMAT,
      state: "independent",
      generation: current.generation + 1,
      archiveId: null,
      frozenAt: null,
    };
  });
}

function changeOwnership(
  db: IDBDatabase,
  change: (current: IndependentOwnership) => IndependentOwnership,
): Promise<IndependentOwnership> {
  return new Promise((resolve, reject) => {
    // 控制事务故意不走业务写保护，否则冻结之后无法执行显式恢复。
    const tx = db.transaction("meta", "readwrite"),
      meta = tx.objectStore("meta");
    const get = meta.get(INDEPENDENT_OWNERSHIP_KEY);
    let result: IndependentOwnership | undefined, failure: unknown;
    get.onsuccess = () => {
      try {
        const current = ownershipRecord(get.result);
        result = change(current);
        if (result !== current) meta.put(result, INDEPENDENT_OWNERSHIP_KEY);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () =>
      result ? resolve(result) : reject(new Error("资料归属未保存"));
    tx.onabort = tx.onerror = () =>
      reject(failure || tx.error || new Error("资料归属修改失败，原资料未修改"));
  });
}
