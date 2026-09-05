param(
  [string]$Region = "ferrar-glacier",
  [ValidateSet("10m","2m")]
  [string]$Resolution = "10m"
)

$ErrorActionPreference = "Stop"

function Find-GdalExe([string]$Name) {
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $candidates = @(
    "C:\OSGeo4W\bin\$Name.exe",
    "C:\Program Files\QGIS*\bin\$Name.exe"
  )

  foreach ($pattern in $candidates) {
    $match = Get-ChildItem $pattern -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
    if ($match) { return $match.FullName }
  }
  return $null
}

function Parse-InvariantDouble([string]$Value) {
  return [double]::Parse(
    $Value,
    [System.Globalization.NumberStyles]::Float,
    [System.Globalization.CultureInfo]::InvariantCulture
  )
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RegionPath = Join-Path $RepoRoot "regions\$Region.json"
if (-not (Test-Path $RegionPath)) { throw "Region definition not found: $RegionPath" }

$cfg = Get-Content $RegionPath -Raw | ConvertFrom-Json
$bbox = $cfg.bbox
$xmin = [double]$bbox[0]
$ymin = [double]$bbox[1]
$xmax = [double]$bbox[2]
$ymax = [double]$bbox[3]

$gdalinfo = Find-GdalExe "gdalinfo"
$gdalbuildvrt = Find-GdalExe "gdalbuildvrt"
$gdaltranslate = Find-GdalExe "gdal_translate"

if (-not $gdalinfo -or -not $gdalbuildvrt -or -not $gdaltranslate) {
  Write-Host "GDAL command-line tools were not found." -ForegroundColor Yellow
  Write-Host "Install QGIS LTR (which includes GDAL), then rerun this script:"
  Write-Host "  winget install --id OSGeo.QGIS_LTR --exact" -ForegroundColor Cyan
  exit 2
}

$tileProperty = $cfg.sources.rema.tiles.PSObject.Properties[$Resolution]
if (-not $tileProperty) { throw "No REMA $Resolution tile set is configured for region '$Region'." }
$tileDefs = @($tileProperty.Value)

$DemDir = Join-Path $RepoRoot "data\raw\rema\$Resolution\dem"
$dems = @()
foreach ($tile in $tileDefs) {
  $expectedName = "{0}_{1}_v{2}_dem.tif" -f $tile.id, $Resolution, $cfg.sources.rema.version
  $path = Join-Path $DemDir $expectedName
  if (-not (Test-Path $path)) {
    throw "Configured REMA DEM is missing: $path`nRun scripts\fetch_rema.ps1 for $Resolution first."
  }
  $dems += Get-Item $path
}

$OutDir = Join-Path $RepoRoot "data\processed\$Region\terrain\$Resolution"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Vrt = Join-Path $OutDir "${Region}_${Resolution}_mosaic.vrt"
$Crop = Join-Path $OutDir "${Region}_${Resolution}_dem.tif"

function Get-DemExtent([string]$Path) {
  # Do not use gdalinfo -json here. Windows PowerShell 5.1 ConvertFrom-Json can
  # reject otherwise-valid GDAL JSON when metadata contains property names that
  # collide case-insensitively. The stable text header gives us everything
  # needed for a north-up raster extent check.
  $text = (& $gdalinfo $Path 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "gdalinfo failed for $Path" }

  if ($text -notmatch '(?m)^Size is\s+(\d+),\s*(\d+)\s*$') {
    throw "Could not parse raster size from gdalinfo output for $Path"
  }
  $width = [double]$Matches[1]
  $height = [double]$Matches[2]

  if ($text -notmatch '(?m)^Origin\s*=\s*\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)\s*$') {
    throw "Could not parse raster origin from gdalinfo output for $Path"
  }
  $x0 = Parse-InvariantDouble $Matches[1]
  $y0 = Parse-InvariantDouble $Matches[2]

  if ($text -notmatch '(?m)^Pixel Size\s*=\s*\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)\s*$') {
    throw "Could not parse pixel size from gdalinfo output for $Path"
  }
  $pixelX = Parse-InvariantDouble $Matches[1]
  $pixelY = Parse-InvariantDouble $Matches[2]

  if ($pixelX -eq 0 -or $pixelY -eq 0) {
    throw "Invalid zero pixel size reported for $Path"
  }

  $x1 = $x0 + ($width * $pixelX)
  $y1 = $y0 + ($height * $pixelY)

  [pscustomobject]@{
    XMin = [Math]::Min($x0, $x1)
    XMax = [Math]::Max($x0, $x1)
    YMin = [Math]::Min($y0, $y1)
    YMax = [Math]::Max($y0, $y1)
    PixelX = $pixelX
    PixelY = $pixelY
    Width = $width
    Height = $height
  }
}

Write-Host "Open Antarctica - REMA crop build"
Write-Host "Region:      $($cfg.name)"
Write-Host "Resolution:  $Resolution"
Write-Host "Input DEMs:  $($dems.Count)"
Write-Host "Output:      $Crop"
Write-Host ""

$extents = @()
foreach ($dem in $dems) {
  Write-Host "Validating $($dem.Name) ..."
  $extent = Get-DemExtent $dem.FullName
  $extents += $extent
  Write-Host ("  extent x={0:N0}..{1:N0}, y={2:N0}..{3:N0}; pixel={4} x {5} m" -f $extent.XMin,$extent.XMax,$extent.YMin,$extent.YMax,$extent.PixelX,$extent.PixelY)
}

$mosaicXMin = ($extents | Measure-Object XMin -Minimum).Minimum
$mosaicXMax = ($extents | Measure-Object XMax -Maximum).Maximum
$mosaicYMin = ($extents | Measure-Object YMin -Minimum).Minimum
$mosaicYMax = ($extents | Measure-Object YMax -Maximum).Maximum

Write-Host ("Configured crop x={0:N0}..{1:N0}, y={2:N0}..{3:N0}" -f $xmin,$xmax,$ymin,$ymax)
Write-Host ("Source union     x={0:N0}..{1:N0}, y={2:N0}..{3:N0}" -f $mosaicXMin,$mosaicXMax,$mosaicYMin,$mosaicYMax)

if ($xmin -lt $mosaicXMin -or $xmax -gt $mosaicXMax -or $ymin -lt $mosaicYMin -or $ymax -gt $mosaicYMax) {
  throw "Configured region is not contained by the configured REMA source tiles. Refusing to create an all-NoData crop."
}

Write-Host "Building VRT mosaic ..."
& $gdalbuildvrt -overwrite $Vrt @($dems.FullName)
if ($LASTEXITCODE -ne 0) { throw "gdalbuildvrt failed." }

# Remove an earlier failed/invalid crop so gdal_translate always writes a fresh file.
if (Test-Path $Crop) { Remove-Item -Force $Crop }
if (Test-Path "$Crop.aux.xml") { Remove-Item -Force "$Crop.aux.xml" }

Write-Host "Cropping to configured EPSG:3031 footprint ..."
# gdal_translate preserves the native REMA grid and crops to the nearest source pixels.
& $gdaltranslate `
  -projwin $xmin $ymax $xmax $ymin `
  -projwin_srs EPSG:3031 `
  -co TILED=YES `
  -co COMPRESS=DEFLATE `
  -co PREDICTOR=3 `
  -co BIGTIFF=IF_SAFER `
  $Vrt $Crop
if ($LASTEXITCODE -ne 0) { throw "gdal_translate failed." }

Write-Host ""
Write-Host "Checking for valid elevation pixels ..."
$statsText = (& $gdalinfo -stats $Crop 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "gdalinfo -stats failed on output crop." }
if ($statsText -match 'STATISTICS_VALID_PERCENT=0(?:\.0+)?(?:\s|$)') {
  throw "Output crop contains 0% valid pixels. Refusing to report success."
}
if ($statsText -notmatch 'STATISTICS_VALID_PERCENT=([-+0-9.eE]+)') {
  throw "Could not confirm valid-pixel percentage on output crop."
}
$validPercent = Parse-InvariantDouble $Matches[1]
Write-Host ("  valid pixels: {0:N2}%" -f $validPercent)

Write-Host "Validating output ..."
& $gdalinfo $Crop
if ($LASTEXITCODE -ne 0) { throw "gdalinfo failed on output crop." }

$size = (Get-Item $Crop).Length / 1MB
Write-Host ""
Write-Host ("REMA crop complete: {0:N1} MiB" -f $size) -ForegroundColor Green
Write-Host "Output: $Crop"
