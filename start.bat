@echo off
chcp 65001 >nul
title API Hub - Relay Aggregator
cd /d "%~dp0"

set "PYEXE="
where python >nul 2>nul && set "PYEXE=python"
if not defined PYEXE where py >nul 2>nul && set "PYEXE=py -3"

if not defined PYEXE (
  echo.
  echo  [!] Python not found. Please install Python 3.8+ and try again.
  echo      https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

echo Starting API Hub ...
%PYEXE% server.py
if errorlevel 1 pause
