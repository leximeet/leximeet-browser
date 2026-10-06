import test from "node:test";
import assert from "node:assert/strict";
import { labProxy } from "../scripts/lab-network.mjs";
test("隔离代理采用显式地址优先，回环页不走代理，direct 可关闭探测", async () => {
  const probe = async () => {
    throw new Error("不该探测");
  };
  assert.equal(
    await labProxy(
      { LEXIMEET_LAB_PROXY: "direct", https_proxy: "http://127.0.0.1:7897" },
      probe,
    ),
    undefined,
  );
  assert.deepEqual(
    await labProxy(
      {
        LEXIMEET_LAB_PROXY: "http://127.0.0.1:12334",
        HTTPS_PROXY: "http://127.0.0.1:7897",
      },
      probe,
    ),
    { server: "http://127.0.0.1:12334", bypass: "localhost,127.0.0.1,[::1]" },
  );
  assert.equal(
    (await labProxy({ all_proxy: "socks5://127.0.0.1:7897" }, probe))?.server,
    "socks5://127.0.0.1:7897",
  );
});
test("没有显式代理时只探测两个约定的本机端口，无监听时直连", async () => {
  const calls: number[] = [];
  const result = await labProxy({}, async (port) => {
    calls.push(port);
    return port === 12334;
  });
  assert.deepEqual(calls, [7897, 12334]);
  assert.equal(result?.server, "http://127.0.0.1:12334");
  assert.equal(await labProxy({}, async () => false), undefined);
});
test("不在 Chromium 参数或日志中传入代理凭据", async () => {
  await assert.rejects(
    labProxy({ LEXIMEET_LAB_PROXY: "http://user:secret@127.0.0.1:7897" }),
    /不带凭据/,
  );
  await assert.rejects(
    labProxy({ LEXIMEET_LAB_PROXY: "file:///private/tmp/proxy" }),
    /不带凭据/,
  );
});
