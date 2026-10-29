"""Fine-tune ``microsoft/layoutlmv3-base`` for resume token classification.

Splits come from ``data/splits.json`` and are grouped by ``template_family``,
so no layout family straddles train and evaluation (``src.dataset`` raises if
one does). Metrics are entity-level and strict via ``seqeval``; early stopping
watches ``eval_f1``.

CLI::

    python -m src.train --dry-run            # init model, one forward pass
    python -m src.train                      # full run with the defaults below
    python -m src.train --epochs 30 --lr 3e-5 --output-dir models/run-02
"""

from __future__ import annotations

import argparse
import inspect
import json
import logging
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from src.dataset import (
    DEFAULT_IMAGE_DPI,
    DEFAULT_MAX_LENGTH,
    DEFAULT_MODEL_NAME,
    DEFAULT_WINDOW_STRIDE,
    DEFAULT_WINDOW_WORDS,
    ID2LABEL,
    IGNORE_INDEX,
    LABEL2ID,
    LABELS,
    ResumeLayoutDataset,
    build_processor,
    collate_fn,
)

LOGGER = logging.getLogger(__name__)

DEFAULT_OUTPUT_DIR = "models/layoutlmv3-resume-pilot"
DEFAULT_EPOCHS = 20
DEFAULT_LR = 3e-5
DEFAULT_TRAIN_BATCH = 4
DEFAULT_EVAL_BATCH = 4
DEFAULT_GRAD_ACCUM = 2
DEFAULT_WARMUP_RATIO = 0.1
DEFAULT_PATIENCE = 3


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #
def decode_predictions(
    logits: np.ndarray,
    labels: np.ndarray,
) -> tuple[list[list[str]], list[list[str]]]:
    """Drop ``IGNORE_INDEX`` positions and map ids back to BIO tag strings."""
    predicted_ids = np.argmax(logits, axis=-1)
    predictions: list[list[str]] = []
    references: list[list[str]] = []
    for prediction_row, label_row in zip(predicted_ids, labels):
        kept = [
            (ID2LABEL[int(p)], ID2LABEL[int(l)])
            for p, l in zip(prediction_row, label_row)
            if int(l) != IGNORE_INDEX
        ]
        predictions.append([p for p, _ in kept])
        references.append([l for _, l in kept])
    return predictions, references


def compute_metrics(eval_prediction: Any) -> dict[str, float]:
    """Entity-level strict precision/recall/F1 plus per-entity F1."""
    from seqeval.metrics import (
        accuracy_score,
        classification_report,
        f1_score,
        precision_score,
        recall_score,
    )
    from seqeval.scheme import IOB2

    logits = eval_prediction.predictions
    if isinstance(logits, (tuple, list)):
        logits = logits[0]
    predictions, references = decode_predictions(np.asarray(logits), np.asarray(eval_prediction.label_ids))

    strict: dict[str, Any] = {"mode": "strict", "scheme": IOB2, "zero_division": 0}
    metrics: dict[str, float] = {
        "precision": float(precision_score(references, predictions, **strict)),
        "recall": float(recall_score(references, predictions, **strict)),
        "f1": float(f1_score(references, predictions, **strict)),
        "token_accuracy": float(accuracy_score(references, predictions)),
    }
    report = classification_report(
        references, predictions, output_dict=True, zero_division=0, mode="strict", scheme=IOB2
    )
    for entity, scores in report.items():
        if isinstance(scores, dict) and not entity.endswith("avg"):
            metrics[f"f1_{entity}"] = float(scores.get("f1-score", 0.0))
            metrics[f"support_{entity}"] = float(scores.get("support", 0.0))
    return metrics


# --------------------------------------------------------------------------- #
# Model + arguments
# --------------------------------------------------------------------------- #
def load_model(model_name: str = DEFAULT_MODEL_NAME) -> Any:
    """Load the token-classification head with this project's label mapping."""
    from transformers import LayoutLMv3ForTokenClassification

    return LayoutLMv3ForTokenClassification.from_pretrained(
        model_name,
        num_labels=len(LABELS),
        id2label=ID2LABEL,
        label2id=LABEL2ID,
    )


def build_training_arguments(args: argparse.Namespace) -> Any:
    """Build ``TrainingArguments``, tolerating the 4.46 option renames."""
    from transformers import TrainingArguments

    supported = inspect.signature(TrainingArguments.__init__).parameters
    eval_key = "eval_strategy" if "eval_strategy" in supported else "evaluation_strategy"

    kwargs: dict[str, Any] = {
        "output_dir": args.output_dir,
        "learning_rate": args.lr,
        "per_device_train_batch_size": args.train_batch_size,
        "per_device_eval_batch_size": args.eval_batch_size,
        "gradient_accumulation_steps": args.grad_accum,
        "num_train_epochs": args.epochs,
        "warmup_ratio": args.warmup_ratio,
        "weight_decay": args.weight_decay,
        eval_key: "epoch",
        "save_strategy": "epoch",
        "save_total_limit": 2,
        "load_best_model_at_end": True,
        "metric_for_best_model": "eval_f1",
        "greater_is_better": True,
        "logging_steps": args.logging_steps,
        "seed": args.seed,
        "report_to": [],
        "remove_unused_columns": False,
    }
    if args.fp16:
        kwargs["fp16"] = True
    return TrainingArguments(**{k: v for k, v in kwargs.items() if k in supported or k == eval_key})


def build_trainer(args: argparse.Namespace) -> tuple[Any, Any, Any]:
    """Assemble processor, datasets, model and ``Trainer``."""
    from transformers import EarlyStoppingCallback, Trainer

    processor = build_processor(args.model_name)
    dataset_kwargs: dict[str, Any] = {
        "max_length": args.max_length,
        "image_dpi": args.image_dpi,
        "label_all_subwords": args.label_all_subwords,
        "allow_missing_images": not args.require_images,
    }
    train_dataset = ResumeLayoutDataset.from_split(
        args.annotations_dir,
        args.splits,
        "train",
        processor,
        window_words=args.window_words,
        window_stride=args.window_stride,
        **dataset_kwargs,
    )
    eval_dataset = ResumeLayoutDataset.from_split(
        args.annotations_dir,
        args.splits,
        "val",
        processor,
        window_words=args.window_words,
        window_stride=args.window_stride,
        **dataset_kwargs,
    )
    LOGGER.info("train windows=%d  val windows=%d", len(train_dataset), len(eval_dataset))

    model = load_model(args.model_name)
    training_arguments = build_training_arguments(args)

    trainer_kwargs: dict[str, Any] = {
        "model": model,
        "args": training_arguments,
        "train_dataset": train_dataset,
        "eval_dataset": eval_dataset,
        "data_collator": collate_fn,
        "compute_metrics": compute_metrics,
        "callbacks": [EarlyStoppingCallback(early_stopping_patience=args.patience)],
    }
    supported = inspect.signature(Trainer.__init__).parameters
    # Transformers >= 4.46 renamed `tokenizer` to `processing_class`.
    if "processing_class" in supported:
        trainer_kwargs["processing_class"] = processor
    else:  # pragma: no cover - older transformers
        trainer_kwargs["tokenizer"] = processor

    return Trainer(**trainer_kwargs), processor, model


# --------------------------------------------------------------------------- #
# Entrypoints
# --------------------------------------------------------------------------- #
def dry_run(args: argparse.Namespace) -> int:
    """Initialise the model and push one batch through it - no optimisation."""
    import torch

    from src.dataset import synthetic_document

    processor = build_processor(args.model_name)
    if Path(args.splits).is_file() and Path(args.annotations_dir).is_dir():
        dataset = ResumeLayoutDataset.from_split(
            args.annotations_dir,
            args.splits,
            "train",
            processor,
            window_words=args.window_words,
            window_stride=args.window_stride,
            allow_missing_images=not args.require_images,
        )
        source = f"{args.annotations_dir} (train split)"
    else:
        dataset = ResumeLayoutDataset.from_documents([synthetic_document()], processor)
        source = "synthetic fixture"
    print(f"data source: {source}; windows={len(dataset)}")

    model = load_model(args.model_name)
    model.eval()
    batch = collate_fn([dataset[index] for index in range(min(2, len(dataset)))])
    with torch.no_grad():
        output = model(**batch)
    print(f"logits {tuple(output.logits.shape)}  loss {float(output.loss):.4f}")
    print(f"labels {len(LABELS)}  parameters {model.num_parameters() / 1e6:.1f}M")
    return 0


def train(args: argparse.Namespace) -> int:
    """Run the full fine-tune and save the best checkpoint."""
    trainer, processor, _model = build_trainer(args)
    result = trainer.train()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(output_dir))
    processor.save_pretrained(str(output_dir))

    metrics = dict(result.metrics)
    metrics.update(trainer.evaluate())
    (output_dir / "train_metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    (output_dir / "run_config.json").write_text(
        json.dumps({k: v for k, v in vars(args).items()}, indent=2, default=str), encoding="utf-8"
    )

    print(f"saved best checkpoint to {output_dir}")
    for key in sorted(metrics):
        if key.startswith(("eval_", "train_")):
            print(f"  {key:<28} {metrics[key]}")
    print("Validation numbers are NOT held-out evidence. Run src.evaluate on the test split.")
    return 0


def _build_cli() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="python -m src.train",
        description="Fine-tune LayoutLMv3 for resume token classification.",
    )
    cli.add_argument("--annotations-dir", default="data/annotations")
    cli.add_argument("--splits", default="data/splits.json")
    cli.add_argument("--model-name", default=DEFAULT_MODEL_NAME)
    cli.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    cli.add_argument("--epochs", type=float, default=DEFAULT_EPOCHS)
    cli.add_argument("--lr", type=float, default=DEFAULT_LR)
    cli.add_argument("--train-batch-size", type=int, default=DEFAULT_TRAIN_BATCH)
    cli.add_argument("--eval-batch-size", type=int, default=DEFAULT_EVAL_BATCH)
    cli.add_argument("--grad-accum", type=int, default=DEFAULT_GRAD_ACCUM)
    cli.add_argument("--warmup-ratio", type=float, default=DEFAULT_WARMUP_RATIO)
    cli.add_argument("--weight-decay", type=float, default=0.01)
    cli.add_argument("--patience", type=int, default=DEFAULT_PATIENCE)
    cli.add_argument("--max-length", type=int, default=DEFAULT_MAX_LENGTH)
    cli.add_argument("--window-words", type=int, default=DEFAULT_WINDOW_WORDS)
    cli.add_argument("--window-stride", type=int, default=DEFAULT_WINDOW_STRIDE)
    cli.add_argument("--image-dpi", type=int, default=DEFAULT_IMAGE_DPI)
    cli.add_argument("--logging-steps", type=int, default=10)
    cli.add_argument("--seed", type=int, default=13)
    cli.add_argument("--fp16", action="store_true", help="Mixed precision (CUDA only)")
    cli.add_argument(
        "--label-all-subwords",
        action="store_true",
        help="Label continuation subwords with I- instead of ignoring them",
    )
    cli.add_argument(
        "--require-images",
        action="store_true",
        help="Fail instead of substituting a blank page when a PDF is missing",
    )
    cli.add_argument("--dry-run", action="store_true", help="Init + one forward pass, no training")
    cli.add_argument("-v", "--verbose", action="store_true")
    return cli


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_cli().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
    return dry_run(args) if args.dry_run else train(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
