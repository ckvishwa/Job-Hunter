"""Fail-closed offline mode for private candidate processing.

Two independent things happen here, and it matters which is which:

  1. `require_dependencies` refuses to start unless every library the private
     path needs is already importable. Nothing is installed or downloaded: a
     missing dependency ends the run with DEPENDENCY_UNAVAILABLE rather than
     silently degrading to a worse extractor or reaching out for a wheel.

  2. `block_network` replaces the socket factory so that any attempt to connect
     anywhere other than the loopback interface raises `NetworkBlocked`.

What (2) is NOT: a security boundary. It is an in-process guard inside one
Python interpreter. It does not constrain a subprocess, a C extension that
calls the operating system's socket API directly, a memory-mapped device, DNS
resolution performed by the C library, or anything else running on the machine.
Treat it as a loud tripwire that turns an accidental upload into a crash with a
stack trace, not as proof that no byte can leave.

For an actual isolation guarantee, the process must be confined from outside.
`docs/privacy/LOCAL-PIPELINE.md` records the Windows Firewall outbound rule and
the container option, and how to verify each.
"""
from __future__ import annotations

import ipaddress
import socket
import sys
from dataclasses import dataclass

#: Modules the private intake path needs. Import failure is fatal: no fallback, no install.
REQUIRED_MODULES = ("pdfplumber", "pdfminer")

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_DEPENDENCY_UNAVAILABLE = 3
EXIT_NETWORK_BLOCKED = 4
EXIT_PRIVACY_VIOLATION = 5


class NetworkBlocked(RuntimeError):
    """Raised when code under the guard tries to reach a non-loopback address."""


@dataclass(frozen=True)
class DependencyReport:
    ok: bool
    missing: tuple[str, ...]
    versions: dict[str, str]


def require_dependencies(modules: tuple[str, ...] = REQUIRED_MODULES) -> DependencyReport:
    """Check, never install. Versions are recorded so a run is reproducible."""
    missing: list[str] = []
    versions: dict[str, str] = {}
    for name in modules:
        try:
            module = __import__(name)
        except Exception:  # noqa: BLE001 - any import problem is the same answer here
            missing.append(name)
            continue
        versions[name] = str(getattr(module, "__version__", "unknown"))
    return DependencyReport(ok=not missing, missing=tuple(missing), versions=versions)


def _is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host in ("localhost", "")


class _GuardedSocket(socket.socket):
    """A socket that refuses to connect anywhere but loopback."""

    def connect(self, address):  # type: ignore[override]
        _check_address(address)
        return super().connect(address)

    def connect_ex(self, address):  # type: ignore[override]
        _check_address(address)
        return super().connect_ex(address)

    def sendto(self, *args, **kwargs):  # type: ignore[override]
        address = args[-1] if args else kwargs.get("address")
        _check_address(address)
        return super().sendto(*args, **kwargs)


def _check_address(address: object) -> None:
    if isinstance(address, tuple) and address and isinstance(address[0], str):
        if not _is_loopback(address[0]):
            raise NetworkBlocked(
                f"offline mode: a connection to {address[0]} was attempted and blocked. "
                "Private candidate processing must not reach the network."
            )


_original_socket = socket.socket
_original_getaddrinfo = socket.getaddrinfo
_original_create_connection = socket.create_connection


def block_network() -> None:
    """Install the guard. Idempotent. Loopback stays open so a local service can still be used."""
    socket.socket = _GuardedSocket  # type: ignore[misc,assignment]

    def guarded_getaddrinfo(host, *args, **kwargs):  # type: ignore[no-untyped-def]
        if isinstance(host, str) and not _is_loopback(host):
            raise NetworkBlocked(f"offline mode: name resolution for {host} was blocked.")
        return _original_getaddrinfo(host, *args, **kwargs)

    def guarded_create_connection(address, *args, **kwargs):  # type: ignore[no-untyped-def]
        _check_address(address)
        return _original_create_connection(address, *args, **kwargs)

    socket.getaddrinfo = guarded_getaddrinfo  # type: ignore[assignment]
    socket.create_connection = guarded_create_connection  # type: ignore[assignment]


def restore_network() -> None:
    """Undo `block_network`. Used by tests; the CLI never calls it."""
    socket.socket = _original_socket  # type: ignore[misc,assignment]
    socket.getaddrinfo = _original_getaddrinfo  # type: ignore[assignment]
    socket.create_connection = _original_create_connection  # type: ignore[assignment]


def enforce(modules: tuple[str, ...] = REQUIRED_MODULES, *, log=print) -> DependencyReport:
    """Offline mode for a private run: block first, then verify dependencies, then report.

    Blocking happens before the dependency import so that a library which phones
    home on import trips the guard instead of succeeding.
    """
    block_network()
    report = require_dependencies(modules)
    if not report.ok:
        log(f"DEPENDENCY_UNAVAILABLE missing={','.join(report.missing)}")
        log("Offline mode installs nothing. Install these into the local virtual environment and re-run.")
        sys.exit(EXIT_DEPENDENCY_UNAVAILABLE)
    return report
