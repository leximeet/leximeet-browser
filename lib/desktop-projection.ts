type Projection = { ticket: string; revision: string; until: number };
type ReadContext = { revision: string; readLeaseUntil: string } | null;

/**
 * 已知工作区快照可能比刚返回的 matchWords 更早，例如本端采集之后、下次心跳之前。
 * 只有快照修订更高才能证明投影陈旧；不能把较新的真实读取当成过期结果撤下。
 * 修订按协议使用十进制单调计数，并以 BigInt 比较，不修改完整快照的版本或元数据。
 */
export function desktopProjectionExpired(
  projection: Projection,
  ticket: string,
  context: ReadContext,
  now = Date.now(),
): boolean {
  if (
    projection.ticket !== ticket ||
    !context ||
    !Number.isFinite(projection.until) ||
    projection.until <= now ||
    !Number.isFinite(Date.parse(context.readLeaseUntil)) ||
    Date.parse(context.readLeaseUntil) <= now
  )
    return true;
  // 无法按当前合同比较的修订不能继续投影，亦不能靠 Number 猜测精度。
  const decimal = /^(0|[1-9]\d*)$/;
  if (!decimal.test(context.revision) || !decimal.test(projection.revision)) return true;
  return BigInt(context.revision) > BigInt(projection.revision);
}
