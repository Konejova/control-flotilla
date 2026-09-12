@echo off
cd /d "%~dp0"
echo ============================================
echo   Copiando datos de PRODUCCION a tu local...
echo ============================================
node copiar-produccion-a-local.js
echo.
echo ============================================
echo   Listo. Revisa arriba si hubo algun error.
echo ============================================
pause
