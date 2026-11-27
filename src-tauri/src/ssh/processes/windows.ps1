$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::InvariantCulture
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
    $owners = @{}
    # IncludeUserName may require elevation; identities and counters do not depend on it.
    try { Get-Process -IncludeUserName -ErrorAction SilentlyContinue | ForEach-Object { $owners[[int]$_.Id] = $_.UserName } } catch {}
    $items = @(Get-CimInstance Win32_Process | ForEach-Object {
        $p = $_
        $start = $null
        if ($null -ne $p.CreationDate) { $start = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }
        $cpu = $null
        if ($null -ne $p.KernelModeTime -and $null -ne $p.UserModeTime) {
            $cpu = [uint64]([decimal]::Truncate(([decimal]$p.KernelModeTime + [decimal]$p.UserModeTime) / 10000))
        }
        @{
            pid = [uint32]$p.ProcessId; name = $p.Name; rss = [uint64]$p.WorkingSetSize
            parentPid = [uint32]$p.ParentProcessId; threads = [uint32]$p.ThreadCount
            userName = $owners[[int]$p.ProcessId]; start = $start; cpu = $cpu
            read = $p.ReadTransferCount; written = $p.WriteTransferCount
        }
    })
    $snapshot = @{ cores = [uint32]$cores; memory = [uint64]$os.TotalVisibleMemorySize * 1024; items = $items }
    [Console]::WriteLine('#process-windows')
    [Console]::WriteLine((ConvertTo-Json -InputObject $snapshot -Depth 4 -Compress))
} catch {
    [Console]::WriteLine('monitor.processUnsupported')
    exit 1
}
