$ErrorActionPreference = "Stop"

try {
  Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" |
    Where-Object { $_.CommandLine -like "*proxypool_service*" } |
    ForEach-Object {
      Write-Host ("Stopping ProxyPool Python sidecar PID " + $_.ProcessId)
      Stop-Process -Id $_.ProcessId -Force
    }
} catch {
  Write-Host ("ProxyPool cleanup skipped: " + $_.Exception.Message)
}
