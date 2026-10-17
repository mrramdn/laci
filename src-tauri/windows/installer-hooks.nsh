; Tauri's NSIS installer runs these macros before and after it installs or uninstalls Laci. They stay
; empty until the Windows packaging work (M5) fills them: renaming a running bin\laci.exe so an update
; doesn't stop agents' MCP servers, the user PATH entry for bin, and a confirmation before the
; uninstaller's "Delete app data" box removes Laci's Undo records.

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
