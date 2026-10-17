@echo off
REM One-command start for Windows (cmd). In PowerShell use: .\start.ps1
cd /d %~dp0
if not exist .venv ( python -m venv .venv )
.venv\Scripts\python.exe -m pip install -q --upgrade pip
.venv\Scripts\python.exe -m pip install -q -r requirements.txt
if not exist .env ( copy .env.example .env >nul )
.venv\Scripts\python.exe -m nexmind serve %*
