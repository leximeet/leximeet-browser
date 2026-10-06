import { splitSentences, tokenize } from "../lib/pure.ts";
import type { Occurrence } from "../lib/types.ts";

export type LocatedOccurrence = Occurrence & { range: Range };
type TextPart = { node: Text; start: number; end: number };
type Block = { text: string; parts: TextPart[] };
const excluded =
  'script,style,noscript,textarea,input,select,button,code,pre,svg,canvas,iframe,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[aria-hidden="true"],leximeet-page-ui';
const blockSelector =
  "p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,article,section,div";

// 正文节点只读。按块建立 UTF-16 偏移映射，允许单词跨越正文内的 em/span。
export function readDocument(document: Document) {
  const groups = new Map<Element, Block>();
  let visited = 0,
    characters = 0,
    partial = false;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      // 纯空白 Text 仍决定单词边界和原句偏移。去掉 span 间的空格会把
      // Resilient SYSTEM 拼成一个 token，再被真实 Range 校验整项丢弃。
      if (!parent || parent.closest(excluded) || !node.textContent?.length)
        return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(parent);
      return style.display === "none" || style.visibility === "hidden"
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (++visited > 20000 || characters + node.length > 250000) {
      partial = true;
      break;
    }
    const parent = node.parentElement!;
    const block = parent.closest(blockSelector) || parent;
    let group = groups.get(block);
    if (!group) {
      group = { text: "", parts: [] };
      groups.set(block, group);
    }
    const start = group.text.length;
    group.text += node.data;
    characters += node.length;
    group.parts.push({ node, start, end: group.text.length });
  }
  const occurrences: LocatedOccurrence[] = [];
  let tokens = 0;
  outer: for (const group of groups.values())
    for (const sentence of splitSentences(group.text))
      for (const token of tokenize(sentence.text)) {
        if (++tokens > 10000) {
          partial = true;
          break outer;
        }
        const start = sentence.start + token.start,
          end = start + token.surface.length;
        const first = group.parts.find((p) => p.end > start),
          last = group.parts.find((p) => p.end >= end);
        if (!first || !last || sentence.text.length > 4000) continue;
        const range = document.createRange();
        range.setStart(first.node, start - first.start);
        range.setEnd(last.node, end - last.start);
        if (range.toString() !== token.surface || !range.getClientRects().length)
          continue;
        occurrences.push({
          id: crypto.randomUUID(),
          surface: token.surface,
          normalized: token.normalized,
          start: token.start,
          end: token.start + token.surface.length,
          sentence: sentence.text,
          sentenceStart: sentence.start,
          range,
        });
      }
  return { occurrences, partial, visited, characters };
}

// 不依赖站点 class；遮挡检测防止点穿固定导航、对话框和其它扩展。
export function occurrenceAt(occurrences: LocatedOccurrence[], x: number, y: number) {
  for (const occurrence of occurrences) {
    if (!occurrence.range.startContainer.isConnected) continue;
    for (const rect of occurrence.range.getClientRects())
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        const top = document.elementFromPoint(x, y);
        const parent = occurrence.range.startContainer.parentElement;
        if (top && parent && (top.contains(parent) || parent.contains(top)))
          return occurrence;
      }
  }
  return undefined;
}

// 点击时只读鼠标下的正文块；采集入口不遍历全文，也不查询候选词。
export function wordAtPoint(
  document: Document,
  x: number,
  y: number,
): LocatedOccurrence | undefined {
  const top = document.elementFromPoint(x, y);
  if (!top || top.closest(excluded)) return;
  const caret = document.caretRangeFromPoint(x, y);
  if (!caret || caret.startContainer.nodeType !== Node.TEXT_NODE) return;
  const node = caret.startContainer as Text,
    parent = node.parentElement;
  if (
    !parent ||
    parent.closest(excluded) ||
    !(top.contains(parent) || parent.contains(top))
  )
    return;
  const root =
    parent.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption") || parent;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const el = n.parentElement;
      if (!el || el.closest(excluded)) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(el);
      return style.display === "none" || style.visibility === "hidden"
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "",
    count = 0,
    focus = -1;
  let parts: (TextPart & { offset: number })[] = [];
  while (walker.nextNode()) {
    const n = walker.currentNode as Text;
    // 超大段落退回指针所在节点的有界上下文，不能为一个点击扫描整篇文章。
    if (++count > 256 || text.length + n.length > 16000) {
      focus = -1;
      break;
    }
    if (n === node) focus = text.length + caret.startOffset;
    parts.push({
      node: n,
      start: text.length,
      end: text.length + n.length,
      offset: 0,
    });
    text += n.data;
  }
  if (focus < 0) {
    const start = Math.max(0, caret.startOffset - 1900),
      end = Math.min(node.length, caret.startOffset + 1900);
    text = node.data.slice(start, end);
    parts = [{ node, start: 0, end: text.length, offset: start }];
    focus = caret.startOffset - start;
  }
  const token = tokenize(text).find((t) => focus >= t.start && focus <= t.end);
  if (!token || token.surface.length > 100) return;
  const first = parts.find((p) => p.end > token.start),
    last = parts.find((p) => p.end >= token.end);
  if (!first || !last) return;
  const range = document.createRange();
  range.setStart(first.node, token.start - first.start + first.offset);
  range.setEnd(last.node, token.end - last.start + last.offset);
  if (
    range.toString() !== token.surface ||
    ![...range.getClientRects()].some(
      (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
    )
  )
    return;
  const sentence = splitSentences(text).find(
    (s) => s.start <= token.start && s.end >= token.end,
  );
  if (!sentence || sentence.text.length > 4000) return;
  return {
    id: crypto.randomUUID(),
    surface: token.surface,
    normalized: token.normalized,
    start: token.start - sentence.start,
    end: token.end - sentence.start,
    sentence: sentence.text,
    sentenceStart: sentence.start,
    range,
  };
}

// 同一处重复点击复用身份；相同词在不同原句的位置仍是不同语境。
export function sameOccurrence(a: LocatedOccurrence, b: LocatedOccurrence) {
  return (
    a.surface === b.surface &&
    a.range.startContainer === b.range.startContainer &&
    a.range.endContainer === b.range.endContainer &&
    a.range.startOffset === b.range.startOffset &&
    a.range.endOffset === b.range.endOffset
  );
}
