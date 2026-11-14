//! Read-only handle-based scope spelling, matching the native helper's canonicalize.
pub(in super::super) fn scope_script(path: &str) -> String {
    let path = path.replace('\'', "''");
    format!(
        r#"$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class TunneldeReadOnlyScope {{
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
}}
'@
$file=[TunneldeReadOnlyScope]::CreateFileW('{path}',128,7,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
if ($file.IsInvalid) {{ $file.Dispose(); throw 'Cannot inspect the native folder' }}
try {{
    $buffer=[Text.StringBuilder]::new(8193)
    $length=[TunneldeReadOnlyScope]::GetFinalPathNameByHandleW($file,$buffer,8193,0)
    if ($length -eq 0 -or $length -ge 8193) {{ throw 'Cannot resolve the native folder' }}
    [Console]::Write($buffer.ToString())
}} finally {{ $file.Dispose() }}"#
    )
}
