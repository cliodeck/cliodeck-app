@echo off
rem cliodeck-mcp.cmd — Windows counterpart of bin/cliodeck-mcp.
rem
rem Same reason for existing: the CLI must run under Electron's embedded Node
rem (ELECTRON_RUN_AS_NODE=1) so the better-sqlite3 ABI matches. Handles the two
rem layouts the shell script handles — a git checkout and an installed app,
rem where this file sits in resources\bin and the executable one level up.
setlocal
set "ROOT=%~dp0.."
set "CLI_REL=dist\backend\mcp-server\cli.js"

if exist "%ROOT%\node_modules\.bin\electron.cmd" (
  set "ELECTRON_BIN=%ROOT%\node_modules\.bin\electron.cmd"
  set "CLI_JS=%ROOT%\%CLI_REL%"
) else (
  set "ELECTRON_BIN=%ROOT%\..\ClioDeck.exe"
  set "CLI_JS=%ROOT%\app.asar\%CLI_REL%"
)

if not exist "%ELECTRON_BIN%" (
  echo [cliodeck-mcp] ClioDeck executable not found at %ELECTRON_BIN% 1>&2
  exit /b 2
)

set ELECTRON_RUN_AS_NODE=1
"%ELECTRON_BIN%" "%CLI_JS%" %*
