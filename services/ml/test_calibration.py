"""Synthetic-only tests; no real labels or production artifacts."""
import unittest
import numpy as np
from ml_calibration import grouped_folds, calibrated_model
from ml_common import frame

class CalibrationTests(unittest.TestCase):
    def test_groups_are_disjoint_and_every_row_validated_once(self):
        y = np.array([i % 2 for i in range(40)])
        groups = np.array([str(i // 4) for i in range(40)])
        folds = grouped_folds(y, groups)
        seen = []
        for tr, va in folds:
            self.assertFalse(set(groups[tr]) & set(groups[va]))
            self.assertEqual(set(y[tr]), {0, 1})
            seen.extend(va.tolist())
        self.assertEqual(sorted(seen), list(range(40)))

    def test_insufficient_groups_fail_instead_of_fabricating_oof_predictions(self):
        with self.assertRaises(ValueError):
            grouped_folds(np.array([0, 1] * 10), np.array(['one'] * 20))

    def test_calibration_is_fitted_without_external_rows(self):
        rows = [{'title': 'analyst' if i % 2 else 'sales', 'role': 'soc', 'dense': [i % 2], 'emb': None} for i in range(40)]
        y = np.array([i % 2 for i in range(40)])
        groups = np.array([str(i // 4) for i in range(40)])
        df = frame(rows, ['signal'], False)
        model = calibrated_model('hybrid', 1, 0, 1.0, 7, df, y, groups)
        scores = model.predict_proba(df)[:, 1]
        self.assertTrue(np.isfinite(scores).all())
        self.assertTrue(((scores > 0) & (scores < 1)).all())
        self.assertEqual(model.method, 'sigmoid')

if __name__ == '__main__':
    unittest.main()

class FeatureTests(unittest.TestCase):
    def test_separate_lexical_and_embedding_baselines(self):
        from ml_common import build_pipeline
        lexical = build_pipeline('tfidf', 2, 3, 1.0, 7)
        semantic = build_pipeline('minilm', 2, 3, 1.0, 7)
        self.assertEqual([x[0] for x in lexical.named_steps['features'].transformers], ['text', 'role'])
        self.assertEqual([x[0] for x in semantic.named_steps['features'].transformers], ['role', 'emb'])
