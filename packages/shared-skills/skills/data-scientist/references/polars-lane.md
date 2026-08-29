# Polars lane (Python via uv)

When the work is DataFrame-shaped, Python Polars is the right engine — and it runs in the uv
lane, not in a resident kernel: kernels rarely ship polars/pyarrow, and a kernel's
interpreter must not be mutated to add them.

## When Polars wins over DuckDB SQL

- Expression-chain transforms: many derived columns, per-column conditional logic, string
  pipelines — `with_columns` chains read and optimize better than nested SQL SELECTs.
- Reshapes: `unpivot`/`pivot` beat SQL gymnastics.
- Larger-than-RAM pipelines: the streaming engine executes lazy plans in chunks.
- Window-heavy feature engineering with `over()`.

SQL-shaped work (joins, aggregation, ad-hoc questions) stays in DuckDB; mixed pipelines hand
off zero-copy (below) instead of forcing one engine to do everything.

## Current API (1.x) — older spellings fail or warn

Training data is full of the pre-1.0 API. Current names:

| Use | Not |
| --- | --- |
| `pl.scan_csv` / `pl.scan_parquet` + `.collect()` | eager `read_*` on big files |
| `.group_by(...)` | `.groupby(...)` |
| `pl.len()` | `pl.count()` |
| `.collect(engine="streaming")` | `.collect(streaming=True)` |
| `.unpivot(...)` | `.melt(...)` |

Lazy first: `scan_*` builds a plan, pushes filters and projections down to the file read, and
executes once at `.collect()`. Eager `read_*` is for small files mutated interactively.

```bash
uv run --with polars python -c "
import polars as pl
out = (pl.scan_csv('data.csv')
       .filter(pl.col('value') > 100)
       .group_by('category')
       .agg(pl.col('value').sum().alias('total'), pl.len().alias('n'))
       .sort('total', descending=True)
       .collect())
print(out)
"
```

## Zero-copy handoff with DuckDB

Both engines speak Arrow, so mixed pipelines pay no serialization cost:

```bash
uv run --with duckdb --with polars --with pyarrow python -c "
import duckdb
import polars as pl
df = duckdb.sql(\"SELECT * FROM 'orders.csv' o JOIN 'items.csv' i USING (id)\").pl()
shaped = df.with_columns((pl.col('qty') * pl.col('price')).alias('rev'))
duckdb.register('shaped', shaped)
print(duckdb.sql('SELECT category, SUM(rev) AS total FROM shaped GROUP BY 1').pl())
"
```

- `.pl()` requires pyarrow in the package set, or it raises `ModuleNotFoundError`.
- Never `.df()`: it returns a pandas frame, and pandas is banned and absent.

## Streaming past RAM

```bash
uv run --with polars python -c "
import polars as pl
out = (pl.scan_parquet('huge.parquet')
       .filter(pl.col('status') == 'active')
       .group_by('region').agg(pl.len())
       .collect(engine='streaming'))
print(out)
"
```

Streaming executes lazy plans only — keep the plan lazy end-to-end, with no intermediate
`.collect()` breaking it into eager pieces.
