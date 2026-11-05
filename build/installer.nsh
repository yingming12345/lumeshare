; LumeShare 安装器自定义脚本
; 功能：
;   1) 系统校验：仅允许 Windows 10 及以上系统安装（不支持 Windows 7 / 8 / 8.1）
;   2) 安装前检测目标位置（以及注册表中的历史安装记录）是否已安装本应用，
;      若已安装则先静默卸载旧版本，再继续安装新版本
; 说明：UID 验证已移至应用首次启动时进行（验证信息存储在系统盘，更新/重装无需再次验证）

!include LogicLib.nsh
!include WinVer.nsh

!macro customInit
  ; ---------- 系统校验 ----------
  ; 仅支持 Windows 10 及以上：Win10/11 在注册表中存在 CurrentMajorVersionNumber 且 >= 10
  StrCpy $0 ""
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentMajorVersionNumber"
  StrCmp $0 "" lbl_need_win10_install
  IntCmp $0 10 lbl_win10_ok_install lbl_need_win10_install lbl_win10_ok_install
  lbl_win10_ok_install:
    Goto lbl_sys_checked_install
  lbl_need_win10_install:
    MessageBox MB_OK|MB_ICONSTOP|MB_SETFOREGROUND "LumeShare 需要 Windows 10 及以上系统，当前系统版本过低，无法安装。" /SD IDOK
    Abort
  lbl_sys_checked_install:

  ; ---------- 先卸载旧版本 ----------
  !insertmacro uninstallExistingInDir
  !insertmacro uninstallFromRegistry
!macroend

!macro uninstallExistingInDir
  !define uid ${__LINE__}
  IfFileExists "$INSTDIR\Uninstall LumeShare.exe" 0 lbl_noOld_${uid}
    DetailPrint "检测到目标位置已安装 LumeShare，正在卸载旧版本…"
    ExecWait '"$INSTDIR\Uninstall LumeShare.exe" /S _?=$INSTDIR'
  lbl_noOld_${uid}:
  !undef uid
!macroend

!macro uninstallFromRegistry
  !define uid ${__LINE__}
  ; 枚举当前用户卸载项，按名称前缀匹配旧版本（DisplayName 形如 "LumeShare 1.0.1"）
  StrCpy $0 0
  lbl_loop_${uid}:
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" lbl_done_${uid}
    IntOp $0 $0 + 1
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    StrCpy $4 $2 9
    StrCmp $4 "LumeShare" 0 lbl_loop_${uid}
    ReadRegStr $3 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    StrCmp $3 "" lbl_loop_${uid} 0
    DetailPrint "检测到旧版本安装记录，正在卸载…"
    ExecWait '$3 /S'
    Goto lbl_done_${uid}
  lbl_done_${uid}:
  !undef uid
!macroend
