# e2e/run-all.ps1 - One command full-stack QA runner for NexMind
$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " NexMind Full-Stack QA Test Suite Runner" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$tempDataDir = Join-Path ([System.IO.Path]::GetTempPath()) ("nexmind_qa_" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDataDir -Force | Out-Null
Write-Host "Created temp data dir: $tempDataDir" -ForegroundColor Gray

$backendPort = 8000
$frontendPort = 4173

# 1. Build frontend production bundle
Write-Host "`nBuilding frontend production bundle..." -ForegroundColor Yellow
Push-Location (Join-Path $root "frontend")
npm run build
Pop-Location

# 2. Start backend in background if needed
$backendStartedByUs = $false
$healthUrl = "http://127.0.0.1:$backendPort/api/health"
$pyExe = Join-Path $root "backend\.venv\Scripts\python.exe"
if (-not (Test-Path $pyExe)) {
    $pyExe = "python"
}

$backendResponding = $false
try {
    $resp = & $pyExe -c "import urllib.request; print(urllib.request.urlopen('$healthUrl', timeout=2).getcode())" 2>$null
    if ($resp -eq "200") { $backendResponding = $true }
} catch {}

$backendProc = $null
if (-not $backendResponding) {
    Write-Host "Starting backend on port $backendPort with NEXMIND_LLM_PROVIDER=offline..." -ForegroundColor Yellow
    $env:NEXMIND_DATA_DIR = $tempDataDir
    $env:NEXMIND_LLM_PROVIDER = "offline"
    $backendProc = Start-Process -FilePath $pyExe -ArgumentList "-m", "nexmind", "serve", "--port", "$backendPort" -PassThru -NoNewWindow
    $backendStartedByUs = $true
    
    $retries = 20
    while ($retries -gt 0) {
        Start-Sleep -Milliseconds 500
        try {
            $code = & $pyExe -c "import urllib.request; print(urllib.request.urlopen('$healthUrl', timeout=1).getcode())" 2>$null
            if ($code -eq "200") { break }
        } catch {}
        $retries--
    }
} else {
    Write-Host "Backend is already responding on port $backendPort." -ForegroundColor Green
}

# 3. Start frontend preview on port $frontendPort
$previewStartedByUs = $false
$previewProc = $null
$previewResponding = $false
$previewUrl = "http://127.0.0.1:$frontendPort"
try {
    $code = & $pyExe -c "import urllib.request; print(urllib.request.urlopen('$previewUrl', timeout=1).getcode())" 2>$null
    if ($code -eq "200") { $previewResponding = $true }
} catch {}

if (-not $previewResponding) {
    Write-Host "Starting vite preview on port $frontendPort..." -ForegroundColor Yellow
    Push-Location (Join-Path $root "frontend")
    $previewProc = Start-Process -FilePath "npx" -ArgumentList "vite", "preview", "--port", "$frontendPort" -PassThru -NoNewWindow
    Pop-Location
    $previewStartedByUs = $true
    
    $retries = 20
    while ($retries -gt 0) {
        Start-Sleep -Milliseconds 500
        try {
            $code = & $pyExe -c "import urllib.request; print(urllib.request.urlopen('$previewUrl', timeout=1).getcode())" 2>$null
            if ($code -eq "200") { break }
        } catch {}
        $retries--
    }
}

try {
    Write-Host "`n>>> Running Phase 1: Backend pytest suite..." -ForegroundColor Cyan
    Push-Location (Join-Path $root "backend")
    & $pyExe -m pytest tests -q
    if ($LASTEXITCODE -ne 0) { throw "Backend pytest suite failed" }
    Pop-Location

    Write-Host "`n>>> Running Phase 2: Frontend typecheck..." -ForegroundColor Cyan
    Push-Location (Join-Path $root "frontend")
    npm run typecheck
    if ($LASTEXITCODE -ne 0) { throw "Frontend typecheck failed" }

    Write-Host "`n>>> Running Phase 2: Frontend unit & component tests..." -ForegroundColor Cyan
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Frontend vitest failed" }
    Pop-Location

    Write-Host "`n>>> Running Phase 3: Playwright E2E browser tests..." -ForegroundColor Cyan
    Push-Location $root
    $env:VITE_PORT = "$frontendPort"
    $env:NEXMIND_PORT = "$backendPort"
    npx playwright test
    if ($LASTEXITCODE -ne 0) { throw "Playwright E2E tests failed" }
    Pop-Location

    Write-Host "`n==========================================================" -ForegroundColor Green
    Write-Host " ALL TESTS PASSED! (Backend, Frontend, and E2E)" -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
} finally {
    Write-Host "`nCleaning up background processes..." -ForegroundColor Gray
    if ($previewStartedByUs -and $previewProc) {
        Stop-Process -Id $previewProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($backendStartedByUs -and $backendProc) {
        Stop-Process -Id $backendProc.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $tempDataDir) {
        Remove-Item -Path $tempDataDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
