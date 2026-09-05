# Open Antarctica - REMA downloader for Windows PowerShell
# Uses Windows built-in curl.exe and tar.exe; Python is not required.

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateSet('ferrar-glacier')]
    [string]$Region = 'ferrar-glacier',

    [Parameter()]
    [ValidateSet('10m', '2m')]
    [string]$Resolution = '10m'
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RegionPath = Join-Path $RepoRoot "regions\$Region.json"

if (-not (Test-Path $RegionPath)) {
    throw "Region definition not found: $RegionPath"
}

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    throw 'curl.exe was not found. It is included with current Windows 10/11 installations.'
}

if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    throw 'tar.exe was not found. It is included with current Windows 10/11 installations.'
}

$Config = Get-Content -Raw -Path $RegionPath | ConvertFrom-Json
$Tiles = $Config.sources.rema.tiles.$Resolution

if (-not $Tiles) {
    throw "No REMA $Resolution sources are configured for region '$Region'."
}

$RawDir = Join-Path $RepoRoot "data\raw\rema\$Resolution"
$DemDir = Join-Path $RepoRoot "data\raw\rema\$Resolution\dem"
New-Item -ItemType Directory -Force -Path $RawDir, $DemDir | Out-Null

Write-Host "Open Antarctica - REMA acquisition" -ForegroundColor Cyan
Write-Host "Region:     $($Config.name)"
Write-Host "Resolution: $Resolution"
Write-Host "Tiles:      $($Tiles.Count)"
Write-Host "Output:     $RawDir"
Write-Host ''

foreach ($Tile in $Tiles) {
    $ArchivePath = Join-Path $RawDir $Tile.archive
    $Url = $Tile.url

    Write-Host "[$($Tile.id)] $($Tile.archive)" -ForegroundColor Yellow

    $downloadNeeded = $true
    if (Test-Path $ArchivePath) {
        # A valid tar listing means an earlier run already has a complete archive.
        & tar.exe -tzf $ArchivePath *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host '  Archive already present and valid; skipping download.'
            $downloadNeeded = $false
        }
        else {
            Write-Host '  Partial/incomplete archive found; attempting resume.'
        }
    }

    if ($downloadNeeded) {
        & curl.exe -fL --retry 5 --retry-delay 3 -C - -o $ArchivePath $Url
        if ($LASTEXITCODE -ne 0) {
            throw "Download failed for $($Tile.id) (curl exit $LASTEXITCODE)."
        }
    }

    $Entries = @(& tar.exe -tzf $ArchivePath)
    if ($LASTEXITCODE -ne 0) {
        throw "Archive validation failed: $ArchivePath"
    }

    $DemEntries = @($Entries | Where-Object { $_ -match '_dem\.tif$' })
    if ($DemEntries.Count -eq 0) {
        throw "No *_dem.tif found in $($Tile.archive)."
    }

    foreach ($DemEntry in $DemEntries) {
        $DemName = Split-Path -Leaf $DemEntry
        $DemPath = Join-Path $DemDir $DemName

        if (Test-Path $DemPath) {
            Write-Host "  DEM already extracted: $DemName"
            continue
        }

        Write-Host "  Extracting $DemName ..."
        & tar.exe -xzf $ArchivePath -C $DemDir $DemEntry
        if ($LASTEXITCODE -ne 0) {
            throw "Extraction failed for $DemEntry."
        }

        # Some archives may contain an internal directory. Move the DEM to the flat dem/ folder.
        if (-not (Test-Path $DemPath)) {
            $Found = Get-ChildItem -Path $DemDir -Recurse -File -Filter $DemName | Select-Object -First 1
            if (-not $Found) {
                throw "Extraction completed but $DemName could not be located."
            }
            if ($Found.FullName -ne $DemPath) {
                Move-Item -Force $Found.FullName $DemPath
            }
        }
    }

    Write-Host '  OK' -ForegroundColor Green
    Write-Host ''
}

Write-Host 'REMA acquisition complete.' -ForegroundColor Green
Write-Host "DEMs: $DemDir"
Write-Host 'Next: mosaic/crop the DEMs to the exact region BBOX.'
