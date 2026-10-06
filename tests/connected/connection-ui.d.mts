import type { expect, Page } from "@playwright/test";
import type { ConnectedLabSession } from "../../scripts/launch-connected-lab.mjs";
import type { ConnectionView } from "../../lib/desktop-connection.ts";
import type { facts } from "../browser/ui-helpers.ts";
export type Facts = Awaited<ReturnType<typeof facts>>;
export type IndependentFacts = Pick<
  Facts,
  "words" | "encounters" | "reviews" | "practice" | "notebooks" | "plan"
>;
export interface DesktopWord {
  id: string;
  word: string;
  note: string;
}
export interface DesktopEncounter {
  id: string;
  word: string;
  context: string;
  sourceUrl: string;
}
export interface ConnectionUi {
  connection(page: Page): Promise<ConnectionView>;
  independentFacts(value: Facts): IndependentFacts;
  desktopQuery(
    lab: ConnectedLabSession,
    payload: { kind: "encounters" },
  ): Promise<{ total: number; encounters: DesktopEncounter[] }>;
  desktopQuery(
    lab: ConnectedLabSession,
    payload: Record<string, unknown>,
  ): Promise<{ words: DesktopWord[] }>;
  prepareDesktopSettings(lab: ConnectedLabSession): Promise<void>;
  discoveredNotification(lab: ConnectedLabSession): Promise<boolean>;
  invitationPopup(lab: ConnectedLabSession): Promise<Page>;
  requestInvitation(
    lab: ConnectedLabSession,
    requestedBy?: "desktop" | "plugin",
  ): Promise<void>;
  pairThroughUi(
    lab: ConnectedLabSession,
    requestedBy?: "desktop" | "plugin",
  ): Promise<void>;
  disconnectThroughUi(page: Page): Promise<void>;
}
export function createConnectionUi(assertions: typeof expect): ConnectionUi;
