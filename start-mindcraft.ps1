# Double-click 一键启动.bat. This script loads Andy, then Mindcraft.
# When the Mindcraft main process exits, Andy is stopped so the GPU memory is released.
param(
    [ValidateSet('Auto', 'Micro', 'Air', 'Q8')]
    [string]$Model = 'Auto',
    [switch]$NativeTools,
    [switch]$Installed
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = Join-Path $Root 'runtime\node-v22.23.3-win-x64\node.exe'
$CudaLlama = Join-Path $Root 'runtime\llama\bin\llama-server.exe'
$RocmLlama = Join-Path $Root 'runtime\llama-rocm\llama-server.exe'
$AppDir = Join-Path $Root 'mindcraft-agent-system'
$LiveLog = Join-Path $Root 'runtime\live-log.cjs'
$Models = @{
    Micro = @{ File = 'Andy-4.2-Micro-Q4_K_M.gguf'; Alias = 'andy-4.2-micro-q4'; Label = 'Andy 4.2 Micro Q4' }
    Air = @{ File = 'Andy-4.2-Air-Q4_K_M.gguf'; Alias = 'andy-4.2-air-q4'; Label = 'Andy 4.2 Air Q4' }
    Q8 = @{ File = 'Andy-4.2-Q8_0.gguf'; Alias = 'andy-4.2-q8-reference'; Label = 'Andy 4.2 9B Q8' }
    Native = @{ File = 'Andy-4.20-Q4_K_M.gguf'; Alias = 'andy-4.20'; Label = 'Andy 4.20 Q4' }
}
. (Join-Path $Root 'runtime\andy-model-selection.ps1')

$ModelPort = if ($NativeTools) { 1234 } else { 1235 }
$ModelUrl = "http://127.0.0.1:$ModelPort"
$ContextSize = if ($NativeTools) { 131072 } else { 32000 }
$ReasoningBudget = if ($NativeTools) { 768 } else { 8192 }

$script:JobHandle = [IntPtr]::Zero
$script:LlamaProc = $null

function Finish([string]$Message, [int]$Code = 0) {
    if ($Message) { Write-Host $Message }
    exit $Code
}

if (-not (Test-Path -LiteralPath $Node)) { Finish "找不到 Node：$Node" 1 }
if ($NativeTools -and $Model -ne 'Auto') { Finish '-NativeTools 使用 Andy 4.20，请单独使用该选项。' 1 }

if (-not $NativeTools -and -not $PSBoundParameters.ContainsKey('Model')) {
    $choiceFile = Join-Path $AppDir 'server_data\andy-model-choice.json'
    if (Test-Path -LiteralPath $choiceFile) {
        try {
            $saved = (Get-Content -LiteralPath $choiceFile -Raw -Encoding UTF8 | ConvertFrom-Json).model
            if ($saved -is [string] -and $saved -cin @('Micro', 'Air', 'Q8')) {
                $Model = $saved
                Write-Host "使用角色卡已保存的模型：$($Models[$Model].Label)。"
            }
        } catch {
            Write-Warning '无法读取角色卡的模型选择，使用自动模式。'
        }
    }
}

foreach ($port in @($ModelPort, 8080)) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    $listener.ExclusiveAddressUse = $true
    try {
        $listener.Start()
    } catch {
        Finish "无法绑定本地端口 ${port}：$($_.Exception.GetBaseException().Message)" 1
    } finally {
        $listener.Stop()
    }
}

# ROCm binaries are bundled locally; avoid an incompatible machine-level LLVM_PATH override.
Remove-Item Env:LLVM_PATH -ErrorAction SilentlyContinue
$gpus = @(Get-LlamaGpu $CudaLlama; Get-LlamaGpu $RocmLlama)
$gpu = $gpus | Sort-Object -Property FreeMiB -Descending | Select-Object -First 1
$auto = -not $NativeTools -and $Model -eq 'Auto'
if ($NativeTools -and -not $gpu) { Finish '项目内置的 llama.cpp 未检测到可用的 CUDA 或 ROCm GPU。' 1 }
if ($auto -and $gpu.TotalMiB -gt 0 -and $gpu.FreeMiB -lt 2048) { $gpu = $null }

if ($gpu) {
    $Llama = $gpu.Executable
    $Device = $gpu.Id
    $GpuLayers = 999
    Write-Host "$($gpu.Name) ($Device)，空闲显存 $($gpu.FreeMiB) MiB / $($gpu.TotalMiB) MiB。"
} else {
    $Llama = $CudaLlama
    if (-not (Test-Path -LiteralPath $Llama)) { $Llama = $RocmLlama }
    if (-not (Test-Path -LiteralPath $Llama)) { Finish '找不到项目内置的 llama-server。' 1 }
    $Device = 'none'
    $GpuLayers = 0
    Write-Host '没有足够的可用显存，使用 CPU 推理。'
}
$LlamaDir = Split-Path -Parent $Llama

if ($NativeTools) {
    $candidates = @('Native')
} elseif ($auto) {
    $available = @('Micro', 'Air', 'Q8') | Where-Object {
        Test-Path -LiteralPath (Join-Path $Root "models\$($Models[$_].File)") -PathType Leaf
    }
    if (-not $available) { Finish '找不到已安装的 Andy 4.2 模型。' 1 }
    $tokensPerSecond = 0
    if ($gpu.FreeMiB -ge 5120 -and 'Micro' -in $available) {
        Write-Host '正在短测显卡生成速度，以选择 Andy 版本...'
        $microPath = Join-Path $Root "models\$($Models.Micro.File)"
        $tokensPerSecond = Measure-AndyDecode $gpu $microPath
        if ($tokensPerSecond -gt 0) { Write-Host ('Micro 实测 {0:N1} token/s。' -f $tokensPerSecond) }
    }
    $candidates = @(Get-AndyAutoOrder $gpu.FreeMiB $tokensPerSecond | Where-Object { $_ -in $available })
    if (-not $candidates) { $candidates = @($available) }
} else {
    $candidates = @($Model)
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class MindcraftJob {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    public static IntPtr CreateKillOnCloseJob() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        ExtendedLimits info = new ExtendedLimits();
        info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int size = Marshal.SizeOf(typeof(ExtendedLimits));
        IntPtr ptr = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(job, 9, ptr, (uint)size)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
        } finally {
            Marshal.FreeHGlobal(ptr);
        }
        return job;
    }
}
'@

function Add-ToJob([System.Diagnostics.Process]$Process) {
    $ok = [MindcraftJob]::AssignProcessToJobObject($script:JobHandle, $Process.Handle)
    if (-not $ok) {
        throw (New-Object System.ComponentModel.Win32Exception)
    }
}

function Stop-Andy {
    $proc = $script:LlamaProc
    if (-not $proc) { return }
    try { $proc.Refresh() } catch {}
    if ($proc.HasExited) { return }
    Write-Host '正在停止 Andy 推理服务...'
    & taskkill.exe /PID $proc.Id /T /F *> $null
    try { [void]$proc.WaitForExit(15000) } catch {}
    try { $proc.Refresh() } catch {}
    if ($proc.HasExited) {
        Write-Host 'Andy 推理服务已退出。'
    } else {
        Write-Host 'Andy 进程还在，请在任务管理器里结束 llama-server.exe。'
    }
}

function Start-Andy($Choice) {
    $modelPath = Join-Path $Root "models\$($Choice.File)"
    if (-not (Test-Path -LiteralPath $modelPath)) { throw "找不到模型：$modelPath" }
    Write-Host "正在加载 $($Choice.Label)..."
    $llamaArgs = @(
        '--host', '127.0.0.1',
        '--port', $ModelPort,
        '-m', ('"{0}"' -f $modelPath),
        '--ctx-size', $ContextSize,
        '--parallel', '1',
        '--cache-type-k', 'q8_0',
        '--cache-type-v', 'q8_0',
        '--device', $Device,
        '--gpu-layers', $GpuLayers,
        '--flash-attn', 'on',
        '--jinja',
        '--reasoning-budget', $ReasoningBudget,
        '--alias', $Choice.Alias
    )
    if ($NativeTools) {
        $llamaArgs += @('--temp', '0.6', '--top-p', '0.95', '--min-p', '0', '--repeat-penalty', '1.0')
    }
    if ($Llama -eq $RocmLlama -or $GpuLayers -eq 0) { $llamaArgs += @('--fit', 'off') }
    $llamaOut = Join-Path $Root "runtime\llama\$($Choice.Alias).out.log"
    $llamaErr = Join-Path $Root "runtime\llama\$($Choice.Alias).err.log"
    $redirect = @{}
    $logHint = ''
    if (-not $Installed) {
        $redirect = @{ RedirectStandardOutput = $llamaOut; RedirectStandardError = $llamaErr }
        $logHint = " 日志：$llamaErr"
    }
    $script:LlamaProc = Start-Process -FilePath $Llama -ArgumentList $llamaArgs -WorkingDirectory $LlamaDir -WindowStyle Hidden -PassThru @redirect
    Add-ToJob $script:LlamaProc

    $ready = $false
    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $deadline) {
        $script:LlamaProc.Refresh()
        if ($script:LlamaProc.HasExited) {
            throw "llama-server 启动失败，退出码 $($script:LlamaProc.ExitCode)。$logHint"
        }
        try {
            $health = Invoke-RestMethod -Uri "$ModelUrl/health" -TimeoutSec 2
            $models = Invoke-RestMethod -Uri "$ModelUrl/v1/models" -TimeoutSec 2
            if ($health.status -eq 'ok' -and $models.data.id -contains $Choice.Alias) {
                $ready = $true
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (-not $ready) {
        throw "等待 Andy 载入超时（5 分钟）。$logHint"
    }
}

$failed = $false
$failMessage = ''
try {
    $script:JobHandle = [MindcraftJob]::CreateKillOnCloseJob()
    $selected = $null
    foreach ($candidate in $candidates) {
        $choice = $Models[$candidate]
        try {
            Start-Andy $choice
            $selected = $choice
            break
        } catch {
            Stop-Andy
            if ($script:LlamaProc -and -not $script:LlamaProc.HasExited) { throw }
            $script:LlamaProc = $null
            if ($candidate -eq $candidates[-1]) { throw }
            Write-Warning "$($choice.Label) 加载失败，尝试较小的模型。$($_.Exception.Message)"
        }
    }
    Write-Host "$($selected.Label) 已就绪。正在启动 Mindcraft..."

    $mindInfo = New-Object System.Diagnostics.ProcessStartInfo
    $mindInfo.FileName = $Node
    $mindInfo.Arguments = if ($NativeTools) { 'main.js --profiles ./andy.json' } else { 'main.js --profiles ./andy-reference.json' }
    $mindInfo.WorkingDirectory = $AppDir
    $mindInfo.UseShellExecute = $false
    $mindInfo.EnvironmentVariables['NODE_OPTIONS'] = '--require "{0}"' -f $LiveLog.Replace('\', '/')
    if (-not $NativeTools) {
        $mindInfo.EnvironmentVariables['MAX_MESSAGES'] = '65'
        $mindInfo.EnvironmentVariables['MINDCRAFT_BUILTIN_ANDY42'] = $selected.Alias
    }
    if ($Installed) {
        $mindInfo.EnvironmentVariables['MINDCRAFT_START_IDLE'] = '1'
        foreach ($name in @('PROFILES', 'SETTINGS_JSON', 'MINECRAFT_PORT', 'MINDSERVER_PORT', 'LOG_ALL')) {
            $mindInfo.EnvironmentVariables.Remove($name)
        }
    }
    $mind = [System.Diagnostics.Process]::Start($mindInfo)
    Add-ToJob $mind
    $console = 'http://127.0.0.1:8080'
    $openDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $openDeadline) {
        $mind.Refresh()
        if ($mind.HasExited) { break }
        try {
            $ping = Invoke-WebRequest -Uri $console -UseBasicParsing -TimeoutSec 2
            if ($ping.StatusCode -eq 200) {
                Start-Process $console
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 400
    }
    Write-Host "控制台：$console"
    Write-Host '关掉这个窗口，或在控制台里结束 Mindcraft，Andy 推理服务会随之退出。'
    [void]$mind.WaitForExit()
    if ($mind.ExitCode -ne 0) { throw "Mindcraft 异常退出，代码 $($mind.ExitCode)。" }
    Write-Host 'Mindcraft 已退出。'
} catch {
    $failed = $true
    $failMessage = $_.Exception.Message
} finally {
    Stop-Andy
    if ($script:JobHandle -ne [IntPtr]::Zero) {
        [void][MindcraftJob]::CloseHandle($script:JobHandle)
        $script:JobHandle = [IntPtr]::Zero
    }
}

if ($failed) { Finish "启动失败：$failMessage" 1 }
Finish '可以关闭这个窗口了。' 0
