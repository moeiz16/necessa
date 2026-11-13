"""X-Forwarded-For is only honored from trusted proxies, so clients can't spoof their way past limits."""

from __future__ import annotations

from app.core.clientip import resolve_client_ip


def test_direct_client_cannot_spoof_forwarded_for():
    assert resolve_client_ip("203.0.113.9", "1.2.3.4") == "203.0.113.9"


def test_trusted_proxy_uses_rightmost_untrusted_hop():
    # The client prepended a fake "1.2.3.4"; the proxy appended the real address.
    assert resolve_client_ip("127.0.0.1", "1.2.3.4, 198.51.100.7") == "198.51.100.7"


def test_trusted_proxy_without_header_falls_back_to_peer():
    assert resolve_client_ip("127.0.0.1", None) == "127.0.0.1"


def test_all_hops_trusted_returns_first_hop():
    assert resolve_client_ip("127.0.0.1", "127.0.0.1, ::1") == "127.0.0.1"
