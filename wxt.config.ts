import { defineConfig } from "wxt";
// 发现仅探测受信宿主；通知与任一端的发起都必须经过浏览器用户确认后才配对。
export default defineConfig({
  modules: ["@wxt-dev/module-vue"],
  manifest: {
    name: "词遇-LexiMeet",
    description: "在阅读中遇见自己的目标，保存语境并安排学习与练习。",
    permissions: [
      "activeTab",
      "scripting",
      "storage",
      "sidePanel",
      "nativeMessaging",
      "notifications",
      "alarms",
    ],
    // 默认在普通网页显示入口；仅用户主动遇见/采词时读取正文。
    host_permissions: ["http://*/*", "https://*/*"],
    action: {
      default_title: "打开词遇侧栏",
      // 工具栏按实际像素密度选择，避免把 32px 图标放大用于所有入口。
      default_icon: {
        16: "/assets/brand/icon-16.png",
        24: "/assets/brand/icon-24.png",
        32: "/assets/brand/icon-32.png",
      },
    },
    icons: {
      16: "/assets/brand/icon-16.png",
      32: "/assets/brand/icon-32.png",
      48: "/assets/brand/icon-48.png",
      128: "/assets/brand/icon-128.png",
    },
    commands: {
      _execute_action: {
        suggested_key: { default: "Alt+Shift+L" },
        description: "打开词遇侧栏",
      },
    },
    minimum_chrome_version: "142",
    ...(process.env.WXT_EXTENSION_KEY ? { key: process.env.WXT_EXTENSION_KEY } : {}),
  },
});
