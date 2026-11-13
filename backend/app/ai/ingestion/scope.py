"""The default `focus` ingestion scope (docs/API_CONTRACT.md §8).

Keeps free-tier embedding quota and storage small while staying realistic: services that commonly
require prior authorization / medical-necessity review (incl. the CMS WISeR model service list).
"""

from __future__ import annotations

import re

FOCUS_RANGES: list[tuple[str, str]] = [
    ("29870", "29889"),  # knee arthroscopy
    ("64555", "64595"),  # peripheral / sacral / tibial nerve neurostimulators
    ("63650", "63688"),  # spinal cord stimulators
    ("E0720", "E0749"),  # TENS / NMES / stimulators (DME)
    ("Q4100", "Q4400"),  # skin substitutes
    ("15271", "15278"),  # skin substitute application
    ("22551", "22600"),  # cervical fusion
    ("62321", "62327"),  # epidural steroid injections
    ("64479", "64484"),  # transforaminal epidurals
    ("64490", "64495"),  # facet joint injections
    ("64633", "64636"),  # facet RF ablation
    ("15820", "15823"),  # blepharoplasty
    ("67900", "67911"),  # brow / eyelid repair
    ("72141", "72158"),  # MRI spine
    ("73718", "73723"),  # MRI lower extremity
    ("E0601", "E0601"),  # CPAP
    ("E0470", "E0471"),  # bi-level PAP
    ("K0800", "K0899"),  # power mobility devices
    ("E0779", "E0791"),  # external infusion pumps
    ("L5000", "L5999"),  # lower limb prostheses
]

FOCUS_KEYWORDS: tuple[str, ...] = (
    "arthroscop",
    "nerve stimulat",
    "neurostimulat",
    "spinal cord stimulat",
    "sacral nerve",
    "tibial nerve",
    "skin substitute",
    "cervical fusion",
    "epidural",
    "facet joint",
    "blepharoplasty",
    "positive airway pressure",
    "power mobility",
    "infusion pump",
    "lower limb prosthe",
    "magnetic resonance imaging (mri) of the",
    "transcutaneous electrical",
    "wound care",
)

_SPLIT = re.compile(r"^([A-Z]?)(\d{4,5})([A-Z]?)$")


def _key(code: str) -> tuple[str, int, str] | None:
    m = _SPLIT.match(code.strip().upper())
    if not m:
        return None
    return m.group(1), int(m.group(2)), m.group(3)


def code_in_focus(code: str, ranges: list[tuple[str, str]] = FOCUS_RANGES) -> bool:
    k = _key(code)
    if k is None:
        return False
    for lo, hi in ranges:
        a, b = _key(lo), _key(hi)
        if a and b and k[0] == a[0] and a[1] <= k[1] <= b[1] and not k[2]:
            return True
    return False
