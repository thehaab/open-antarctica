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

$DemDir = Join-Path $RepoRoot "data\raw\rema\$Resolution\dem"
$dems = Get-ChildItem $DemDir -Filter "*_dem.tif" -File | Sort-Object Name
if ($dems.Count -lt 2) { throw "Expected at least 2 REMA DEMs in $DemDir; found $($dems.Count)." }

$OutDir = Join-Path $RepoRoot "data\processed\$Region\terrain\$Resolution"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Vrt = Join-Path $OutDir "${Region}_${Resolution}_mosaic.vrt"
$Crop = Join-Path $OutDir "${Region}_${Resolution}_dem.tif"

Write-Host "Open Antarctica - REMA crop build"
Write-Host "Region:      $($cfg.name)"
Write-Host "Resolution:  $Resolution"
Write-Host "Input DEMs:  $($dems.Count)"
Write-Host "Output:      $Crop"
Write-Host ""

foreach ($dem in $dems) {
  Write-Host "Validating $($dem.Name) ..."
  & $gdalinfo $dem.FullName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "gdalinfo failed for $($dem.FullName)" }
}

Write-Host "Building VRT mosaic ..."
& $gdalbuildvrt -overwrite $Vrt @($dems.FullName)
if ($LASTEXITCODE -ne 0) { throw "gdalbuildvrt failed." }

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
Write-Host "Validating output ..."
& $gdalinfo $Crop
if ($LASTEXITCODE -ne 0) { throw "gdalinfo failed on output crop." }

$size = (Get-Item $Crop).Length / 1MB
Write-Host ""
Write-Host ("REMA crop complete: {0:N1} MiB" -f $size) -ForegroundColor Green
Write-Host "Output: $Crop"
