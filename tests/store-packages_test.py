"""用隔离小包验证发布门禁能拒绝错包、损坏包和不等价产物。"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import warnings
import zipfile

spec = importlib.util.spec_from_file_location(
    "store_packages", Path(__file__).resolve().parent.parent / "scripts/verify-store-packages.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class StorePackagesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="leximeet-store-package-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for browser in ("chrome", "edge"):
            output = self.root / ".output" / f"{browser}-mv3"
            output.mkdir(parents=True)
            (output / "manifest.json").write_text('{"version":"1.0.0"}')
            (output / "background.js").write_text("alpha")
            self.repack(browser)

    def archive(self, browser):
        return self.root / ".output" / f"leximeet-browser-1.0.0-{browser}.zip"

    def repack(self, browser):
        output = self.root / ".output" / f"{browser}-mv3"
        with zipfile.ZipFile(self.archive(browser), "w") as package:
            for file in sorted(output.rglob("*")):
                if file.is_file():
                    package.write(file, file.relative_to(output).as_posix())

    def inspect(self):
        return module.inspect_store_packages(self.root, "1.0.0")

    def test_equal_packages(self):
        result = self.inspect()
        self.assertTrue(result["equivalence"])
        self.assertEqual(result["productionFiles"], 2)
        self.assertEqual(len(result["productionDigest"]), 64)
        self.assertEqual(result["packages"]["edge"]["bytes"], self.archive("edge").stat().st_size)

    def test_edge_file_differs(self):
        (self.root / ".output/edge-mv3/background.js").write_text("changed")
        self.repack("edge")
        with self.assertRaisesRegex(ValueError, "生产内容不同"):
            self.inspect()

    def test_stale_edge_zip(self):
        (self.root / ".output/edge-mv3/background.js").write_text("changed")
        with self.assertRaisesRegex(ValueError, "ZIP 内容与生产目录不一致"):
            self.inspect()

    def test_extra_zip_file(self):
        with zipfile.ZipFile(self.archive("edge"), "a") as package:
            package.writestr("extra.txt", "extra")
        with self.assertRaisesRegex(ValueError, "文件列表"):
            self.inspect()

    def test_duplicate_zip_path(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.archive("edge"), "a") as package:
                package.writestr("background.js", "alpha")
        with self.assertRaisesRegex(ValueError, "重复路径"):
            self.inspect()

    def test_corrupt_crc(self):
        archive = self.archive("edge")
        data = archive.read_bytes()
        self.assertIn(b"alpha", data)
        archive.write_bytes(data.replace(b"alpha", b"omega", 1))
        with self.assertRaises(zipfile.BadZipFile):
            self.inspect()

    def test_nested_manifest(self):
        output = self.root / ".output/edge-mv3/data"
        output.mkdir()
        (output / "Manifest.JSON").write_text("{}")
        self.repack("edge")
        with self.assertRaisesRegex(ValueError, "只有根 manifest.json"):
            self.inspect()

    def test_symlink(self):
        (self.root / ".output/edge-mv3/link.js").symlink_to("background.js")
        with self.assertRaisesRegex(ValueError, "符号链接"):
            self.inspect()


if __name__ == "__main__":
    unittest.main()
