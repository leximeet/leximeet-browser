import type { test, expect, TestInfo } from "@playwright/test";
import type { ConnectedLabSession } from "../../scripts/launch-connected-lab.mjs";
import type { WordRef, EncounterRecord } from "../../lib/connector/types.ts";
import type { facts } from "../browser/ui-helpers.ts";
import type { ConnectionUi } from "./connection-ui.mjs";
export interface CaptureRow {
  eventId: string;
  word: string;
  note: string;
  sourceUrl: string;
  originalSentence: string;
  sourceKind: "web";
  wordRef: WordRef;
  eventEntity: EncounterRecord["data"];
}
export interface CaptureScenarioHelpers extends ConnectionUi {
  withLab(
    info: TestInfo,
    run: (lab: ConnectedLabSession) => Promise<void>,
  ): Promise<void>;
  facts: typeof facts;
}
export function captureRows(lab: ConnectedLabSession): CaptureRow[];
export function registerCaptureScenarios(
  runner: typeof test,
  assertions: typeof expect,
  helpers: CaptureScenarioHelpers,
): void;
