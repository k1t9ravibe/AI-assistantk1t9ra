@echo off
rem VS Code sets ELECTRON_RUN_AS_NODE, which stops Electron from opening a window.
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
