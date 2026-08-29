# Execution surfaces

How to run the engines on each surface, and when to escalate between them.

## Persistent kernel, JavaScript (Bun)

One-time setup per machine — the bundled script installs `@duckdb/node-api` into a user-level
cache outside any repo and prints the absolute import path (its only stdout line):

```bash
bash scripts/ensure-js-deps.sh          # run from the skill directory
```

In the kernel — top-level `require` may not exist, dynamic import always works:

```js
const { DuckDBInstance } = await import("<printed path>");
const db = await DuckDBInstance.create(":memory:");
const conn = await db.connect();
const reader = await conn.runAndReadAll("SELECT category, SUM(v) AS total FROM 'data.csv' GROUP BY 1");
reader.getRowObjects();                  // array of plain row objects
```

- The connection and any tables created live across cells — connect once per session, reuse.
- COUNT/SUM over integer columns return BigInt; convert (`Number(x)` or `String(x)`) before
  `JSON.stringify`, which throws on BigInt.
- Bun builtins cover ingest gaps with zero installs: `Bun.JSONL.parse`, `Bun.JSON5.parse`,
  `Bun.XML.parse`, `Bun.TOML.parse`, `Bun.Archive` for tarballs.
- nodejs-polars is NOT part of this skill's toolkit: its API lags the Python release by
  major versions (option objects that work in Python throw napi type errors). Polars work
  belongs to the uv lane.

## Persistent kernel, Python

Probe first, then use what is resident:

```python
import importlib.util
have = {m: importlib.util.find_spec(m) is not None for m in ("duckdb", "numpy", "matplotlib", "polars", "pyarrow")}
```

- `duckdb.sql("SELECT ... FROM 'data.csv'")` queries files in place. `.pl()` converts to
  Polars via Arrow only when polars and pyarrow are both present; in a bare kernel keep
  results in DuckDB or fetch plain Python values (`.fetchall()`).
- matplotlib figures render natively in kernels that display rich output; also save a PNG so
  the artifact survives the session.
- A missing module means: use the uv lane. Do not install into the kernel's interpreter —
  it is frequently an externally-managed system Python, and mutating it breaks other tools.

## uv lane (any surface)

```bash
uv run --with duckdb --with polars --with pyarrow --with numpy python -c "<code>"
```

- Include exactly the packages the code imports, plus pyarrow whenever `.pl()` is used.
- The first run resolves packages (seconds); later runs hit the cache and pay roughly half a
  second of process overhead — acceptable for one-shots, wasteful for exploration loops.
- Past a few lines, a temp file beats `-c` quoting: write the script, `uv run script.py`.

## No kernel at all

Same engines, one process per batch of questions:

```bash
bun -e '<the JavaScript kernel pattern above>'         # DuckDB via @duckdb/node-api
uv run --with duckdb python -c "<sql via duckdb.sql>"  # DuckDB via Python
uv run scripts/quick-query.py data.csv "SELECT ..."    # zero-code CLI fallback
```

## Escalation rules

Start on the resident kernel. Move a step down when a concrete need appears:

- Polars API needed (see `polars-lane.md`) — uv lane.
- Library missing from the kernel — uv lane.
- Crash-prone or memory-hungry one-shot that should not take the kernel down — uv lane.
- Data lives remotely or exceeds local RAM — read `placement.md` and move the query, not
  the data.
