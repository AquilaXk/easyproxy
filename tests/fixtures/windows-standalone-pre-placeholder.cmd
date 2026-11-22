if exist "%EPX_API_TOKEN_FILE%" (
  set /p EASYPROXY_API_AUTH_TOKEN=<"%EPX_API_TOKEN_FILE%"
)
:loop
>>"%EPX_SERVICE_LOG%" echo [%DATE% %TIME%] easyproxy service wrapper start
>>"%EPX_SERVICE_LOG%" echo bun="%EPX_BUN%"
>>"%EPX_SERVICE_LOG%" echo bun_source="standalone"
>>"%EPX_SERVICE_LOG%" echo cli="%EPX_CLI%"
>>"%EPX_SERVICE_LOG%" echo easyproxy_home="%EASYPROXY_HOME%"
>>"%EPX_SERVICE_LOG%" echo codex_home="%CODEX_HOME%"
>>"%EPX_SERVICE_LOG%" echo token_file="%EPX_API_TOKEN_FILE%"
if not exist "%EPX_BUN%" (
  call :restore_backup
)
if not exist "%EPX_BUN%" goto bun_missing
"%EPX_BUN%" start --port 10100 >>"%EPX_SERVICE_LOG%" 2>&1
if "%ERRORLEVEL%"=="42" goto stopped
>>"%EPX_SERVICE_LOG%" echo [%DATE% %TIME%] child exited with code %ERRORLEVEL%; restarting in 5s
ping -n 6 127.0.0.1 >nul
goto loop
:stopped
endlocal
exit /b 0
:bun_missing
>>"%EPX_SERVICE_LOG%" echo [%DATE% %TIME%] installation is incomplete: bundled Bun is missing; reinstall easyproxy, then run epx service repair
exit /b 3
:restore_backup
>>"%EPX_SERVICE_LOG%" echo [%DATE% %TIME%] install incomplete - looking for a transactional-update backup to restore
for /f "delims=" %%B in ('dir /b /ad /o-n "%EPX_PKG_DIR%\..\.epx-backup-*" 2^>nul') do (
  if exist "%EPX_PKG_DIR%\..\%%B\easyproxy\package.json" (
    if exist "%EPX_PKG_DIR%" rmdir /s /q "%EPX_PKG_DIR%" 2>nul
    move "%EPX_PKG_DIR%\..\%%B\easyproxy" "%EPX_PKG_DIR%" >nul 2>&1
    if exist "%EPX_PKG_DIR%\package.json" (
      set "EPX_RESTORED_BACKUP=%%B"
      goto backup_restored
    )
  )
)
>>"%EPX_SERVICE_LOG%" echo [%DATE% %TIME%] no restorable backup found
goto :eof
:backup_restored
>>"%EPX_SERVICE_LOG%" echo [%DATE% %TIME%] restored previous install from %EPX_RESTORED_BACKUP%
goto :eof
