#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
Set-Location $ProjectRoot

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-NodeMajorVersion {
  $version = (node -v).TrimStart("v")
  return [int]($version.Split(".")[0])
}

Write-Step "Checking Node.js 24+"
if (-not (Test-Command "node")) {
  throw "Node.js is not installed. Install Node.js 24 LTS from https://nodejs.org/ and retry."
}
if (-not (Test-Command "npm")) {
  throw "npm is not available. Reinstall Node.js 24 LTS and retry."
}
$nodeMajor = Get-NodeMajorVersion
if ($nodeMajor -lt 24) {
  throw "Node.js 24+ is required. Current version: $(node -v)"
}

Write-Step "Installing dependencies"
npm ci
if ($LASTEXITCODE -ne 0) {
  throw "npm ci failed."
}

Write-Step "Building application"
npm run build
if ($LASTEXITCODE -ne 0) {
  throw "npm run build failed."
}

Write-Step "Checking environment file"
$envFile = Join-Path $ProjectRoot ".env"
$envExample = Join-Path $ProjectRoot ".env.example"
if (-not (Test-Path $envFile)) {
  if (-not (Test-Path $envExample)) {
    throw ".env.example was not found."
  }
  Copy-Item $envExample $envFile
  Write-Host "Created .env from .env.example. Set MONDAY_API_TOKEN before importing."
} else {
  Write-Host ".env already exists."
}

Write-Step "Installing PM2 tools"
if (-not (Test-Command "pm2")) {
  npm install -g pm2
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install pm2 globally."
  }
}
if (-not (Test-Command "pm2-startup")) {
  npm install -g pm2-windows-startup
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install pm2-windows-startup globally."
  }
}

Write-Step "Starting mail-intake with PM2"
$existing = pm2 jlist | ConvertFrom-Json
$running = @($existing | Where-Object { $_.name -eq "mail-intake" })
if ($running.Count -gt 0) {
  pm2 restart operations/windows/ecosystem.config.cjs
} else {
  pm2 start operations/windows/ecosystem.config.cjs
}
if ($LASTEXITCODE -ne 0) {
  throw "PM2 failed to start mail-intake."
}

Write-Step "Saving PM2 process list"
pm2 save
if ($LASTEXITCODE -ne 0) {
  throw "pm2 save failed."
}

Write-Step "Enabling PM2 startup on Windows login"
pm2-startup install
if ($LASTEXITCODE -ne 0) {
  throw "pm2-startup install failed. Run it manually in an elevated PowerShell session."
}

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Open http://127.0.0.1:3000"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  pm2 status"
Write-Host "  pm2 logs mail-intake"
Write-Host "  pm2 restart mail-intake"
