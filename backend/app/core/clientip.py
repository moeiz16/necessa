"""Client IP resolution that can't be spoofed with a forged X-Forwarded-For header.

The header is only honored when the direct peer is a trusted proxy (the Next.js server, a load
balancer). The client address is then the right-most entry that isn't itself a trusted proxy:
anything a client prepends to the header sits further left and is ignored.
"""

from __future__ import annotations

import ipaddress
from functools import lru_cache

from app.core.config import get_settings


@lru_cache
def _trusted() -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    nets = []
    for raw in getattr(get_settings(), "trusted_proxies", ["127.0.0.1", "::1"]):
        try:
            nets.append(ipaddress.ip_network(raw.strip(), strict=False))
        except ValueError:
            continue
    return tuple(nets)


def _is_trusted(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in _trusted())


def resolve_client_ip(peer: str | None, forwarded_for: str | None) -> str | None:
    if not peer or not forwarded_for or not _is_trusted(peer):
        return peer
    hops = [h.strip() for h in forwarded_for.split(",") if h.strip()]
    for hop in reversed(hops):
        if not _is_trusted(hop):
            return hop
    return hops[0] if hops else peer
