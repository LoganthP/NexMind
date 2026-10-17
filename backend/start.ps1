# One-command start for Windows PowerShell:  powershell -ExecutionPolicy Bypass -File .\start.ps1
# (No "&&" and no venv activation needed, so it works in Windows PowerShell 5 and PowerShell 7.)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path ".venv")) { python -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install -q --upgrade pip
& .\.venv\Scripts\python.exe -m pip install -q -r requirements.txt
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" }
& .\.venv\Scripts\python.exe -m nexmind serve @args
