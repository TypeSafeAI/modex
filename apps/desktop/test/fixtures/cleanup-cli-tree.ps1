param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$failures = [System.Collections.Generic.List[string]]::new()
foreach ($receipt in Get-ChildItem -LiteralPath $Directory -Filter '*.pid') {
    $ownedProcess = $null
    $ownedProcessId = $null
    try {
        $text = [System.IO.File]::ReadAllText($receipt.FullName).Trim()
        if ($text -notmatch '^[1-9][0-9]*$') { throw 'Invalid fixture process receipt' }
        $ownedProcessId = [int]$text
        try { $ownedProcess = [System.Diagnostics.Process]::GetProcessById($ownedProcessId) }
        catch [System.ArgumentException] { continue }
        # Retain a handle before validating the command line so PID reuse cannot
        # redirect Kill to a later unrelated process.
        $null = $ownedProcess.Handle
        if ($ownedProcess.HasExited) { continue }
        $details = Get-CimInstance Win32_Process -Filter "ProcessId = $ownedProcessId"
        if ($ownedProcess.HasExited) { continue }
        if (-not $details.CommandLine -or -not $details.CommandLine.Contains($Directory)) {
            throw "Refusing to clean process without this fixture's command line: $ownedProcessId"
        }
        $ownedProcess.Kill()
        if (-not $ownedProcess.WaitForExit(1000)) { throw 'Fixture process did not exit' }
    } catch {
        $failure = $_
        # Supervisor shutdown can concurrently remove any descendant. Ignore an
        # exception only after confirming exit; never let one PID skip the others.
        $exited = $false
        if ($null -ne $ownedProcess) {
            try { $exited = $ownedProcess.HasExited } catch {}
        }
        if (-not $exited -and $null -ne $ownedProcessId) {
            try {
                $remaining = [System.Diagnostics.Process]::GetProcessById($ownedProcessId)
                $remaining.Dispose()
            } catch [System.ArgumentException] { $exited = $true }
            catch {} # Preserve the original failure when exit cannot be proven.
        }
        if (-not $exited) { $failures.Add("$($receipt.Name): $failure") }
    } finally {
        if ($null -ne $ownedProcess) { $ownedProcess.Dispose() }
    }
}
if ($failures.Count) { throw ($failures -join [Environment]::NewLine) }
