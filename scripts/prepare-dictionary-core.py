#!/usr/bin/env python3
"""历史 0.0.2 工具，当前 npm/CI 不调用；运行前注意会覆盖历史 core 资源目录。

把固定的 leximeet-dictionary core Release 转成浏览器按需读取的完整词包。

输出只是同版词条与 Ogg 字节的分片索引，不删减义项，不改写音频。
源 Release 没有远端发布时，可使用相邻 dictionary 仓库本地已核验的 dist。
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import unicodedata
from collections import Counter, OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "dictionary-core.lock.json"
OUTPUT = ROOT / "public/dictionaries/core"
CHUNK_BYTES = 4 * 1024 * 1024
# 即使手动使用历史生成器，也不能重新引入第二个扩展安装清单。
MANIFEST_NAME = "dictionary-manifest.json"
GENERATOR_REVISION = 5


def digest(path: Path) -> tuple[int, str]:
    value = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
            size += len(chunk)
    return size, value.hexdigest()


def key(word: str) -> str:
    return unicodedata.normalize("NFC", word).casefold()


def shard_key(value: str) -> str:
    letters = "".join(char if "a" <= char <= "z" else "_" for char in value[:2])
    return letters.ljust(2, "_")


def concise_gloss(senses: list[dict]) -> str:
    """词书列表和练习只用核心短释义；专业目录再选命中的义项。"""
    ordered = sorted(senses, key=lambda sense: sense["display_order"])
    chosen = [sense for sense in ordered if sense.get("priority") == "core"] or ordered
    glosses = list(dict.fromkeys(sense.get("short_gloss") for sense in chosen if sense.get("short_gloss")))
    return "；".join(glosses[:2])


class RawShards:
    """有限打开文件数的临时 JSONL 分片；最终逐片压缩并核对。"""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True)
        self.handles: OrderedDict[str, object] = OrderedDict()
        self.counts: Counter[str] = Counter()

    def append(self, name: str, line: str) -> None:
        handle = self.handles.pop(name, None)
        if handle is None:
            if len(self.handles) >= 48:
                _, old = self.handles.popitem(last=False)
                old.close()
            handle = (self.root / f"{name}.jsonl").open("a", encoding="utf-8")
        handle.write(line.rstrip("\n") + "\n")
        self.handles[name] = handle
        self.counts[name] += 1

    def finish(self, target: Path) -> dict:
        for handle in self.handles.values():
            handle.close()
        target.mkdir(parents=True)
        shards = {}
        for name in sorted(self.counts):
            raw = self.root / f"{name}.jsonl"
            destination = target / f"{name}.jsonl.gz"
            with raw.open("rb") as source, destination.open("wb") as output:
                with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0,
                                   compresslevel=6) as compressed:
                    shutil.copyfileobj(source, compressed, 1024 * 1024)
            size, sha = digest(destination)
            shards[name] = {"file": destination.relative_to(target.parent).as_posix(),
                            "entries": self.counts[name], "bytes": size, "sha256": sha}
        shutil.rmtree(self.root)
        return shards


def safe_asset(root: Path, name: str) -> Path:
    if not name or Path(name).name != name or "\\" in name:
        raise ValueError(f"Release 含无效资产路径：{name}")
    path = root / name
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Release 资产逃出来源目录：{name}")
    return path


def verify_release(root: Path, lock: dict) -> dict:
    release_file = safe_asset(root, "release.json")
    if digest(release_file)[1] != lock["releaseSha256"]:
        raise ValueError("本地 release.json 与 Browser 锁定版本不符")
    release = json.loads(release_file.read_text(encoding="utf-8"))
    edition = release["editions"]["core"]
    if (release["schema_version"] != "leximeet.release.v2" or
            release["entry_schema"] != "leximeet.entry.v2" or
            release["learning_schema"] != "leximeet.learning.v2" or
            release["dictionary_version"] != lock["dictionaryVersion"] or
            edition["entry_count"] != lock["entryCount"] or
            edition["audio_covered_entry_count"] != lock["audioCount"]):
        raise ValueError("核心版合同、版本或覆盖数与锁不符")
    for name in edition["assets"]:
        expected = release["assets"][name]
        if digest(safe_asset(root, name)) != (expected["bytes"], expected["sha256"]):
            raise ValueError(f"核心版源资产校验失败：{name}")
    return release


def generated_files(manifest: dict) -> list[dict]:
    records = []
    for section in ("entries", "forms", "audioIndex", "catalogMembers"):
        records.extend(manifest[section].values())
    records.append(manifest["catalogIndex"])
    records.extend(manifest["audioChunks"])
    records.extend(manifest["notices"])
    return records


def existing_is_valid(output: Path, release_hash: str) -> bool:
    try:
        manifest = json.loads((output / MANIFEST_NAME).read_text(encoding="utf-8"))
        if (manifest["schema"] != "leximeet.browser-core.v2" or
                manifest.get("generatorRevision") != GENERATOR_REVISION or
                (output / "manifest.json").exists() or
                manifest["sourceReleaseSha256"] != release_hash):
            return False
        return all(digest(output / item["file"]) == (item["bytes"], item["sha256"])
                   for item in generated_files(manifest))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def build(source: Path, output: Path) -> dict:
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    release = verify_release(source, lock)
    if output.exists() and existing_is_valid(output, lock["releaseSha256"]):
        print(f"核心词包已核验，可复用：{output}")
        return json.loads((output / MANIFEST_NAME).read_text(encoding="utf-8"))
    # 兼容旧生成目录并整体替换，旧 manifest.json 不复制到新产物。
    if output.exists() and not any((output / name).is_file()
                                   for name in (MANIFEST_NAME, "manifest.json")):
        raise ValueError("目标目录不是 Browser 生成的核心词包，拒绝覆盖")
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".core-stage-", dir=output.parent))
    try:
        edition = release["editions"]["core"]
        entries = RawShards(stage / "_entries")
        forms = RawShards(stage / "_forms")
        audio_index = RawShards(stage / "_audio_index")
        entry_ids = set()
        entry_heads = {}
        overrides = {}
        with gzip.open(source / edition["entries"], "rt", encoding="utf-8") as stream:
            for line in stream:
                entry = json.loads(line)
                word = entry["headword"]
                if (entry["schema_version"] != release["entry_schema"] or
                        entry["lookup_key"] != key(word) or
                        entry["entry_id"] in entry_ids):
                    raise ValueError(f"核心词条损坏或重复：{word}")
                entry_ids.add(entry["entry_id"])
                sense_glosses = [(sense["sense_id"], sense.get("short_gloss") or "")
                                 for sense in entry["senses"]]
                summary = (entry.get("editorial") or {}).get("display_zh") or concise_gloss(entry["senses"]) or \
                    entry.get("headword_summary_zh") or entry["ecdict"].get("zh_fallback") or ""
                entry_heads[entry["entry_id"]] = (word, summary, sense_glosses)
                entries.append(shard_key(entry["lookup_key"]), line)
                unique_forms = set()
                for form in entry["forms"]:
                    form_word = form["text"]
                    form_key = key(form_word)
                    record = (form_key, form_word, entry["lookup_key"], word, entry["entry_id"])
                    if record not in unique_forms:
                        forms.append(shard_key(form_key), json.dumps(record, ensure_ascii=False,
                                                                     separators=(",", ":")))
                        unique_forms.add(record)
                    for char in form_word:
                        if char.casefold() != char.lower():
                            overrides[char] = char.casefold()
                for char in word:
                    if char.casefold() != char.lower():
                        overrides[char] = char.casefold()
        if len(entry_ids) != edition["entry_count"]:
            raise ValueError("核心词条数量与发布清单不符")
        audio_ids = set()
        pack = source / next(name for name in edition["assets"] if name.startswith("audio-core-") and name.endswith(".pack"))
        with pack.open("rb") as clips, gzip.open(source / edition["audio_index"], "rt", encoding="utf-8") as stream:
            for line in stream:
                record = json.loads(line)
                identity = record["entry_id"]
                if identity not in entry_ids or identity in audio_ids or record["format"] != "audio/ogg":
                    raise ValueError(f"音频索引缺失、重复或格式错误：{identity}")
                clips.seek(record["offset"])
                payload = clips.read(record["bytes"])
                if hashlib.sha256(payload).hexdigest() != record["sha256"]:
                    raise ValueError(f"音频片段校验失败：{identity}")
                audio_ids.add(identity)
                audio_index.append(identity.replace("-", "")[:2], line)
        if audio_ids != entry_ids:
            raise ValueError("核心词卡与离线音频未逐词对应")
        # 学习目录只读导出自 0.0.2 SQLite，保留官方词序、原词条 ID 和命中的义项 ID。
        learning = sqlite3.connect(f"file:{(source / edition['learning_db']).as_posix()}?mode=ro", uri=True)
        try:
            metadata = dict(learning.execute("select key,value from metadata"))
            if metadata.get("schema_version") != release["learning_schema"]:
                raise ValueError("学习目录版本与发布清单不符")
            catalog_index = []
            catalog_members = {}
            (stage / "catalogs").mkdir()
            catalog_rows = learning.execute(
                "select catalog_id,title_zh,category,source,method from catalogs order by rowid").fetchall()
            for ordinal, (catalog_id, title, category, origin, method) in enumerate(catalog_rows):
                if category not in ("exam", "subject"):
                    raise ValueError(f"学习目录分类无效：{catalog_id}")
                members = []
                for entry_id, rank, sense_json, match_method in learning.execute(
                        "select entry_id,position,sense_ids,match_method from members where catalog_id=? order by position", (catalog_id,)):
                    if entry_id not in entry_heads:
                        raise ValueError(f"学习目录引用不存在的词条：{catalog_id}/{entry_id}")
                    headword, general_meaning, sense_glosses = entry_heads[entry_id]
                    sense_ids = json.loads(sense_json)
                    selected_glosses = list(dict.fromkeys(gloss for sense_id, gloss in sense_glosses
                        if sense_id in sense_ids and gloss))
                    meaning = "；".join(selected_glosses[:2]) or general_meaning
                    members.append({"entryId": entry_id, "word": headword, "meaning": meaning,
                                    "position": rank, "senseIds": sense_ids,
                                    "matchMethod": match_method})
                name = f"catalogs/{ordinal:02d}.json.gz"
                destination = stage / name
                with destination.open("wb") as stream:
                    with gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0,
                                       compresslevel=6) as compressed:
                        compressed.write(json.dumps(members, ensure_ascii=False,
                                                    separators=(",", ":")).encode("utf-8"))
                size, sha = digest(destination)
                catalog_members[catalog_id] = {"file": name, "entries": len(members),
                                               "bytes": size, "sha256": sha}
                catalog_index.append({"id": catalog_id, "title": title, "category": category,
                                      "source": origin, "method": method, "count": len(members),
                                      "previewWords": [member["word"] for member in members[:3]]})
            if len(catalog_index) != lock["catalogCount"]:
                raise ValueError("学习目录数量与锁不符")
            index_path = stage / "catalogs/index.json"
            index_path.write_text(json.dumps(catalog_index, ensure_ascii=False,
                                             separators=(",", ":")) + "\n", encoding="utf-8")
            index_size, index_sha = digest(index_path)
            catalog_index_asset = {"file": "catalogs/index.json", "entries": len(catalog_index),
                                   "bytes": index_size, "sha256": index_sha}
        finally:
            learning.close()
        chunks = []
        (stage / "audio").mkdir()
        with pack.open("rb") as stream:
            while payload := stream.read(CHUNK_BYTES):
                name = f"audio/{len(chunks):04d}.bin"
                destination = stage / name
                destination.write_bytes(payload)
                chunks.append({"file": name, "bytes": len(payload),
                               "sha256": hashlib.sha256(payload).hexdigest()})
        notices = []
        for name in edition["assets"]:
            if name.startswith("notice-") or name in ("LICENSE", "DATA-LICENSE.md", "audio-tools.lock.json", "audio-sources.json"):
                shutil.copyfile(source / name, stage / name)
                size, sha = digest(stage / name)
                notices.append({"file": name, "bytes": size, "sha256": sha})
        manifest = {
            "schema": "leximeet.browser-core.v2",
            "generatorRevision": GENERATOR_REVISION,
            "dictionaryVersion": release["dictionary_version"],
            "entrySchema": release["entry_schema"],
            "sourceEdition": "core",
            "sourceReleaseSha256": lock["releaseSha256"],
            "sourceCommit": lock["sourceCommit"],
            "entryCount": len(entry_ids), "audioCount": len(audio_ids),
            "catalogCount": len(catalog_index),
            "catalogIndex": catalog_index_asset, "catalogMembers": catalog_members,
            "audioChunkBytes": CHUNK_BYTES,
            "sourcePackBytes": release["assets"][pack.name]["bytes"],
            "sourcePackSha256": release["assets"][pack.name]["sha256"],
            "casefoldOverrides": dict(sorted(overrides.items())),
            "entries": entries.finish(stage / "entries"),
            "forms": forms.finish(stage / "forms"),
            "audioIndex": audio_index.finish(stage / "audio-index"),
            "audioChunks": chunks, "notices": notices,
        }
        (stage / MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False,
                                                      sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        if output.exists():
            backup = output.with_name(output.name + ".previous")
            if backup.exists():
                raise ValueError("旧词包备份目录已存在，拒绝覆盖")
            os.replace(output, backup)
            try:
                os.replace(stage, output)
            except Exception:
                os.replace(backup, output)
                raise
            shutil.rmtree(backup)
        else:
            os.replace(stage, output)
        print(f"Browser 核心词包已生成：{len(entry_ids)} 词 / {len(audio_ids)} 音频 / {output}")
        return manifest
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, default=Path(os.environ.get("LEXIMEET_DICTIONARY_RELEASE_DIR",
        ROOT.parents[1] / "leximeet-dictionary/dist/v0.0.2")))
    parser.add_argument("--out", type=Path, default=OUTPUT)
    args = parser.parse_args()
    build(args.release.resolve(), args.out.resolve())


if __name__ == "__main__":
    main()
