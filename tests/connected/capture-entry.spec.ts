import { test, expect } from "@playwright/test";
import { facts } from "../browser/ui-helpers.ts";
import { registerCaptureScenarios } from "./capture-scenarios.mjs";
import * as helpers from "./helpers.ts";

// 单独产品入口回归与原三场共用真实 Native 驱动；不创建假 Desktop。
registerCaptureScenarios(test, expect, { ...helpers, facts });
