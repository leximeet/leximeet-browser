// Source 与随包链路使用同一套真实 UI 操作；expect 由各自运行器注入。
export function createConnectionUi(expect) {
  async function connection(page) {
    return page.evaluate(async () => {
      const response = await globalThis.chrome.runtime.sendMessage({
        channel: "leximeet",
        action: "connection-state",
        data: {},
      });
      if (!response?.ok) throw new Error(response?.error || "无法读取连接状态");
      return response.result;
    });
  }
  function independentFacts(value) {
    // 只核对学习事实；连接控制库和 UI 草稿不是个人业务资料。
    return {
      words: value.words,
      encounters: value.encounters,
      reviews: value.reviews,
      practice: value.practice,
      notebooks: value.notebooks,
      plan: value.plan,
    };
  }
  async function desktopQuery(lab, payload) {
    return lab.desktopPage.evaluate(
      (data) => globalThis.leximeet.desktopQuery(data),
      payload,
    );
  }
  async function prepareDesktopSettings(lab) {
    const page = lab.desktopPage;
    const welcome = page.getByRole("dialog", { name: "欢迎使用词遇" });
    if (await welcome.count())
      await welcome.getByRole("button", { name: "跳过教学", exact: true }).click();
    await page.locator('[data-guide="nav-settings"]').click();
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "插件连接", exact: true })
      .click();
    await expect(page.getByRole("region", { name: "插件连接设置" })).toBeVisible();
  }
  // 只读取真实 Chrome 通知；系统横幅是否可见仍需人工验收。
  async function discoveredNotification(lab) {
    return lab.workspace.evaluate(async () => {
      const notifications = await globalThis.chrome.notifications.getAll();
      return Object.prototype.hasOwnProperty.call(
        notifications,
        "leximeet-desktop-available",
      );
    });
  }
  async function waitForDiscoveryNotification(lab) {
    if (lab.evidence.actualDiscoveryNotification) return;
    // Browser 单独记录首次启动；Desktop 随包驱动仍兼容原有 evidence，不重置其预算。
    const startedAt = lab.evidence.discoveryStartedAt ?? lab.evidence.startedAt;
    const deadline = Date.parse(startedAt) + 60_000;
    const remaining = () => {
      const value = deadline - Date.now();
      if (!Number.isFinite(value) || value <= 0)
        throw new Error("启动发现的 60 秒截止已到");
      return value;
    };
    let observedAt;
    await expect
      .poll(
        async () => {
          remaining();
          const available = await discoveredNotification(lab);
          // 读取真实通知也占用原窗口；过期后返回的成功不能成为验收证据。
          const completedAt = Date.now();
          if (completedAt >= deadline) throw new Error("启动发现的 60 秒截止已到");
          if (available) observedAt = completedAt;
          return available;
        },
        { timeout: remaining() },
      )
      .toBe(true);
    lab.evidence.actualDiscoveryNotificationAt = new Date(observedAt).toISOString();
    lab.evidence.actualDiscoveryNotification = true;
  }
  async function invitationPopup(lab) {
    await expect
      .poll(() =>
        lab.context
          .pages()
          .some(
            (page) =>
              page.url() ===
              `chrome-extension://${lab.extensionId}/connection-confirmation.html`,
          ),
      )
      .toBe(true);
    const popup = lab.context
      .pages()
      .find(
        (page) =>
          page.url() ===
          `chrome-extension://${lab.extensionId}/connection-confirmation.html`,
      );
    await expect(
      popup.getByRole("dialog", { name: "连接桌面端", exact: true }),
    ).toBeVisible();
    // 这是产品 windows.create 出来的真正插件窗口，不在测试里伪造 Dialog。
    const windowType = await popup.evaluate(
      async () => (await globalThis.chrome.windows.getCurrent()).type,
    );
    expect(windowType).toBe("popup");
    return popup;
  }
  async function requestInvitation(lab, requestedBy = "desktop") {
    await prepareDesktopSettings(lab);
    const desktop = lab.desktopPage;
    await waitForDiscoveryNotification(lab);
    if (requestedBy === "desktop") {
      await expect(
        desktop.getByRole("button", { name: "一键连接", exact: true }),
      ).toBeVisible();
      await desktop.getByRole("button", { name: "一键连接", exact: true }).click();
      await expect(
        desktop.getByRole("status").filter({ hasText: "等待确认" }),
      ).toBeVisible();
    } else {
      await lab.workspace.goto(
        `chrome-extension://${lab.extensionId}/options.html#/settings`,
      );
      await lab.workspace
        .getByRole("button", { name: "连接桌面端", exact: true })
        .click();
    }
  }
  async function pairThroughUi(lab, requestedBy = "desktop") {
    await requestInvitation(lab, requestedBy);
    const desktop = lab.desktopPage;
    const popup = await invitationPopup(lab);
    const confirm = popup.getByRole("dialog", {
      name: "连接桌面端",
      exact: true,
    });
    await confirm.getByRole("button", { name: "确认连接", exact: true }).click();
    await expect(confirm).toContainText("已连接桌面端");
    await expect
      .poll(() => connection(lab.workspace))
      .toMatchObject({ mode: "desktop", status: "connected" });
    await expect(
      lab.workspace.locator('main[data-workspace-mode="desktop"]'),
    ).toHaveAttribute("data-desktop-state", "connected");
    await expect(desktop.locator(".connection-device .connection-online")).toHaveText(
      "连接成功",
    );
    await confirm.getByRole("button", { name: "关闭窗口", exact: true }).click();
    const view = await connection(lab.workspace);
    for (const key of ["credential", "sessionToken", "pairingSecret", "invitationToken"])
      expect(view).not.toHaveProperty(key);
    lab.evidence.actualInvitation = {
      requestedBy,
      chromeNotificationCreated: true,
      actualPopupWindow: true,
      confirmedByUser: true,
      bothUiConnected: true,
    };
  }
  async function disconnectThroughUi(page) {
    // Desktop 发起连接时管理页保留当前路由；先进入真实设置，而不是假定已在设置页。
    await page
      .getByRole("navigation", { name: "管理导航" })
      .getByRole("button", { name: "设置", exact: true })
      .click();
    await page
      .getByRole("button", { name: "断开连接，恢复独立使用", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "断开桌面连接？",
      exact: true,
    });
    await expect(dialog).toContainText("不会复制到浏览器");
    await dialog.getByRole("button", { name: "断开并恢复独立使用", exact: true }).click();
  }

  return {
    connection,
    independentFacts,
    desktopQuery,
    prepareDesktopSettings,
    discoveredNotification,
    waitForDiscoveryNotification,
    invitationPopup,
    requestInvitation,
    pairThroughUi,
    disconnectThroughUi,
  };
}
