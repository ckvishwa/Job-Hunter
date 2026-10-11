"""Offset convention: the TypeScript boundary uses UTF-16 code units (JS string indices). Python indexes code points,
so every span that leaves this service is converted. For BMP-only text the two are identical."""
from __future__ import annotations

from bisect import bisect_right


class Utf16Map:
    def __init__(self, text: str) -> None:
        self._identity = all(ord(c) < 0x10000 for c in text)
        self._prefix: list[int] = []
        if not self._identity:
            total = 0
            for c in text:
                self._prefix.append(total)
                total += 2 if ord(c) >= 0x10000 else 1
            self._prefix.append(total)

    def to_u16(self, index: int) -> int:
        return index if self._identity else self._prefix[index]

    def from_u16(self, unit: int) -> int:
        if self._identity:
            return unit
        return bisect_right(self._prefix, unit) - 1


def utf16_len(text: str) -> int:
    return len(text) + sum(1 for c in text if ord(c) >= 0x10000)
