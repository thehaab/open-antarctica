# Project Decisions

## 2026-09-05 — Open-source first

The viewer should be accessible to the public and reproducible with open tooling and publicly usable datasets wherever practical.

## 2026-09-05 — Ferrar Glacier as the first prototype

The initial prototype footprint is the Ferrar Glacier scene captured from USGS LIMA and stored in `regions/ferrar-glacier.json`.

## 2026-09-05 — Keep source and reconstructed views distinct

Any future AI-enhanced or visually reconstructed layer must be explicitly distinguishable from raw/source scientific data. Provenance should remain visible.

## 2026-09-05 — Keep large data out of Git

The repository stores acquisition and processing recipes rather than multi-gigabyte source rasters or generated tile pyramids.
