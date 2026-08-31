@echo off
setlocal
if not exist .env (
  echo Le fichier .env est absent. Copiez .env.example vers .env et renseignez OPENAI_API_KEY et DATABASE_URL.
  pause
  exit /b 1
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ est requis.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installation des dependances...
  call npm install
)
call npm start
pause
