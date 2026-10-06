import { learningDay } from "./learning.ts";
import { validAudioTemplate } from "./pronunciation.ts";
import type { CatalogMember } from "./lexicon.ts";
import type { UserWord } from "./local-model.ts";
export type LibraryItem = CatalogMember & {
  key: string;
  personal: UserWord | null;
  inTarget: boolean;
  collected: boolean;
  encounterCount: number;
  dueAt: string | null;
  status: "new" | "learning" | "due" | "review" | "mastered";
  scheduled?: boolean;
  familiarity?: import("./learning.ts").LearningProjection;
};
export type PronunciationSettings = {
  provider: "youdao" | "custom";
  accent: "us" | "uk";
  rate: number;
  customUrl: string;
};
export const CARD_FIELDS = [
  "pronunciations",
  "senses",
  "explanations",
  "usage",
  "examples",
  "contexts",
  "forms",
  "memory",
  "articles",
  "lexical",
  "collections",
  "personal",
  "sources",
  "raw",
] as const;
export type CardField = (typeof CARD_FIELDS)[number];
export type WorkspacePreferences = {
  schema: "leximeet.workspace/1";
  card: {
    level: "minimal" | "moderate" | "detailed" | "complete" | "custom";
    sections: CardField[];
  };
  pronunciation: PronunciationSettings;
  practice: {
    repeat: number;
    ignoreCase: boolean;
    autoNext: boolean;
    autoPronounce: boolean;
    soundFeedback: boolean;
    hideWord: boolean;
    hideMeaning: boolean;
    hideSentence: boolean;
  };
  insights: string[];
  onboarding: { stage: number; complete: boolean };
};
export const defaultWorkspacePreferences = (): WorkspacePreferences => ({
  schema: "leximeet.workspace/1",
  card: {
    level: "moderate",
    sections: ["pronunciations", "senses", "examples", "contexts", "personal"],
  },
  pronunciation: { provider: "youdao", accent: "us", rate: 1, customUrl: "" },
  practice: {
    repeat: 1,
    ignoreCase: true,
    autoNext: true,
    autoPronounce: true,
    soundFeedback: true,
    hideWord: false,
    hideMeaning: false,
    hideSentence: false,
  },
  insights: ["learned", "encounters", "practice", "accuracy"],
  onboarding: { stage: 0, complete: false },
});
export function validWorkspacePreferences(value: unknown): value is WorkspacePreferences {
  const x = value as WorkspacePreferences;
  return (
    !!x &&
    Object.keys(x).every((k) =>
      ["schema", "card", "pronunciation", "practice", "insights", "onboarding"].includes(
        k,
      ),
    ) &&
    x.schema === "leximeet.workspace/1" &&
    !!x.card &&
    Object.keys(x.card).every((k) => ["level", "sections"].includes(k)) &&
    ["minimal", "moderate", "detailed", "complete", "custom"].includes(x.card.level) &&
    Array.isArray(x.card.sections) &&
    x.card.sections.every((s) => CARD_FIELDS.includes(s)) &&
    new Set(x.card.sections).size === x.card.sections.length &&
    !!x.pronunciation &&
    Object.keys(x.pronunciation).every((k) =>
      ["provider", "accent", "rate", "customUrl"].includes(k),
    ) &&
    ["youdao", "custom"].includes(x.pronunciation.provider) &&
    ["us", "uk"].includes(x.pronunciation.accent) &&
    [0.75, 1, 1.25].includes(x.pronunciation.rate) &&
    typeof x.pronunciation.customUrl === "string" &&
    x.pronunciation.customUrl.length <= 2000 &&
    validAudioTemplate(x.pronunciation.customUrl) &&
    !!x.practice &&
    Object.keys(x.practice).every((k) =>
      [
        "repeat",
        "ignoreCase",
        "autoNext",
        "autoPronounce",
        "soundFeedback",
        "hideWord",
        "hideMeaning",
        "hideSentence",
      ].includes(k),
    ) &&
    typeof x.practice.soundFeedback === "boolean" &&
    Number.isInteger(x.practice.repeat) &&
    x.practice.repeat >= 1 &&
    x.practice.repeat <= 10 &&
    [
      "ignoreCase",
      "autoNext",
      "autoPronounce",
      "hideWord",
      "hideMeaning",
      "hideSentence",
    ].every((k) => typeof x.practice[k as keyof typeof x.practice] === "boolean") &&
    Array.isArray(x.insights) &&
    x.insights.every((i) =>
      ["learned", "encounters", "practice", "accuracy", "library", "due"].includes(i),
    ) &&
    !!x.onboarding &&
    Object.keys(x.onboarding).every((k) => ["stage", "complete"].includes(k)) &&
    Number.isInteger(x.onboarding.stage) &&
    x.onboarding.stage >= 0 &&
    x.onboarding.stage <= 4 &&
    typeof x.onboarding.complete === "boolean"
  );
}
// 只读界面日期采用系统时区；规划传入固定时区，与学习规则共用自然日计算。
export function localDay(
  at = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
) {
  return learningDay(at, timeZone);
}
