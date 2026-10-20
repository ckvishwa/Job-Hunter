"""Pasted text uses the same normalization and parser input as uploaded files."""
import unittest

from app.extract_text import ExtractError, extract


class PastedTextTests(unittest.TestCase):
    def test_utf8_text_is_normalized(self):
        doc = extract(b"Jordan Rivers\r\nPython\r\n", "text")
        self.assertEqual(doc.text, "Jordan Rivers\nPython")
        self.assertEqual(doc.page_count, 1)

    def test_invalid_utf8_is_rejected(self):
        with self.assertRaises(ExtractError) as caught:
            extract(b"\xff", "text")
        self.assertEqual(caught.exception.code, "UNREADABLE_FILE")


if __name__ == "__main__":
    unittest.main()
