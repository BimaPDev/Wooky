# Wooky one-command installer for Windows (PowerShell 5.1 and PowerShell 7+).
# Usage:
#   irm https://github.com/BimaPDev/Wooky/releases/latest/download/install.ps1 | iex
#
# Configure with environment variables before invoking:
#   $env:WOOKY_REPO = "BimaPDev/Wooky"
#   $env:WOOKY_VERSION = "latest"
#   $env:WOOKY_SERVICE = "1"
#   $env:WOOKY_HOST = "1"
#   $env:WOOKY_AGENTS = "claude,codex,opencode"
#   $env:WOOKY_PREFIX = "$env:LOCALAPPDATA\Wooky\app"
#   $env:WOOKY_YES = "1"

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 6) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

function Write-WookyStep {
  param(
    [string]$Kind,
    [string]$Message
  )
  $okMark = [char]0x2713
  $errMark = [char]0x2717
  switch ($Kind) {
    'ok'   { Write-Host "$okMark $Message" -ForegroundColor Green }
    'warn' { Write-Host "! $Message" -ForegroundColor Yellow }
    'err'  { Write-Host "$errMark $Message" -ForegroundColor Red }
    default { Write-Host "- $Message" -ForegroundColor DarkGray }
  }
}

function Get-WookyArch {
  $arch = $null
  try {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  } catch {
    $arch = $null
  }
  if (-not $arch) {
    $arch = ($env:PROCESSOR_ARCHITECTURE + '').ToLowerInvariant()
  }
  switch ($arch) {
    'x64'   { return 'x64' }
    'amd64' { return 'x64' }
    'arm64' { return 'arm64' }
    default {
      throw "Unsupported Windows architecture: $arch (Wooky supports x64 and arm64)."
    }
  }
}

function Test-WookyNodeVersion {
  param([string]$VersionText)
  if (-not $VersionText) { return $false }
  $clean = $VersionText.Trim().TrimStart('v')
  $majorStr = ($clean -split '\.')[0]
  $major = 0
  if (-not [int]::TryParse($majorStr, [ref]$major)) { return $false }
  return ($major -ge 24)
}

function Test-WookyNodeHasSqlite {
  param([string]$NodeExe)
  if (-not $NodeExe) { return $false }
  if (-not (Test-Path $NodeExe)) {
    $cmd = Get-Command $NodeExe -ErrorAction SilentlyContinue
    if (-not $cmd) { return $false }
    $NodeExe = $cmd.Source
  }
  try {
    $ver = (& $NodeExe -v 2>$null | Select-Object -First 1)
    if (-not (Test-WookyNodeVersion $ver)) { return $false }
    & $NodeExe -e 'import("node:sqlite").then(() => process.exit(0), () => process.exit(1))' *> $null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Get-WookyExpectedSha256 {
  param(
    [string]$FileName,
    [string]$SumsPath
  )
  foreach ($rawLine in (Get-Content -Path $SumsPath)) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $parts = $line -split '\s+', 2
    if ($parts.Length -lt 2) { continue }
    $hash = $parts[0].ToLowerInvariant()
    $name = $parts[1].Trim().TrimStart('*')
    if ($name.StartsWith('./')) { $name = $name.Substring(2) }
    if ($name -eq $FileName) {
      if ($hash -match '^[0-9a-f]{64}$') { return $hash }
      return $null
    }
  }
  return $null
}

function Save-WookyUrl {
  param(
    [string]$Url,
    [string]$Destination
  )
  if ($Url.StartsWith('file://')) {
    if ($env:WOOKY_ALLOW_LOCAL_BUNDLE -ne '1') {
      throw 'Local bundle URLs require WOOKY_ALLOW_LOCAL_BUNDLE=1.'
    }
    $uri = [Uri]$Url
    Copy-Item -Path $uri.LocalPath -Destination $Destination -Force
    return
  }
  $uri = [Uri]$Url
  if ($uri.Scheme -ne 'https') {
    throw "Refusing non-HTTPS URL: $Url"
  }
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Repair-WookyNodePtySpawnHelper {
  param([string]$BundleRoot)
  if ($PSVersionTable.PSVersion.Major -lt 6 -or $IsWindows) { return }
  $ptyRoot = Join-Path $BundleRoot 'node_modules/node-pty'
  if (-not (Test-Path $ptyRoot)) { return }
  Get-ChildItem -Path $ptyRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -eq 'spawn-helper' -and (
        $_.FullName -match '[/\\]prebuilds[/\\][^/\\]+[/\\]spawn-helper$' -or
        $_.FullName -match '[/\\]build[/\\]Release[/\\]spawn-helper$'
      )
    } |
    ForEach-Object {
      & chmod +x $_.FullName 2>$null
    }
}

function Ensure-WookyNode {
  param(
    [string]$Arch,
    [string]$RuntimeDir,
    [string]$TempDir
  )
  $sysNode = Get-Command 'node' -ErrorAction SilentlyContinue
  if ($sysNode -and (Test-WookyNodeHasSqlite $sysNode.Source)) {
    $ver = (& $sysNode.Source -v 2>$null | Select-Object -First 1)
    Write-WookyStep 'ok' "Using system Node $ver ($($sysNode.Source))"
    return @{ Path = $sysNode.Source; Managed = $false }
  }

  $managedNode = Join-Path $RuntimeDir 'node.exe'
  if ((Test-Path $managedNode) -and (Test-WookyNodeHasSqlite $managedNode)) {
    $ver = (& $managedNode -v 2>$null | Select-Object -First 1)
    Write-WookyStep 'ok' "Using Wooky Node runtime $ver ($managedNode)"
    return @{ Path = $managedNode; Managed = $true }
  }

  Write-WookyStep 'info' "Installing Node 24 runtime into $RuntimeDir..."
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $nodeEntry = $index | Where-Object { $_.version -like 'v24.*' } | Select-Object -First 1
  if (-not $nodeEntry) {
    throw 'Could not locate a Node 24 release in nodejs.org/dist/index.json.'
  }
  $nodeVer = $nodeEntry.version
  $zipName = "node-$nodeVer-win-$Arch.zip"
  $sumsPath = Join-Path $TempDir 'node-SHASUMS256.txt'
  $zipPath = Join-Path $TempDir $zipName
  Save-WookyUrl -Url "https://nodejs.org/dist/$nodeVer/SHASUMS256.txt" -Destination $sumsPath
  Save-WookyUrl -Url "https://nodejs.org/dist/$nodeVer/$zipName" -Destination $zipPath

  $expected = Get-WookyExpectedSha256 -FileName $zipName -SumsPath $sumsPath
  if (-not $expected) {
    throw "Missing SHA-256 entry for $zipName in SHASUMS256.txt."
  }
  $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) {
    throw "SHA-256 mismatch for $zipName (expected $expected, got $actual)."
  }

  $extractDir = Join-Path $TempDir 'node-extract'
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
  $innerDir = Join-Path $extractDir "node-$nodeVer-win-$Arch"
  if (-not (Test-Path $innerDir)) {
    $innerDir = (Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1).FullName
  }

  $parent = Split-Path -Path $RuntimeDir -Parent
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  if (Test-Path $RuntimeDir) {
    Remove-Item -Path $RuntimeDir -Recurse -Force
  }
  Move-Item -Path $innerDir -Destination $RuntimeDir

  if (-not (Test-WookyNodeHasSqlite $managedNode)) {
    throw "Downloaded Node runtime at $managedNode does not support node:sqlite."
  }
  Write-WookyStep 'ok' "Installed Node $nodeVer into $RuntimeDir (SHA-256 verified)"
  return @{ Path = $managedNode; Managed = $true }
}

function Resolve-WookyReleaseTag {
  param(
    [string]$Repo,
    [string]$Version
  )
  if (-not $Version -or $Version -eq 'latest') {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'Wooky-Installer' } -UseBasicParsing
    if (-not $release.tag_name) {
      throw "No published release found for $Repo."
    }
    return $release.tag_name
  }
  if ($Version.StartsWith('v')) { return $Version }
  return "v$Version"
}

function Remove-WookyOldVersions {
  param(
    [string]$PrefixDir,
    [string]$CurrentVersion,
    [int]$Keep = 2
  )
  if (-not (Test-Path $PrefixDir)) { return }
  $dirs = Get-ChildItem -Path $PrefixDir -Directory |
    Where-Object {
      $_.Name -ne 'current' -and
      -not $_.Name.StartsWith('.') -and
      $_.Name -ne $CurrentVersion -and
      -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
    } |
    Sort-Object -Property LastWriteTimeUtc -Descending
  $toRemove = $dirs | Select-Object -Skip $Keep
  foreach ($dir in $toRemove) {
    Remove-Item -Path $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Add-WookyUserPath {
  param([string]$BinDir)
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  $entries = @($userPath -split ';' | Where-Object { $_ -and $_.Trim() -ne '' })
  $exists = $false
  foreach ($entry in $entries) {
    if ($entry.TrimEnd('\').Equals($BinDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      $exists = $true
      break
    }
  }
  if (-not $exists) {
    $nextPath = if ($entries.Count -gt 0) { ($entries -join ';') + ';' + $BinDir } else { $BinDir }
    [Environment]::SetEnvironmentVariable('Path', $nextPath, 'User')
    Write-WookyStep 'ok' "Added $BinDir to your User PATH (open a new terminal to use 'wooky')"
  }
  if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\').Equals($BinDir.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) })) {
    $env:Path = "$BinDir;$env:Path"
  }
}

function Install-WookyAgents {
  param(
    [string]$AgentsList,
    [string]$NodeDir,
    [string]$BinDir
  )
  $installedAny = $false
  foreach ($raw in ($AgentsList -split ',')) {
    $agent = $raw.Trim().ToLowerInvariant()
    if (-not $agent) { continue }
    switch ($agent) {
      'claude' {
        Write-WookyStep 'info' 'Installing Claude Code...'
        try {
          & ([ScriptBlock]::Create((Invoke-RestMethod -Uri 'https://claude.ai/install.ps1' -UseBasicParsing)))
          Write-WookyStep 'ok' 'Installed Claude Code (sign in on this machine with: claude)'
          $installedAny = $true
        } catch {
          Write-WookyStep 'warn' "Claude Code installer failed: $($_.Exception.Message)"
        }
      }
      'codex' {
        Write-WookyStep 'info' 'Installing Codex CLI...'
        $toolsPrefix = Join-Path (Join-Path $env:LOCALAPPDATA 'Wooky') 'tools'
        New-Item -ItemType Directory -Path $toolsPrefix -Force | Out-Null
        $npmCmd = Join-Path $NodeDir 'npm.cmd'
        if (-not (Test-Path $npmCmd)) { $npmCmd = 'npm.cmd' }
        & $npmCmd install -g --prefix $toolsPrefix --no-audit --no-fund '@openai/codex'
        if ($LASTEXITCODE -eq 0) {
          $codexShim = Join-Path $toolsPrefix 'codex.cmd'
          if (Test-Path $codexShim) {
            Copy-Item -Path $codexShim -Destination (Join-Path $BinDir 'codex.cmd') -Force
          }
          Write-WookyStep 'ok' 'Installed Codex CLI (sign in on this machine with: codex login)'
          $installedAny = $true
        } else {
          Write-WookyStep 'warn' 'Codex CLI installation failed.'
        }
      }
      'opencode' {
        Write-WookyStep 'info' 'Installing OpenCode...'
        try {
          & ([ScriptBlock]::Create((Invoke-RestMethod -Uri 'https://opencode.ai/install.ps1' -UseBasicParsing)))
          Write-WookyStep 'ok' 'Installed OpenCode (sign in on this machine with: opencode)'
          $installedAny = $true
        } catch {
          Write-WookyStep 'warn' "OpenCode installer failed: $($_.Exception.Message)"
        }
      }
      default {
        Write-WookyStep 'warn' "Unknown agent '$agent' in WOOKY_AGENTS (supported: claude, codex, opencode)."
      }
    }
  }
  if ($installedAny) {
    Write-WookyStep 'info' 'Each agent CLI needs its own sign-in on this machine; Wooky never stores credentials.'
  }
}

function Invoke-WookyInstall {
  $repo = if ($env:WOOKY_REPO) { $env:WOOKY_REPO } else { 'BimaPDev/Wooky' }
  $version = if ($env:WOOKY_VERSION) { $env:WOOKY_VERSION } else { 'latest' }
  $localRoot = Join-Path $env:LOCALAPPDATA 'Wooky'
  $prefix = if ($env:WOOKY_PREFIX) { $env:WOOKY_PREFIX } else { Join-Path $localRoot 'app' }
  $runtimeDir = Join-Path (Join-Path $localRoot 'runtime') 'node'
  $binDir = if ($env:WOOKY_BIN_DIR) { $env:WOOKY_BIN_DIR } else { Join-Path $localRoot 'bin' }
  $wookyHome = if ($env:WOOKY_HOME) { $env:WOOKY_HOME } else { Join-Path $HOME '.wooky' }
  $serviceFlag = if ($env:WOOKY_SERVICE) { $env:WOOKY_SERVICE } else { '0' }
  $hostFlag = if ($env:WOOKY_HOST) { $env:WOOKY_HOST } else { '0' }
  $agents = if ($env:WOOKY_AGENTS) { $env:WOOKY_AGENTS } else { '' }
  $port = if ($env:WOOKY_PORT) { $env:WOOKY_PORT } else { '4317' }

  $arch = Get-WookyArch
  Write-WookyStep 'ok' "Detected platform windows/$arch"

  $tempDir = Join-Path ([IO.Path]::GetTempPath()) ("wooky-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

  try {
    $nodeInfo = Ensure-WookyNode -Arch $arch -RuntimeDir $runtimeDir -TempDir $tempDir
    $nodePath = $nodeInfo.Path
    $nodeDir = Split-Path -Path $nodePath -Parent

    if ($env:WOOKY_BUNDLE_URL) {
      $bundleUrl = $env:WOOKY_BUNDLE_URL
      $cleanUrl = ($bundleUrl -split '\?')[0]
      $assetName = Split-Path -Path $cleanUrl -Leaf
      $sumsUrl = if ($env:WOOKY_SUMS_URL) { $env:WOOKY_SUMS_URL } else { ($cleanUrl.Substring(0, $cleanUrl.LastIndexOf('/')) + '/SHA256SUMS') }
      if ($version -eq 'latest' -and $assetName -match '^wooky-(.+)\.tgz$') {
        $resolvedVersion = $Matches[1]
      } elseif ($version -eq 'latest') {
        $resolvedVersion = 'local'
      } else {
        $resolvedVersion = $version.TrimStart('v')
      }
    } else {
      $tag = Resolve-WookyReleaseTag -Repo $repo -Version $version
      $resolvedVersion = $tag.TrimStart('v')
      $assetName = "wooky-$resolvedVersion.tgz"
      $bundleUrl = "https://github.com/$repo/releases/download/$tag/$assetName"
      $sumsUrl = "https://github.com/$repo/releases/download/$tag/SHA256SUMS"
    }

    Write-WookyStep 'info' "Downloading Wooky $resolvedVersion ($assetName)..."
    $bundlePath = Join-Path $tempDir $assetName
    $sumsPath = Join-Path $tempDir 'SHA256SUMS'
    Save-WookyUrl -Url $bundleUrl -Destination $bundlePath
    Save-WookyUrl -Url $sumsUrl -Destination $sumsPath

    $expectedHash = Get-WookyExpectedSha256 -FileName $assetName -SumsPath $sumsPath
    if (-not $expectedHash) {
      throw "No SHA-256 entry for $assetName in SHA256SUMS."
    }
    $actualHash = (Get-FileHash -Path $bundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedHash -ne $actualHash) {
      throw "SHA-256 mismatch for $assetName (expected $expectedHash, got $actualHash)."
    }
    Write-WookyStep 'ok' "Verified $assetName (SHA-256)"

    New-Item -ItemType Directory -Path $prefix -Force | Out-Null
    $stageDir = Join-Path $prefix (".staging-$resolvedVersion-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $versionDir = Join-Path $prefix $resolvedVersion
    New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

    & tar.exe -xzf $bundlePath -C $stageDir
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to extract $assetName with tar.exe."
    }

    $npmCmd = Join-Path $nodeDir 'npm.cmd'
    if (-not (Test-Path $npmCmd)) { $npmCmd = 'npm.cmd' }
    if (Test-Path (Join-Path $stageDir 'package.json')) {
      Write-WookyStep 'info' 'Installing native runtime dependencies...'
      Push-Location $stageDir
      try {
        $oldPath = $env:Path
        $env:Path = "$nodeDir;$oldPath"
        & $npmCmd install --omit=dev --no-audit --no-fund *> $null
        if ($LASTEXITCODE -ne 0) {
          Write-WookyStep 'warn' 'Optional native module build failed (missing build tools); terminal will use pipe mode.'
        }
        Repair-WookyNodePtySpawnHelper -BundleRoot $stageDir
      } finally {
        $env:Path = $oldPath
        Pop-Location
      }
    }

    if (Test-Path $versionDir) {
      Remove-Item -Path $versionDir -Recurse -Force
    }
    Move-Item -Path $stageDir -Destination $versionDir

    $currentLink = Join-Path $prefix 'current'
    if (Test-Path -LiteralPath $currentLink) {
      cmd.exe /d /c rmdir "$currentLink" 2>$null | Out-Null
      if (Test-Path -LiteralPath $currentLink) {
        $linkItem = Get-Item -LiteralPath $currentLink -Force
        $isJunction = ($linkItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        if (-not $isJunction) {
          throw "Refusing to remove non-junction path at $currentLink (expected directory junction)."
        }
        cmd.exe /d /c rmdir "$currentLink"
        if ($LASTEXITCODE -ne 0) {
          throw "Failed to remove junction $currentLink"
        }
      }
    }
    cmd.exe /d /c mklink /J "$currentLink" "$versionDir" *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to create directory junction $currentLink -> $versionDir."
    }
    Remove-WookyOldVersions -PrefixDir $prefix -CurrentVersion $resolvedVersion -Keep 2
    Write-WookyStep 'ok' "Installed Wooky $resolvedVersion into $versionDir"

    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    $launcher = Join-Path $binDir 'wooky.cmd'
    $launcherLines = @(
      '@echo off',
      'setlocal',
      "if not defined WOOKY_PREFIX set `"WOOKY_PREFIX=$prefix`""
    )
    $launcherLines += "if not defined WOOKY_NODE set `"WOOKY_NODE=$nodePath`""
    $launcherLines += '"%WOOKY_PREFIX%\current\bin\wooky.cmd" %*'
    $launcherLines += 'exit /b %ERRORLEVEL%'
    Set-Content -Path $launcher -Value ($launcherLines -join "`r`n") -Encoding ASCII
    Write-WookyStep 'ok' "Installed launcher at $launcher"

    Add-WookyUserPath -BinDir $binDir

    if ($serviceFlag -eq '1') {
      Write-WookyStep 'info' 'Configuring Windows Scheduled Task...'
      $env:WOOKY_HOME = $wookyHome
      $env:WOOKY_PREFIX = $prefix
      $env:WOOKY_BIN_DIR = $binDir
      $env:WOOKY_NODE = $nodePath
      $env:Path = "$binDir;$nodeDir;$env:Path"
      & $launcher service install
      if ($LASTEXITCODE -eq 0) {
        Write-WookyStep 'ok' 'Background service installed and started'
      } else {
        Write-WookyStep 'warn' "Background service setup failed; you can still run 'wooky' directly."
      }
    }

    if ($hostFlag -eq '1') {
      $helpText = (& $launcher --help 2>&1 | Out-String)
      if ($helpText -match '\bpair\b') {
        Write-WookyStep 'info' 'Printing host pairing code...'
        & $launcher pair --print
      } else {
        Write-WookyStep 'info' "Skipping 'wooky pair --print' (not available in this build yet)."
      }
    }

    if ($agents) {
      Install-WookyAgents -AgentsList $agents -NodeDir $nodeDir -BinDir $binDir
    }

    Write-Host ''
    Write-Host "Wooky $resolvedVersion is ready." -ForegroundColor White
    Write-Host "  URL:        http://127.0.0.1:$port"
    Write-Host "  Install:    $currentLink"
    Write-Host "  Launcher:   $launcher"
    Write-Host '  Next steps:'
    if ($serviceFlag -eq '1') {
      Write-Host '    wooky service status   # check the background server'
    } else {
      Write-Host '    wooky                  # start the server'
      Write-Host '    wooky service install  # run automatically at logon'
    }
    Write-Host '    wooky update           # upgrade to the latest release'
    Write-Host '    wooky uninstall        # remove Wooky'
  } finally {
    Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($env:WOOKY_INSTALL_LIB -ne '1') {
  Invoke-WookyInstall
}
