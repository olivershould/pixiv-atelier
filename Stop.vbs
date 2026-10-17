Option Explicit
Dim shell, files, root, command, status, message, stream
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = Quote(shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")) & " -NoProfile -ExecutionPolicy Bypass -File " & Quote(root & "\Stop.ps1")
status = shell.Run(command, 0, True)
If status <> 0 Then
    message = "Atelier could not stop safely. Wait for posting or data collection to finish, then retry."
    If files.FileExists(root & "\launcher-stop-error.log") Then
        Set stream = CreateObject("ADODB.Stream")
        stream.Type = 2
        stream.Charset = "utf-8"
        stream.Open
        stream.LoadFromFile root & "\launcher-stop-error.log"
        message = stream.ReadText
        stream.Close
    End If
    shell.Popup message, 0, "Atelier", 16
Else
    shell.Popup "Atelier is stopped, or no launcher-managed service was running. Your saved data is preserved.", 6, "Atelier", 64
End If
WScript.Quit status
Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
