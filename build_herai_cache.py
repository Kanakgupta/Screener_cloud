#!/usr/bin/env python3
"""Build-time precompute for HerAI's screening pool (scalability).

HerAI's chat worker can answer "give me 10 stocks to invest" by scoring a pool
of candidates drawn from the site's own prebuilt screener pages. Doing that live
means fetching ~16 screener HTMLs per question. This script precomputes that pool
ONCE per daily build and writes a compact JSON the worker reads in a single
request:

    cloud/<region>/herai_picks.json  =  { "generated": <iso>, "region": <r>,
                                           "pool": [ {ticker,name,screens,
                                                      universes,setups,metrics}, ... ] }

The worker still applies market-regime weighting and universe/count filtering at
request time, so rankings stay fresh; only the expensive pool assembly is cached.

The parsing here mirrors buildScreenPool() / parseScreenerTable() in
herai_extract.js so both paths produce identical structures.

Usage:
    python build_herai_cache.py                 # ./cloud, regions usa+india
    python build_herai_cache.py --base ./cloud --regions usa india
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

# Screens that signal technical strength vs fundamental quality. Kept in sync
# with TECH_SCREENS / FUND_SCREENS in herai.js.
TECH_SCREENS = [
    "high-momentum", "momentum-3m", "near-52w-high", "golden-cross",
    "ema-multi-up-5d", "top-ytd", "high-rev-growth",
]
FUND_SCREENS = [
    "high-roe", "high-fcf", "high-earnings-growth", "high-margin",
    "low-debt", "low-pe", "low-ev-ebitda", "high-dividend", "high-rev-growth",
]
SCREEN_NAMES = list(dict.fromkeys(TECH_SCREENS + FUND_SCREENS))

_SETUP_SPLIT = re.compile(r"\s{2,}|\U0001F680|\U0001F4C8|\U0001F525")


def _strip_tags(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = (s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
          .replace("&#39;", "'").replace("&quot;", '"').replace("&nbsp;", " "))
    return re.sub(r"\s+", " ", s).strip()


def _first_table(html: str) -> str | None:
    m = re.search(r'<table class="data-table.*?</table>', html, re.S)
    return m.group(0) if m else None


def _headers(table: str) -> list[str]:
    thead = re.search(r"<thead>(.*?)</thead>", table, re.S)
    if not thead:
        return []
    return [_strip_tags(h) for h in re.findall(r"<th[^>]*>(.*?)</th>", thead.group(1), re.S)]


def _num(s: str):
    if not s:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", str(s).replace(",", ""))
    return float(m.group(0)) if m else None


def parse_screener_rows(html: str, limit: int = 80) -> list[dict]:
    """Mirror of parseScreenerTable() in herai_extract.js."""
    table = _first_table(html)
    if not table:
        return []
    headers = _headers(table)
    tbody = re.search(r"<tbody[^>]*>(.*?)</tbody>", table, re.S)
    body = tbody.group(1) if tbody else table
    rows: list[dict] = []
    for attr_str, rh in re.findall(r"<tr(\s[^>]*)?>(.*?)</tr>", body, re.S):
        tk = re.search(r"stocks/([A-Za-z0-9.\-]+)\.html", rh)
        if not tk:
            continue
        ticker = tk.group(1).replace(".NS", "").replace(".BO", "")
        cells = [_strip_tags(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", rh, re.S)]
        name = ""
        metrics: dict[str, str] = {}
        for i, cell in enumerate(cells):
            head = headers[i] if i < len(headers) else ""
            hl = head.lower()
            if hl == "name":
                name = cell
                continue
            if hl in ("#", "", "charts", "ticker") or not cell:
                continue
            metrics.setdefault(head, cell)
        attrs: dict[str, str] = {}
        if attr_str:
            for am in re.finditer(r'([\w-]+)="([^"]*)"', attr_str):
                attrs[am.group(1)] = am.group(2)
        # PEG augmentation (P/E / 5Y growth), matching the JS path.
        pe = _num(metrics.get("P/E"))
        growth = _num(metrics.get("Profit CAGR 5Y %") or metrics.get("Rev CAGR 5Y %"))
        if pe is not None and growth and growth > 0 and "PEG" not in metrics:
            metrics["PEG"] = str(round(pe / growth, 2))
        rows.append({"ticker": ticker, "name": name, "metrics": metrics, "attrs": attrs})
        if len(rows) >= limit:
            break
    return rows


def build_pool(region_dir: Path, per_screen_limit: int = 80) -> list[dict]:
    pool: dict[str, dict] = {}
    for name in SCREEN_NAMES:
        path = region_dir / "screens" / f"{name}.html"
        if not path.exists():
            continue
        try:
            html = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for r in parse_screener_rows(html, per_screen_limit):
            key = r["ticker"]
            if not key:
                continue
            entry = pool.get(key)
            if entry is None:
                entry = {
                    "ticker": key,
                    "name": r["name"] or "",
                    "screens": set(),
                    "universes": set(),
                    "setups": set(),
                    "metrics": {},
                }
                pool[key] = entry
            if r["name"] and not entry["name"]:
                entry["name"] = r["name"]
            entry["screens"].add(name)
            idx = (r["attrs"].get("data-idx") or "")
            for u in (x.strip() for x in idx.split(",")):
                if u:
                    entry["universes"].add(u)
            setup = r["metrics"].get("Setup") or r["metrics"].get("Setups") or ""
            for tag in _SETUP_SPLIT.split(setup):
                tag = tag.strip()
                if len(tag) > 2:
                    entry["setups"].add(tag)
            for k, v in r["metrics"].items():
                if v and k not in entry["metrics"]:
                    entry["metrics"][k] = v
    return [
        {
            "ticker": e["ticker"],
            "name": e["name"],
            "screens": sorted(e["screens"]),
            "universes": sorted(e["universes"]),
            "setups": sorted(e["setups"]),
            "metrics": e["metrics"],
        }
        for e in pool.values()
    ]


def build_region(base: Path, region: str) -> int:
    region_dir = base / region
    if not region_dir.exists():
        print(f"[herai-cache] skip {region}: {region_dir} not found")
        return 0
    pool = build_pool(region_dir)
    out = {
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "region": region,
        "count": len(pool),
        "pool": pool,
    }
    dest = region_dir / "herai_picks.json"
    dest.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"[herai-cache] {region}: {len(pool)} candidates -> {dest}")
    return len(pool)


def main() -> int:
    ap = argparse.ArgumentParser(description="Precompute HerAI screening pool JSON.")
    ap.add_argument(
        "--base",
        default=str(Path(__file__).resolve().parent / "cloud"),
        help="Directory containing region subfolders (default: ./cloud)",
    )
    ap.add_argument("--regions", nargs="+", default=["usa", "india"])
    args = ap.parse_args()

    base = Path(args.base).resolve()
    total = 0
    for region in args.regions:
        total += build_region(base, region)
    print(f"[herai-cache] done: {total} total candidates across {len(args.regions)} region(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
