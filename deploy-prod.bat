@echo off
chcp 65001 >nul
rem Ручной запуск прод-деплоя владельцем (git-only). Агенту запуск запрещён.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-prod.ps1"
pause
