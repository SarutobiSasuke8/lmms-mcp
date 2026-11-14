param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'lmms-mcp/vst3-v1'),
    [string]$Python = 'py'
)
$ErrorActionPreference = 'Stop'
$directory = [IO.Path]::GetFullPath($InstallDirectory)
New-Item -ItemType Directory -Path $directory | Out-Null

$downloads = @(
    @{
        Name = 'decent'
        Url = 'https://cdn.decentsamples.com/production/builds/ds/1.42.1/Decent_Sampler-1.42.1-Windows-No-Installer.zip'
        Hash = 'A91C3D06A1ADD73263B92781E015C86F6C554EC1A869E22A873CA1BB1C6CC056'
        Binary = 'DecentSampler/64-bit/VST3/DecentSampler.vst3/Contents/x86_64-win/DecentSampler.vst3'
    },
    @{
        Name = 'surge'
        Url = 'https://github.com/surge-synthesizer/releases-xt/releases/download/1.3.4/surge-xt-win64-1.3.4-pluginsonly.zip'
        Hash = '564E162C560AF07AD4ED47FE1BFCD827CF97A575DE30D06C48249AAD2E7C35E6'
        Binary = 'Surge XT.vst3/Contents/x86_64-win/Surge XT.vst3'
    }
)
$plugins = @{}
foreach ($download in $downloads) {
    $archive = Join-Path $directory ($download.Name + '.zip')
    Invoke-WebRequest -Uri $download.Url -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $download.Hash) {
        throw "Unexpected SHA-256 for $($download.Name)"
    }
    $destination = Join-Path $directory $download.Name
    Expand-Archive -LiteralPath $archive -DestinationPath $destination
    $binary = Join-Path $destination $download.Binary
    if (!(Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Missing plugin binary: $binary" }
    $plugins[$download.Name] = $binary
    Remove-Item -LiteralPath $archive
}
$venv = Join-Path $directory 'venv'
if ($Python -eq 'py') { & $Python -3.12 -m venv $venv } else { & $Python -m venv $venv }
if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment setup failed' }
$pythonExe = Join-Path $venv 'Scripts/python.exe'
& $pythonExe -m pip install --disable-pip-version-check pedalboard==0.9.26 mido==1.3.3
if ($LASTEXITCODE -ne 0) { throw 'VST3 host dependency installation failed' }

$settings = [ordered]@{
    LMMS_VST3_PYTHON = $pythonExe
    LMMS_DECENT_SAMPLER_VST3 = $plugins.decent
    LMMS_SURGE_XT_VST3 = $plugins.surge
}
$config = Join-Path $directory 'mcp-env.json'
$settings | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8
Write-Output "Copy the environment settings from $config into your MCP client's server configuration."
