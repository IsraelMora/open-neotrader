# ml-feature-extractor

On-device sklearn discipline plugin. Trains a LogisticRegression (or RandomForest) model from labeled `ml_signal_record` rows and exposes per-signal confidence multipliers.

## What it does

- **`train(training_data, config)`** — Accepts a list of `MlSignalRecord` rows, extracts features per skill signal, fits a binary classifier (profitable vs not), and returns a base64-serialized model blob. Cold-starts if fewer than `min_samples` rows or only one outcome class.
- **`predict(signals, model_blob, config)`** — Accepts a list of pending signals and a previously trained blob, returns a multiplier per signal in `[multiplier_min, multiplier_max]` (default [0.5, 1.5]). Identity (empty dict) when no blob is provided or on any error.

## Activation

The plugin is **inactive by default** (`active = false`). It becomes meaningful only when wired by s3 (the on_cycle hook that injects `model_blob` into the predict call). In s2, `train` is invoked only via the `kernel__train_ml_model` reflection tool; `predict` is defined and unit-tested but has no live caller.

## Config

| Key              | Default  | Description                                         |
|------------------|----------|-----------------------------------------------------|
| `model_type`     | `logreg` | `logreg` = LogisticRegression; `rf` = RandomForest |
| `min_samples`    | `50`     | Minimum labeled rows required before fitting        |
| `multiplier_min` | `0.5`    | Lower bound for predict output                      |
| `multiplier_max` | `1.5`    | Upper bound for predict output                      |

## No file writes

The model blob is serialized entirely in memory (`io.BytesIO` + base64). No files are written — compatible with the sandbox open-guard.
