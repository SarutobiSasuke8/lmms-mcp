# Fetch open SFZ sample libraries for the Decent Sampler route (see docs/sampler.md).
# Uses git sparse checkout from github.com/sfzinstruments, so only the files each instrument needs are downloaded (about 470 MB in all).
#   Piano   SplendidGrandPiano     public domain
#   Bass    dsmolken.double-bass   CC0, pizzicato only
#   Sax     MTG.SoloSax            CC BY 4.0, credit MTG (freesound) and kinwie; alto and tenor only
#   Drums   virtuosity_drums       CC0, "mid" mic: kick, snare, hats, rides, crashes
# Read each library's LICENSE and README before you release anything made with it.
# Usage: ./setup-libraries-windows.ps1 [-Destination <folder>] [-Only piano,bass,sax,drums]
param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'lmms-mcp/libraries'),
    [ValidateSet('piano', 'bass', 'sax', 'drums')][string[]]$Only = @('piano', 'bass', 'sax', 'drums')
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git is required' }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$libraries = [ordered]@{
    piano = @{ Repo = 'SplendidGrandPiano'; Patterns = @('/*') }
    bass  = @{ Repo = 'dsmolken.double-bass'; Patterns = @('/*.sfz', '/*.txt', '/LICENSE*', '/pizz/*.wav') }
    sax   = @{ Repo = 'MTG.SoloSax'; Patterns = @('/LICENSE', '/README.md', '/MTG Solo Saxophones/*.sfz', '/MTG Solo Saxophones/Data/', '/MTG Solo Saxophones/Samples/alt_*', '/MTG Solo Saxophones/Samples/ten_*') }
    drums = @{ Repo = 'virtuosity_drums'; Patterns = @('/*.xml', '/LICENSE', '/README.md', '/notes.txt', '/Programs/', '/Samples/mid/kick/', '/Samples/mid/snare/', '/Samples/mid/snareoff/', '/Samples/mid/hh/', '/Samples/mid/ride/', '/Samples/mid/flatride/', '/Samples/mid/crash/') }
}

foreach ($name in $Only) {
    $library = $libraries[$name]
    $folder = Join-Path $Destination $library.Repo
    if (-not (Test-Path (Join-Path $folder '.git'))) {
        git clone --quiet --depth 1 --filter=blob:none --no-checkout "https://github.com/sfzinstruments/$($library.Repo).git" $folder
        if ($LASTEXITCODE -ne 0) { throw "Clone failed for $($library.Repo)" }
    }
    git -C $folder sparse-checkout set --no-cone @($library.Patterns)
    git -C $folder checkout --quiet HEAD
    if ($LASTEXITCODE -ne 0) { throw "Checkout failed for $($library.Repo)" }
    $size = (Get-ChildItem $folder -Recurse -File -Force | Where-Object { $_.FullName -notmatch '\\\.git\\' } | Measure-Object Length -Sum).Sum
    Write-Output ('{0}: {1:N0} MB in {2}' -f $library.Repo, ($size / 1MB), $folder)
}
Write-Output "Set LMMS_SAMPLE_LIBRARIES to $Destination, then call convert_sfz on each library's .sfz file."
