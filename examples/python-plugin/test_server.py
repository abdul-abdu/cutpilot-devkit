"""Unit tests for word_stats: `uv run python -m unittest` in this folder."""

import unittest

from server import word_stats


class WordStatsTest(unittest.TestCase):
    def test_counts(self) -> None:
        s = word_stats("The cat saw the other cat. The end!", top=2)
        self.assertEqual(s.words, 8)
        self.assertEqual(s.unique_words, 5)
        self.assertEqual(s.average_word_length, 3.25)
        self.assertEqual([(t.word, t.count) for t in s.top_words], [("the", 3), ("cat", 2)])

    def test_any_script_and_inner_punctuation(self) -> None:
        s = word_stats("Salom, dunyo! Привет, мир. Don't stop-motion")
        self.assertEqual(s.words, 6)
        self.assertEqual(s.top_words[0].word, "salom")

    def test_no_words(self) -> None:
        s = word_stats("... !!!")
        self.assertEqual((s.words, s.unique_words, s.average_word_length, s.top_words), (0, 0, 0.0, []))


if __name__ == "__main__":
    unittest.main()
