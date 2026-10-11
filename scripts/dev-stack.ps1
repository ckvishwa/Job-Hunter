<#
  Repeatable local startup for the Job Hunter S1/S2 stack (everything binds to 127.0.0.1).

    npm run dev:stack            start (idempotent: running services are left alone)
    npm run dev:stack:status     show every service, its port, pid and health
    npm run dev:stack:stop       stop API, AI service and UI (PostgreSQL keeps running; add -StopDb to stop it too)

  Order: PostgreSQL (Docker) -> migrations -> Python AI service -> TypeScript API (Fastify) -> Astro dev server.
  Each step waits for a real health check before the next starts, and refuses to start if its port belongs to something else.
  Logs: private-runtime/dev-logs/<service>.log and <service>.err.log (gitignored). Secrets are read from infra/.env, never printed.
#>
param(
  [Parameter(Position = 0)][ValidateSet('start', 'stop', 'status', 'restart')][string]$Action = 'start',
  [switch]$StopDb
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envFile = Join-Path $root 'infra/.env'
$logDir = Join-Path $root 'private-runtime/dev-logs'
$stateFile = Join-Path $logDir 'stack.json'
New-Item -ItemType Directory -Force $logDir | Out-Null

function Fail([string]$message) { Write-Host "ERROR: $message" -ForegroundColor Red; exit 1 }

# --- configuration (infra/.env never overrides variables already set in the shell) ----------------------------------------------
if (-not (Test-Path $envFile)) {
  Fail "infra/.env is missing. Copy infra/.env.example to infra/.env and replace every CHANGE_ME (see infra/README.md)."
}
foreach ($line in Get-Content $envFile) {
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith('#')) { continue }
  $i = $t.IndexOf('=')
  if ($i -le 0) { continue }
  $key = $t.Substring(0, $i).Trim()
  $value = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
  if (-not [Environment]::GetEnvironmentVariable($key)) { [Environment]::SetEnvironmentVariable($key, $value) }
}
function Cfg([string]$name, [string]$default) { $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $default } }

$apiPort = [int](Cfg 'JH_API_PORT' '8787')
$aiPort = [int](Cfg 'JH_AI_PORT' '8765')
$webPort = [int](Cfg 'JH_WEB_PORT' '4321')
$pgPort = [int](Cfg 'JH_PG_PORT' '55440')
# The UI proxy target and the API's trusted browser origins must follow the ports actually chosen. Hard-coded defaults only match
# the stock ports, which is how a changed port silently breaks every /api call.
[Environment]::SetEnvironmentVariable('JH_API_URL', "http://127.0.0.1:$apiPort")
[Environment]::SetEnvironmentVariable('JH_WEB_PORT', "$webPort")
if (-not [Environment]::GetEnvironmentVariable('JH_ALLOWED_ORIGINS')) {
  [Environment]::SetEnvironmentVariable('JH_ALLOWED_ORIGINS', "http://127.0.0.1:$webPort,http://localhost:$webPort")
}

$services = @(
  @{ Name = 'ai';  Port = $aiPort;  Url = "http://127.0.0.1:$aiPort/internal/v1/ai/info"; Bearer = $true },
  @{ Name = 'api'; Port = $apiPort; Url = "http://127.0.0.1:$apiPort/api/v1/healthz";      Bearer = $false },
  @{ Name = 'web'; Port = $webPort; Url = "http://127.0.0.1:$webPort/api/v1/healthz";      Bearer = $false }  # through the UI proxy
)

function Read-State { if (Test-Path $stateFile) { Get-Content $stateFile -Raw | ConvertFrom-Json -AsHashtable } else { @{} } }
function Write-State($state) { $state | ConvertTo-Json | Set-Content $stateFile -Encoding utf8 }
function Port-Owner([int]$port) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { [int]$c.OwningProcess } else { $null }
}
function Probe([string]$url, [bool]$bearer) {
  try {
    $headers = @{}
    if ($bearer) { $headers['Authorization'] = "Bearer $([Environment]::GetEnvironmentVariable('JH_AI_SERVICE_TOKEN'))" }
    (Invoke-WebRequest -Uri $url -Headers $headers -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200
  } catch { $false }
}
function Wait-Healthy([string]$name, [string]$url, [bool]$bearer, [int]$seconds = 90) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (Probe $url $bearer) { return }
    Start-Sleep -Milliseconds 700
  }
  Fail "$name did not become healthy at $url within ${seconds}s. See private-runtime/dev-logs/$name.err.log and $name.log."
}
function Stop-Tree([int]$processId) { & taskkill /PID $processId /T /F 2>&1 | Out-Null }

function Start-Postgres {
  Write-Host '[1/5] PostgreSQL (Docker)'
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'docker is not on PATH. Install/start Docker Desktop.' }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) { Fail 'The Docker daemon is not running. Start Docker Desktop, then rerun.' }
  & docker compose -f infra/docker-compose.yml --env-file infra/.env up -d
  if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed.' }
  $deadline = (Get-Date).AddSeconds(90)
  do {
    $health = (& docker inspect jobhunter-s1-pg --format '{{.State.Health.Status}}' 2>$null)
    if ($health -eq 'healthy') { break }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  if ($health -ne 'healthy') { Fail "PostgreSQL container is '$health', not healthy after 90s. Run: docker logs jobhunter-s1-pg" }
  Write-Host "      PostgreSQL healthy on 127.0.0.1:$pgPort"
}

function Start-Service($svc, [string]$file, [string[]]$arguments, [string]$workdir) {
  $name = $svc.Name; $port = $svc.Port
  $state = Read-State
  $owner = Port-Owner $port
  if ($owner) {
    if ($state.ContainsKey($name) -and [int]$state[$name] -eq $owner -and (Probe $svc.Url $svc.Bearer)) {
      Write-Host "      $name already running (pid $owner) on port $port"
      return
    }
    $who = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
    Fail "Port $port is already in use by pid $owner ($who) and it is not a healthy Job Hunter '$name'. Stop it, or change the port in infra/.env."
  }
  $out = Join-Path $logDir "$name.log"; $err = Join-Path $logDir "$name.err.log"
  # Launched through cmd.exe with shell redirection (ShellExecute) instead of Start-Process -Redirect*: the redirecting form lets the
  # child inherit this script's own stdout pipe, so a caller that captures our output (CI, a tool, `| tee`) never sees end-of-file.
  $quoted = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $command = '/d /s /c ""' + $file + '" ' + $quoted + ' > "' + $out + '" 2> "' + $err + '""'
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList $command -WorkingDirectory $workdir -WindowStyle Hidden -PassThru
  $state[$name] = $p.Id
  Write-State $state
  Wait-Healthy $name $svc.Url $svc.Bearer
  $real = Port-Owner $port
  if ($real) { $state[$name] = $real; Write-State $state }   # record the process that really holds the port
  Write-Host "      $name healthy on 127.0.0.1:$port (pid $($state[$name]))"
}

function Show-Status {
  $state = Read-State
  $pg = (& docker inspect jobhunter-s1-pg --format '{{.State.Health.Status}}' 2>$null)
  '{0,-8} {1,-6} {2,-8} {3}' -f 'service', 'port', 'pid', 'health'
  '{0,-8} {1,-6} {2,-8} {3}' -f 'postgres', $pgPort, '(docker)', $(if ($pg) { $pg } else { 'not running' })
  foreach ($svc in $services) {
    $owner = Port-Owner $svc.Port
    $ok = if ($owner) { Probe $svc.Url $svc.Bearer } else { $false }
    '{0,-8} {1,-6} {2,-8} {3}' -f $svc.Name, $svc.Port, $(if ($owner) { $owner } else { '-' }), $(if ($ok) { 'healthy' } elseif ($owner) { 'listening but NOT healthy' } else { 'stopped' })
  }
  Write-Host ''
  Write-Host "UI:   http://127.0.0.1:$webPort/"
  Write-Host "API:  http://127.0.0.1:$apiPort/api/v1/healthz"
}

function Stop-All {
  $state = Read-State
  foreach ($name in @('web', 'api', 'ai')) {
    if ($state.ContainsKey($name)) {
      $id = [int]$state[$name]
      if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Tree $id; Write-Host "stopped $name (pid $id)" }
      $state.Remove($name)
    }
  }
  Write-State $state
  # Anything we started but whose recorded pid changed: free the ports only if they still answer as our services.
  if ($StopDb) { & docker compose -f infra/docker-compose.yml --env-file infra/.env stop; Write-Host 'stopped PostgreSQL (data kept in the named volume)' }
}

switch ($Action) {
  'status' { Show-Status }
  'stop' { Stop-All }
  { $_ -in 'start', 'restart' } {
    if ($Action -eq 'restart') { Stop-All }
    Start-Postgres

    Write-Host '[2/5] Database migrations'
    & node node_modules/tsx/dist/cli.mjs src/db/migrate-cli.ts
    if ($LASTEXITCODE -ne 0) { Fail 'Migrations failed.' }

    Write-Host '[3/5] Python AI service'
    $py = Join-Path $root 'services/ai/.venv/Scripts/python.exe'
    if (-not (Test-Path $py)) {
      Write-Host '      creating services/ai/.venv (one time) ...'
      & python -m venv services/ai/.venv
      & $py -m pip install --quiet -r services/ai/requirements.txt
      if ($LASTEXITCODE -ne 0) { Fail 'Installing services/ai/requirements.txt failed.' }
    }
    Start-Service $services[0] $py @('run.py') (Join-Path $root 'services/ai')

    Write-Host '[4/5] TypeScript API (Fastify)'
    Start-Service $services[1] 'node' @('node_modules/tsx/dist/cli.mjs', 'src/api/cli.ts') $root

    Write-Host '[5/5] Astro UI (dev server, proxies /api to the API)'
    if (-not (Test-Path (Join-Path $root 'web/node_modules/astro/bin/astro.mjs'))) { Fail 'web dependencies are missing. Run: npm --prefix web install' }
    Start-Service $services[2] 'node' @('node_modules/astro/bin/astro.mjs', 'dev', '--host', '127.0.0.1', '--port', "$webPort") (Join-Path $root 'web')

    Write-Host ''
    Show-Status
    Write-Host ''
    Write-Host 'Sign in with JH_API_ACCESS_TOKEN from infra/.env.'
  }
}
