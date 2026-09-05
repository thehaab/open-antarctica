# Data Sources

This project does not relicense source datasets. Each dataset retains its original license and terms.

## REMA

Reference Elevation Model of Antarctica (REMA), Polar Geospatial Center.

Planned use:

- 10 m terrain for early prototype iteration
- 2 m terrain for v0.0.1 final Ferrar Glacier scene

Source products are distributed in Antarctic Polar Stereographic (`EPSG:3031`).

## USGS LIMA

Landsat Image Mosaic of Antarctica (LIMA), USGS EROS.

Planned use:

- 15 m natural-color imagery draped over terrain
- exact Ferrar Glacier footprint defined in `regions/ferrar-glacier.json`

Original WMS footprint used to define the first scene:

```text
BBOX=369585.9375,-1276268.2255506516,430625,-1258494.7880506516
SRS=EPSG:3031
```

## Future candidates

- Copernicus Sentinel-2 optical imagery
- Sentinel-1 SAR
- BedMachine Antarctica / bed topography
- Antarctic gazetteers and research-station vectors

Commercial or restricted imagery must not become a required dependency for the open viewer.
