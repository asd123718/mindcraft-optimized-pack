function Invoke-LlamaProbe([string]$Executable, [string]$Arguments, [int]$TimeoutMs) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Executable
    $startInfo.Arguments = $Arguments
    $startInfo.WorkingDirectory = Split-Path -Parent $Executable
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $proc = [System.Diagnostics.Process]::Start($startInfo)
    try {
        $stdout = $proc.StandardOutput.ReadToEndAsync()
        $stderr = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit($TimeoutMs)) {
            $proc.Kill()
            $proc.WaitForExit()
            throw "$Executable probe timed out."
        }
        if ($proc.ExitCode -ne 0) { throw "$Executable probe exited with code $($proc.ExitCode)." }
        return @{ Output = $stdout.Result; Errors = $stderr.Result }
    } finally {
        $proc.Dispose()
    }
}

function Get-LlamaGpu([string]$Executable) {
    if (-not (Test-Path -LiteralPath $Executable)) { return }
    try {
        $result = Invoke-LlamaProbe $Executable '--list-devices' 10000
        foreach ($line in ($result.Output + "`n" + $result.Errors) -split '\r?\n') {
            if ($line -match '^\s*(?<id>CUDA\d+|ROCm\d+):\s*(?<name>.+?)\s*\((?<total>\d+) MiB, (?<free>\d+) MiB free\)\s*$') {
                [pscustomobject]@{
                    Executable = $Executable
                    Id = $Matches.id
                    Name = $Matches.name
                    TotalMiB = [int]$Matches.total
                    FreeMiB = [int]$Matches.free
                }
            }
        }
    } catch {
        Write-Warning $_.Exception.Message
    }
}

function Measure-AndyDecode($Gpu, [string]$MicroPath) {
    $bench = Join-Path (Split-Path -Parent $Gpu.Executable) 'llama-bench.exe'
    if (-not ((Test-Path -LiteralPath $bench) -and (Test-Path -LiteralPath $MicroPath))) { return 0 }
    try {
        $arguments = '-m "{0}" -p 0 -n 32 -r 1 -ngl 999 -dev {1} -fa on -o json' -f $MicroPath, $Gpu.Id
        $result = Invoke-LlamaProbe $bench $arguments 20000
        $sample = ConvertFrom-Json -InputObject $result.Output
        return [double]$sample[0].avg_ts
    } catch {
        Write-Warning $_.Exception.Message
        return 0
    }
}

function Get-AndyAutoOrder([int]$FreeMiB, [double]$TokensPerSecond) {
    # Reserve memory for the 32k context, compute buffers and desktop/game usage.
    # Short Micro decode is a proxy for GPU throughput; thresholds are empirical policy.
    if ($FreeMiB -ge 12288 -and $TokensPerSecond -ge 120) { 'Q8' }
    if ($FreeMiB -ge 5120 -and $TokensPerSecond -ge 45) { 'Air' }
    'Micro'
}
