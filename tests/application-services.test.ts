import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { LocalLibrary } from "../lib/local-database.ts";
import type { LexiconProvider } from "../lib/lexicon.ts";
import {
  createApplicationServices,
  FeatureUnavailableError,
  type AccountProvider,
  type DesktopProvider,
} from "../lib/application-services.ts";

// 此处验证依赖组装和公开字段合同，不能冒充真实登录或 Desktop 联调。
const lexicon: LexiconProvider = {
  resolveHeadword: async () => null,
  async lookup() {
    return null;
  },
  async lookupAll() {
    return [];
  },
  async suggest() {
    return [];
  },
  async listCatalogs() {
    return [];
  },
  async catalogMembers() {
    return [];
  },
};
const library = () => new LocalLibrary("leximeet-services-test-" + crypto.randomUUID());

test("默认账号和 Desktop 明确不可用，本机写入不等待连接", async () => {
  const store = library();
  const app = createApplicationServices({ library: store, lexicon });
  const status = await app.integrationStatus();
  assert.equal(status.account.status, "unavailable");
  assert.equal(status.desktop.status, "unavailable");
  for (const operation of [
    () => app.account.signIn(),
    () => app.account.signOut(),
    () => app.desktop.connect(),
    () => app.desktop.disconnect(),
  ])
    await assert.rejects(operation(), FeatureUnavailableError);
  const word = await app.library.addWord("resilient");
  assert.equal((await app.library.word(word.id))?.word, "resilient");
  assert.equal(app.library, store);
  assert.equal(app.lexicon, lexicon);
  assert.ok(Object.isFrozen(app));
});

test("后续适配器只在显式使用时执行，退出账号不清空个人事实", async () => {
  const store = library();
  const word = await store.addWord("attention");
  const identity = await store.book();
  let signedIn = false;
  let operations = 0;
  const account: AccountProvider = {
    async state() {
      return signedIn
        ? {
            status: "signed-in",
            account: { id: "account-a", displayName: "学习者" },
          }
        : { status: "signed-out" };
    },
    async signIn() {
      signedIn = true;
      operations++;
    },
    async signOut() {
      signedIn = false;
      operations++;
    },
  };
  const app = createApplicationServices({ library: store, lexicon, account });
  assert.equal(operations, 0);
  await app.account.signIn();
  assert.equal((await app.integrationStatus()).account.status, "signed-in");
  await app.account.signOut();
  assert.equal((await app.integrationStatus()).account.status, "signed-out");
  assert.equal(operations, 2);
  assert.equal((await app.library.book()).bookUid, identity.bookUid);
  assert.equal((await app.library.word(word.id))?.id, word.id);
});

test("公开状态按白名单投影，认证和 Native 额外凭据不进入消息或备份", async () => {
  const store = library();
  const bookUid = (await store.book()).bookUid;
  const account: AccountProvider = {
    async state() {
      return {
        status: "signed-in",
        account: {
          id: "a",
          displayName: "学习者",
          refreshToken: "private-refresh",
        },
        accessToken: "private-access",
      };
    },
    async signIn() {},
    async signOut() {},
  };
  const desktop: DesktopProvider = {
    async state() {
      return {
        status: "connected",
        desktopInstanceId: "d",
        protocolVersion: "future/1",
        confirmedBookUid: bookUid,
        pairingSecret: "private-pairing",
      };
    },
    async connect() {},
    async disconnect() {},
  };
  const app = createApplicationServices({
    library: store,
    lexicon,
    account,
    desktop,
  });
  assert.deepEqual(await app.integrationStatus(), {
    account: {
      status: "signed-in",
      account: { id: "a", displayName: "学习者" },
    },
    desktop: {
      status: "connected",
      desktopInstanceId: "d",
      protocolVersion: "future/1",
      confirmedBookUid: bookUid,
    },
  });
  assert.equal(
    JSON.stringify({
      book: await app.library.book(),
      words: await app.library.listWords(),
      settings: await app.library.settings(),
    }).includes("private-"),
    false,
  );
});

test("远端异步和同步状态失败均不泄露错误详情或破坏离线操作", async () => {
  const store = library();
  const fail = async (): Promise<never> => {
    throw new Error("response token=private-credential");
  };
  const syncFail = (): Promise<never> => {
    throw new Error("response token=private-credential");
  };
  const app = createApplicationServices({
    library: store,
    lexicon,
    account: { state: fail, signIn: fail, signOut: fail },
    desktop: { state: syncFail, connect: fail, disconnect: fail },
  });
  const status = await app.integrationStatus();
  assert.equal(status.account.status, "unavailable");
  assert.equal(status.desktop.status, "unavailable");
  assert.equal(JSON.stringify(status).includes("private-credential"), false);
  const word = await app.library.addWord("offline");
  assert.equal((await app.library.word(word.id))?.word, "offline");
});
