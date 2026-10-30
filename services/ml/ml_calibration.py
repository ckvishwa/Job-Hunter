"""Train-group-only probability calibration; never accepts held-out data."""
import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import StratifiedGroupKFold
from ml_common import build_pipeline


def grouped_folds(y, groups):
    # Reduce fold count when a class is concentrated in too few groups.
    for n in range(min(5, len(set(groups))), 1, -1):
        folds = list(StratifiedGroupKFold(n_splits=n).split(np.zeros(len(y)), y, groups))
        if all(len(set(y[tr])) == 2 and len(set(y[va])) == 2 for tr, va in folds):
            return folds
    raise ValueError('need at least two disjoint groups per class for calibration')


def calibrated_model(candidate, n_dense, emb_dim, c, seed, df, y, groups):
    folds = grouped_folds(y, groups)
    # Each transformer is fitted inside its training fold. ensemble=False uses
    # out-of-fold predictions to fit sigmoid calibration, then refits the base
    # estimator on all TRAIN rows. It does not refit on the external test split.
    return CalibratedClassifierCV(
        build_pipeline(candidate, n_dense, emb_dim, c, seed),
        method='sigmoid', cv=folds, ensemble=False, n_jobs=1,
    ).fit(df, y)
