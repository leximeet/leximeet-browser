import type { LocalLibrary } from "./local-database.ts";
import type { LexiconProvider } from "./lexicon.ts";

// 个人资料仓库只暴露业务操作；替换实现不能改变词库和事实的稳定身份。
export type PersonalLibraryRepository = Pick<
  LocalLibrary,
  | "learning"
  | "workspaceMeta"
  | "saveWorkspaceMeta"
  | "book"
  | "settings"
  | "updateSettings"
  | "listWords"
  | "word"
  | "byNormalized"
  | "listNotebooks"
  | "createNotebook"
  | "updateNotebook"
  | "setWordNotebooks"
  | "plan"
  | "savePlan"
  | "capturePolicy"
  | "updateCapturePolicy"
  | "capture"
  | "addWord"
  | "editWord"
  | "updatePersonalWords"
  | "setDeleted"
  | "encounters"
  | "reviews"
  | "addReview"
  | "undoReview"
  | "addPractice"
  | "practice"
>;

// UI 可读取的账号身份。令牌、刷新凭据和认证响应只能留在可信适配器内部。
export type AccountState =
  | { status: "unavailable"; reason: string }
  | { status: "signed-out" }
  | { status: "signed-in"; account: { id: string; displayName: string } };

export interface AccountProvider {
  state(): Promise<AccountState>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

// connected 只能由将来完成授权和首轮事实确认的 Desktop 适配器报告。
export type DesktopState =
  | { status: "unavailable"; reason: string }
  | { status: "disconnected" }
  | { status: "connecting" }
  | {
      status: "connected";
      desktopInstanceId: string;
      protocolVersion: string;
      confirmedBookUid: string;
    };

export interface DesktopProvider {
  state(): Promise<DesktopState>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export type IntegrationStatus = {
  account: AccountState;
  desktop: DesktopState;
};

export class FeatureUnavailableError extends Error {
  readonly feature: "account" | "desktop";
  constructor(feature: "account" | "desktop", message: string) {
    super(message);
    this.name = "FeatureUnavailableError";
    this.feature = feature;
  }
}

const ACCOUNT_REASON = "账号登录将在后续版本提供；当前资料仍保存在本机。";
const DESKTOP_REASON = "Desktop 连接将在后续版本提供；当前可独立学习和保存。";

// 独立模式的默认适配器无网络、Native Host、计时器或自动连接副作用。
export class UnavailableAccountProvider implements AccountProvider {
  async state(): Promise<AccountState> {
    return { status: "unavailable", reason: ACCOUNT_REASON };
  }
  async signIn(): Promise<void> {
    throw new FeatureUnavailableError("account", ACCOUNT_REASON);
  }
  async signOut(): Promise<void> {
    throw new FeatureUnavailableError("account", ACCOUNT_REASON);
  }
}

export class UnavailableDesktopProvider implements DesktopProvider {
  async state(): Promise<DesktopState> {
    return { status: "unavailable", reason: DESKTOP_REASON };
  }
  async connect(): Promise<void> {
    throw new FeatureUnavailableError("desktop", DESKTOP_REASON);
  }
  async disconnect(): Promise<void> {
    throw new FeatureUnavailableError("desktop", DESKTOP_REASON);
  }
}

// 主动挑选公开字段，避免将来认证 SDK 返回的额外令牌意外进入 UI 消息。
function accountProjection(state: AccountState): AccountState {
  if (state.status === "signed-in")
    return {
      status: state.status,
      account: { id: state.account.id, displayName: state.account.displayName },
    };
  if (state.status === "unavailable")
    return { status: state.status, reason: state.reason };
  return { status: "signed-out" };
}

function desktopProjection(state: DesktopState): DesktopState {
  if (state.status === "connected")
    return {
      status: state.status,
      desktopInstanceId: state.desktopInstanceId,
      protocolVersion: state.protocolVersion,
      confirmedBookUid: state.confirmedBookUid,
    };
  if (state.status === "unavailable")
    return { status: state.status, reason: state.reason };
  return { status: state.status };
}

export interface ApplicationServices {
  readonly library: PersonalLibraryRepository;
  readonly lexicon: LexiconProvider;
  readonly account: AccountProvider;
  readonly desktop: DesktopProvider;
  integrationStatus(): Promise<IntegrationStatus>;
}

/**
 * 可信后台的组装入口。登录、Desktop 与离线词典/个人资料分别注入；
 * 注入账号或 Desktop 不会替换 IndexedDB，也不会使离线写入等待远端。
 * 未来适配器自行处理凭据及协议，不复用旧单向 LMCP 作为双向同步。
 */
export function createApplicationServices(options: {
  library: PersonalLibraryRepository;
  lexicon: LexiconProvider;
  account?: AccountProvider;
  desktop?: DesktopProvider;
}): ApplicationServices {
  const account = options.account ?? new UnavailableAccountProvider();
  const desktop = options.desktop ?? new UnavailableDesktopProvider();
  return Object.freeze({
    library: options.library,
    lexicon: options.lexicon,
    account,
    desktop,
    async integrationStatus() {
      // 将来远端状态读取失败也不能阻断本机操作；错误响应可能含凭据，不能原样投影。
      const [accountState, desktopState] = await Promise.all([
        Promise.resolve()
          .then(() => account.state())
          .catch(
            (): AccountState => ({
              status: "unavailable",
              reason: "暂时无法读取账号状态，离线资料仍可使用。",
            }),
          ),
        Promise.resolve()
          .then(() => desktop.state())
          .catch(
            (): DesktopState => ({
              status: "unavailable",
              reason: "暂时无法读取 Desktop 状态，浏览器仍独立使用。",
            }),
          ),
      ]);
      return {
        account: accountProjection(accountState),
        desktop: desktopProjection(desktopState),
      };
    },
  });
}
