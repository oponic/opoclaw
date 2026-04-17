# ── Opoclaw Installer (Windows PowerShell) ──────────────────────────────────

$RepoUrl = "https://github.com/oponic/opoclaw.git"
$InstallDir = ""

function Write-Header($msg){ Write-Host "`n═══ $msg ═══`n" -ForegroundColor White -BackgroundColor DarkBlue }
function Write-Info($msg)  { Write-Host "[opoclaw] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[✓] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "⚠ $msg" -ForegroundColor Yellow }

function Ensure-PackageManager {
    if (Get-Command winget -ErrorAction SilentlyContinue) { return "winget" }
    if (Get-Command scoop -ErrorAction SilentlyContinue)  { return "scoop" }
    Write-Info "Installing Scoop..."
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force
    irm get.scoop.sh | iex
    return "scoop"
}

function Ensure-Git {
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Write-Ok "Git already installed"
        return
    }
    Write-Info "Installing Git..."
    $pm = Ensure-PackageManager
    switch ($pm) {
        "winget" { winget install Git.Git --accept-source-agreements --accept-package-agreements }
        "scoop"  { scoop install git }
    }
    Write-Ok "Git installed"
}

function Ensure-Bun {
    if (Get-Command bun -ErrorAction SilentlyContinue) {
        Write-Ok "Bun already installed ($(bun --version))"
        return
    }
    Write-Info "Installing Bun..."
    $pm = Ensure-PackageManager
    switch ($pm) {
        "winget" { winget install Oven-sh.Bun }
        "scoop"  { scoop install bun }
    }
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","User") + ";" + [System.Environment]::GetEnvironmentVariable("Path","Machine")
    Write-Ok "Bun installed"
}

function Clone-Repo {
    $parentDir = Split-Path $InstallDir -Parent
    if ($parentDir -and -not (Test-Path $parentDir)) {
        Write-Info "Creating parent directory: $parentDir"
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }
    if (Test-Path $InstallDir) {
        Write-Ok "opoclaw already exists — pulling latest"
        Set-Location $InstallDir
        git fetch --tags
        git checkout main 2>$null || git checkout -b main
        git pull --rebase
        $latestTag = git tag --sort=-v:refname | Select-Object -First 1
        if ($latestTag) {
            Write-Info "Checking out latest tag: $latestTag"
            git checkout $latestTag
        }
        return
    }
    Write-Info "Cloning opoclaw (latest tag)..."
    git clone $RepoUrl $InstallDir
    Set-Location $InstallDir
    $latestTag = git tag --sort=-v:refname | Select-Object -First 1
    if ($latestTag) {
        Write-Info "Checking out latest tag: $latestTag"
        git checkout $latestTag
    }
    Write-Ok "Repo cloned"
}

function Install-Dependencies {
    Write-Info "Installing dependencies..."
    Set-Location $InstallDir
    bun install
    Write-Ok "Dependencies installed"
}

function Set-InstallDir {
    $InputPath = Read-Host "Enter directory to create opoclaw install folder in (leave empty for $HOME\Documents):"
    if ($InputPath) {
        $script:InstallDir = Join-Path $InputPath "opoclaw"
    } else {
        $script:InstallDir = "$HOME\Documents\opoclaw"
    }
}

# ── Main ────────────────────────────────────────────────────────────────────

Write-Header "opoclaw installer (Windows)"
Ensure-Git
Ensure-Bun
Set-InstallDir

Write-Header "Setting up opoclaw"
Clone-Repo
Install-Dependencies

Write-Header "Installing opoclaw command"
bun run src/cli.ts install

Write-Header "Launching onboard wizard"
Set-Location $InstallDir
bun run installers\onboard.ts

Write-Host ""
Write-Ok "opoclaw is installed!"
Write-Host "  Start:    opoclaw gateway start"
Write-Host "  Usage:    opoclaw usage"
Write-Host "  Update:   opoclaw update"
Write-Host "  Help:     opoclaw help"
Write-Host ""
