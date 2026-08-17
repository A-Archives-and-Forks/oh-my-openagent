# /// script
# requires-python = ">=3.12"
# dependencies = ["pydantic>=2.11,<3", "pytest>=8.4,<9"]
# ///
from __future__ import annotations

from pathlib import Path

from scanner_test_support import ROOT, scan_candidates


def test_builtin_category_snapshot_with_prompt_payload_yields_candidate(tmp_path: Path) -> None:
    fixture_root = ROOT / f".pytest-snapshot-fixtures-{tmp_path.name}"
    fixture_root.mkdir()
    path = fixture_root / "resolve-category.fixture.test.ts"
    _ = path.write_text(
        '''
import { expect } from "bun:test";
const defaults = BUILTIN_CATEGORY_DEFAULTS;
const snapshotSubject = defaults.map(({ config, description, name, promptAppend }) => ({
  name,
  config,
  description,
  promptAppend,
}));
expect(JSON.stringify(snapshotSubject, null, 2)).toMatchSnapshot();
''',
        encoding="utf-8",
    )
    try:
        found = scan_candidates([path])
    finally:
        path.unlink(missing_ok=True)
        fixture_root.rmdir()
    snapshots = [item for item in found if item.matcher == "toMatchSnapshot"]

    assert len(snapshots) == 1
    assert snapshots[0].kind == "snapshot"
    assert snapshots[0].expected == "<snapshot pins instruction output>"
