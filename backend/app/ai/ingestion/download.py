"""Download the CMS MCD weekly exports and extract ONLY the CSV files (saves ~350 MB of .mdb).

Requires `ACCEPT_CMS_LICENSE=true`: the exports embed AMA (CPT®), ADA (CDT) and AHA (UB-04) content
licensed for end-user use. Data lands in `data/raw/` which is git-ignored and never uploaded as a CI
artifact.

Note: `api.coverage.cms.gov` is geo-restricted from some regions; the `downloads.cms.gov` bulk
exports used here are generally reachable. In CI, the ingest workflow runs on a US-hosted runner.
"""

from __future__ import annotations

import io
import shutil
import zipfile
from pathlib import Path

import httpx
import structlog

from app.core.config import get_settings

log = structlog.get_logger(__name__)

EXPORTS = ("current_lcd", "current_article", "ncd")
LICENSE_NOTICE = (
    "The CMS Medicare Coverage Database exports contain material copyrighted by the AMA (CPT®), the ADA "
    "(CDT) and the AHA (UB-04). By setting ACCEPT_CMS_LICENSE=true you accept the end-user license terms "
    "presented at https://www.cms.gov/medicare-coverage-database/downloads/downloads.aspx for your own use."
)


class LicenseNotAccepted(RuntimeError):
    pass


async def download_mcd(dest: Path | None = None, exports: tuple[str, ...] = EXPORTS) -> dict:
    s = get_settings()
    accepted = getattr(s, "accept_cms_license", False)
    if not accepted:
        raise LicenseNotAccepted(LICENSE_NOTICE + "\nSet ACCEPT_CMS_LICENSE=true to proceed.")
    dest = dest or (Path(s.data_dir) / "raw")
    dest.mkdir(parents=True, exist_ok=True)
    out: dict[str, dict] = {}
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(300, connect=30),
        follow_redirects=True,
        headers={"User-Agent": "necessa-ingest/1.0"},
    ) as client:
        for name in exports:
            url = f"{s.mcd_base_url.rstrip('/')}/{name}.zip"
            log.info("mcd.download", url=url)
            resp = await client.get(url)
            resp.raise_for_status()
            outer = zipfile.ZipFile(io.BytesIO(resp.content))
            inner_name = next((n for n in outer.namelist() if n.endswith("_csv.zip")), None)
            if inner_name is None:
                raise RuntimeError(f"{name}.zip has no CSV export inside")
            target = dest / name / "csv"
            if target.exists():
                shutil.rmtree(target)
            target.mkdir(parents=True)
            with zipfile.ZipFile(io.BytesIO(outer.read(inner_name))) as inner:
                for member in inner.namelist():
                    p = Path(member)
                    if p.suffix.lower() != ".csv" or ".." in p.parts:
                        continue  # zip-slip / non-CSV guard
                    (target / p.name).write_bytes(inner.read(member))
            out[name] = {
                "bytes": len(resp.content),
                "files": len(list(target.glob("*.csv"))),
                "lastModified": resp.headers.get("last-modified"),
            }
    return out
