import { sameOccurrence, type LocatedOccurrence } from "./document.ts";

type Intent = { occurrence: LocatedOccurrence; eventId: string };

/**
 * wordAtPoint 每次命中都产生新的临时 UUID；待确认写入必须按真实 DOM 词位复用原意图。
 * 相同拼写或相同句子出现在别处仍是不同语境，不能仅按字符串合并。
 */
export class CaptureIntents {
  private pending: Intent[] = [];
  acquire(occurrence: LocatedOccurrence): Intent {
    const previous = this.pending.find(
      (item) =>
        sameOccurrence(item.occurrence, occurrence) &&
        item.occurrence.sentence === occurrence.sentence &&
        item.occurrence.start === occurrence.start,
    );
    if (previous) return previous;
    const intent = { occurrence, eventId: crypto.randomUUID() };
    this.pending.push(intent);
    return intent;
  }
  complete(intent: Intent) {
    this.pending = this.pending.filter((item) => item !== intent);
  }
  clear() {
    this.pending = [];
  }
}
