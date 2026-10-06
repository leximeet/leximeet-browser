import test from "node:test";
import assert from "node:assert/strict";
import { desktopProjectionExpired } from "../lib/desktop-projection.ts";

const now = Date.UTC(2026, 9, 3);
const projection = {
  ticket: "same-owner",
  revision: "10",
  until: now + 10_000,
};
const context = {
  revision: "9",
  readLeaseUntil: new Date(now + 20_000).toISOString(),
};

test("采集后最新匹配保留，较旧完整快照不能撤销新投影，更新快照才撤旧投影", () => {
  assert.equal(
    desktopProjectionExpired(projection, projection.ticket, context, now),
    false,
  );
  assert.equal(
    desktopProjectionExpired(
      projection,
      projection.ticket,
      { ...context, revision: "10" },
      now,
    ),
    false,
  );
  assert.equal(
    desktopProjectionExpired(
      projection,
      projection.ticket,
      { ...context, revision: "11" },
      now,
    ),
    true,
  );
  assert.equal(context.revision, "9");
});

test("超过 Number 安全整数的相邻修订仍精确比较，不覆盖完整快照", () => {
  const newer = { ...projection, revision: "9007199254740993" };
  assert.equal(
    desktopProjectionExpired(
      newer,
      projection.ticket,
      { ...context, revision: "9007199254740992" },
      now,
    ),
    false,
  );
  assert.equal(
    desktopProjectionExpired(
      { ...newer, revision: "9007199254740992" },
      projection.ticket,
      { ...context, revision: newer.revision },
      now,
    ),
    true,
  );
});

test("归属、读取租期和投影截止各自失效，不因投影较新而继续读取", () => {
  assert.equal(
    desktopProjectionExpired(projection, "different-owner", context, now),
    true,
  );
  assert.equal(desktopProjectionExpired(projection, projection.ticket, null, now), true);
  assert.equal(
    desktopProjectionExpired(projection, projection.ticket, context, projection.until),
    true,
  );
  assert.equal(
    desktopProjectionExpired(
      projection,
      projection.ticket,
      { ...context, readLeaseUntil: new Date(now).toISOString() },
      now,
    ),
    true,
  );
  assert.equal(
    desktopProjectionExpired(
      projection,
      projection.ticket,
      { ...context, revision: "opaque" },
      now,
    ),
    true,
  );
});
