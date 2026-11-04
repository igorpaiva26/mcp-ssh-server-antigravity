@echo off
setlocal
chcp 65001 >nul

echo =======================================================
echo   🚀 MCP SSH Server - Instalador e Verificador
echo =======================================================
echo.

:: 1. Verifica se o Node.js está instalado
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERRO] Node.js não foi encontrado no sistema!
    echo.
    echo Por favor, instale o Node.js versão 18 ou superior:
    echo 👉 https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Exibe versão do Node
for /f "tokens=*" %%i in ('node -v') do set NODE_VERSION=%%i
echo [OK] Node.js detectado: %NODE_VERSION%

:: 2. Instala dependencias via npm
echo.
echo [1/2] Instalando dependencias do projeto (npm install)...
call npm install
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERRO] Falha ao instalar dependencias com npm.
    pause
    exit /b 1
)

:: 3. Roda a suite de testes para validar
echo.
echo [2/2] Validando instalacao e rotinas de seguranca (npm test)...
call npm test
if %ERRORLEVEL% neq 0 (
    echo.
    echo [AVISO] Alguns testes falharam. Verifique os erros acima.
    pause
    exit /b 1
)

echo.
echo =======================================================
echo   🎉 Tudo pronto! Servidor MCP configurado com sucesso.
echo =======================================================
echo.
echo Para registrar este MCP no seu Antigravity / Claude / VS Code:
echo Copie o caminho deste arquivo index.js:
echo %~dp0src\index.js
echo.
pause
