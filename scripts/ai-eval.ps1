# Baseline (rules) vs shadow Qwen challenger on the held-out synthetic examples. Needs services/ai/.venv and (for the challenger) Ollama on loopback.
# Writes private-runtime/ai-eval/eval-<time>.json. Pass-through args: --no-challenger, --runs N, --out FILE
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root 'services/ai/.venv/Scripts/python.exe'
if (-not (Test-Path $py)) { Write-Error 'services/ai/.venv is missing; see services/ai/README.md'; exit 2 }
Push-Location (Join-Path $root 'services/ai')
try {
  & $py -I -c "import sys; sys.path.insert(0,'.'); from eval.run_eval import main; raise SystemExit(main(sys.argv[1:]))" @args
  exit $LASTEXITCODE
} finally { Pop-Location }
