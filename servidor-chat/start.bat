@echo off
:: --- CONFIGURACIÓN DE LA VENTANA ---
title HYPR-CHAT SERVER CONSOLE
:: Color 0D es Fondo Negro (0) y Texto Magenta Claro (D)
:: Color 0B es Fondo Negro (0) y Texto Aqua (B)
:: Puedes probar 'color 05' (Morado) o 'color 03' (Cian)
color 0B
mode con: cols=140 lines=40

:: --- LIMPIEZA E INICIO ---
cls
echo.
echo  INITIATING BOOT SEQUENCE...
echo.

:: Ejecutamos el servidor
node server.js

:: Si el servidor se cierra o da error, el 'pause' evita que la ventana se cierre sola
:: para que puedas leer el error.
echo.
echo  [SYSTEM HALTED]
pause