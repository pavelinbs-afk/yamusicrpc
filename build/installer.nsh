; Хук electron-builder (NSIS): ставим мост сразу после копирования файлов.
; Если Яндекс.Музыка ещё не установлена — код выхода игнорируем (мост встанет при первом запуске RPC).

!macro customInstall
  DetailPrint "Установка моста в клиент Яндекс.Музыки..."
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --install-client-bridge'
  Pop $0
  DetailPrint "Мост: код завершения $0 (0 = ок; иначе повторится при запуске приложения)"
!macroend
