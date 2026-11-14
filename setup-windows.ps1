$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    $lmmsPath = Join-Path $env:ProgramFiles 'LMMS/lmms.exe'
    if (!(Test-Path -LiteralPath $lmmsPath)) {
        winget install --id LMMS.LMMS --exact --version 1.2.2 --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw 'LMMS installation failed' }
    }
    Write-Output "Server: $PSScriptRoot/server.mjs"
    Write-Output "Renderer: $lmmsPath"
} finally {
    Pop-Location
}
