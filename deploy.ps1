# Copies the built plugin into the dev vault so it can be tested in Obsidian.
$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$dest = Join-Path $root "dev_vault\.obsidian\plugins\image-viewer"

New-Item -ItemType Directory -Force -Path $dest | Out-Null

foreach ($file in @("main.js", "manifest.json", "styles.css")) {
	$src = Join-Path $root $file
	if (Test-Path $src) {
		Copy-Item $src -Destination $dest -Force
		Write-Host "copied $file -> $dest"
	} else {
		Write-Warning "missing $file (run the build first)"
	}
}

Write-Host "Done. Reload Obsidian (or toggle the plugin) to pick up changes."
