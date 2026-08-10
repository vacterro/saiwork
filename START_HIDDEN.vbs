Set objFSO = CreateObject("Scripting.FileSystemObject")
strPath = objFSO.GetParentFolderName(WScript.ScriptFullName)

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = strPath

' Run the development launcher without a console; keep diagnostics in dev.log.
' A phantom handle on dev.log (leaked by a killed dev chain) makes the "> dev.log"
' redirect error, which silently kills the hidden cmd before npm ever starts.
' Detect the lock first and fall back to a timestamped log instead.
strLog = "dev.log"
strStamp = Year(Now) & "-" & Right("0" & Month(Now), 2) & "-" & Right("0" & Day(Now), 2) & "-" & Hour(Now) & Right("0" & Minute(Now), 2) & Right("0" & Second(Now), 2)

If objFSO.FileExists(strLog) Then
  On Error Resume Next
  Set objStream = objFSO.OpenTextFile(strLog, 8, False) ' 8 = ForAppending, no create
  If Err.Number <> 0 Then
    ' dev.log is locked by another process; log elsewhere so startup is not lost.
    strLog = "dev-" & strStamp & ".log"
  Else
    objStream.Close
  End If
  On Error GoTo 0
End If

strCommand = WshShell.ExpandEnvironmentStrings("%ComSpec%") & " /d /s /c ""set SAIWORK_HIDDEN=1&& call START.bat > """ & strLog & """ 2>&1"""
WshShell.Run strCommand, 0, False
