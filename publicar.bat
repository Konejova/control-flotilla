@echo off
cd /d "%~dp0"
echo ============================================
echo   Publicando cambios a GitHub...
echo ============================================
git add -A
git commit -m "Actualizacion %date% %time%"
git push origin main
echo.
echo ============================================
echo   Listo. Revisa arriba si hubo algun error.
echo ============================================
pause
