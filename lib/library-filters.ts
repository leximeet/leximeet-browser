import type { CatalogMember } from "./lexicon.ts";

// 只用词典轻量成员的真实主词性；不根据词义猜词性，也不伪造重要等级。
export function primaryWordPos(member: Pick<CatalogMember, "pos"> | undefined): string {
  const raw = (member?.pos || "").trim().toLowerCase().replace(/\.$/, "");
  const aliases: Record<string, string> = {
    n: "noun",
    noun: "noun",
    name: "proper-noun",
    "proper noun": "proper-noun",
    v: "verb",
    vi: "verb",
    vt: "verb",
    verb: "verb",
    a: "adjective",
    adj: "adjective",
    adjective: "adjective",
    ad: "adverb",
    adv: "adverb",
    adverb: "adverb",
    prep: "preposition",
    preposition: "preposition",
    pron: "pronoun",
    pronoun: "pronoun",
    conj: "conjunction",
    conjunction: "conjunction",
    det: "determiner",
    determiner: "determiner",
    int: "interjection",
    interjection: "interjection",
    num: "numeral",
    numeral: "numeral",
    aux: "auxiliary",
    auxiliary: "auxiliary",
    article: "article",
    art: "article",
    part: "particle",
    particle: "particle",
  };
  return aliases[raw] || raw || "unknown";
}
export function wordPosLabel(pos: string): string {
  return (
    (
      {
        noun: "名词",
        "proper-noun": "专有名词",
        verb: "动词",
        adjective: "形容词",
        adverb: "副词",
        preposition: "介词",
        pronoun: "代词",
        conjunction: "连词",
        determiner: "限定词",
        interjection: "感叹词",
        numeral: "数词",
        auxiliary: "助动词",
        article: "冠词",
        particle: "小品词",
        unknown: "暂无词性资料",
      } as Record<string, string>
    )[pos] || pos
  );
}
