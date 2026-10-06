#!/usr/bin/env python3
"""核验两份商店 ZIP 与生产目录字节一致，仅生成发布证据，不上传或发布。"""
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import zipfile


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def directory_hashes(directory):
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError(f"生产目录缺失或为符号链接：{directory.name}")
    result = {}
    for current, directories, files in os.walk(directory):
        for name in directories + files:
            item = Path(current) / name
            if item.is_symlink():
                raise ValueError(f"生产目录不允许符号链接：{item.relative_to(directory)}")
        for name in files:
            item = Path(current) / name
            result[item.relative_to(directory).as_posix()] = sha256(item.read_bytes())
    return result


def inspect_package(root, browser, version):
    if browser not in ("chrome", "edge"):
        raise ValueError("只支持 chrome 与 edge 商店包")
    output = root / ".output"
    hashes = directory_hashes(output / f"{browser}-mv3")
    manifests = [name for name in hashes if Path(name).name.lower() == "manifest.json"]
    if manifests != ["manifest.json"]:
        raise ValueError(f"{browser} 生产目录必须只有根 manifest.json")
    filename = f"leximeet-browser-{version}-{browser}.zip"
    archive = output / filename
    with zipfile.ZipFile(archive) as package:
        members = package.infolist()
        names = [member.filename for member in members]
        if len(names) != len(set(names)):
            raise ValueError(f"{browser} ZIP 含重复路径")
        if set(names) != set(hashes):
            raise ValueError(f"{browser} ZIP 文件列表与生产目录不一致")
        for member in members:
            if member.is_dir() or stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError(f"{browser} ZIP 含无效文件类型：{member.filename}")
            # zipfile.read 同时核验解压后的 CRC；哈希另证明内容就是被测产物。
            if sha256(package.read(member)) != hashes[member.filename]:
                raise ValueError(f"{browser} ZIP 内容与生产目录不一致：{member.filename}")
    return {
        "file": filename,
        "sha256": sha256(archive.read_bytes()),
        "bytes": archive.stat().st_size,
    }, hashes


def inspect_store_packages(root, version):
    chrome, chrome_hashes = inspect_package(root, "chrome", version)
    edge, edge_hashes = inspect_package(root, "edge", version)
    if chrome_hashes != edge_hashes:
        differing = sorted(name for name in chrome_hashes.keys() | edge_hashes.keys()
                           if chrome_hashes.get(name) != edge_hashes.get(name))
        raise ValueError("Chrome 与 Edge 生产内容不同，需分别验收：" + "、".join(differing))
    # 排序后的相对文件名与 SHA 固定整体身份；ZIP 时间等容器信息不影响此摘要。
    identity = "".join(f"{name}\0{chrome_hashes[name]}\n" for name in sorted(chrome_hashes))
    return {
        "version": version,
        "packages": {"chrome": chrome, "edge": edge},
        "productionDigest": sha256(identity.encode()),
        "productionFiles": len(chrome_hashes),
        "equivalence": True,
    }


def main():
    root = Path(__file__).resolve().parent.parent
    output = root / ".output"
    # 失败后不能残留上次成功的门禁记录。
    for filename in ("store-packages.json", "SHA256SUMS"):
        (output / filename).unlink(missing_ok=True)
    for browser in ("chrome", "edge"):
        subprocess.run(["node", "scripts/verify-built-manifest.cjs", "--browser", browser],
                       cwd=root, check=True)
    version = json.loads((root / "package.json").read_text())["version"]
    result = inspect_store_packages(root, version)
    result["sourceCommit"] = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    # 本地未提交的源码不能被描述为 HEAD 的正式交付。
    result["sourceDirty"] = bool(subprocess.check_output(
        ["git", "status", "--porcelain", "--untracked-files=all"], cwd=root, text=True).strip())
    (output / "store-packages.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "SHA256SUMS").write_text("".join(
        f"{item['sha256']}  {item['file']}\n" for item in result["packages"].values()),
        encoding="utf-8")
    print(f"两商店 ZIP 校验通过：{result['productionFiles']} 个文件内容完全一致；"
          "此结果不代表实际 Edge 浏览器验收")


if __name__ == "__main__":
    main()
