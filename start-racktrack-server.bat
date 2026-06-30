@echo off
setlocal
set "NODE=C:\Users\subra\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
cd /d "%~dp0"
echo Starting EMC RackTrack online server...
echo.
echo Keep this window open while your team is using the app.
echo Local link: http://127.0.0.1:8080/
echo Network link: use http://YOUR-COMPUTER-IP:8080/ from phones on the same Wi-Fi/LAN.
echo.
"%NODE%" server.js
