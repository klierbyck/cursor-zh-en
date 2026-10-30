param(
  [Parameter(Mandatory=$true)][string]$Manifest,
  [Parameter(Mandatory=$true)][ValidateSet('apply','restore')][string]$Action
)
$ErrorActionPreference = 'Stop'

function Safe-Path([string]$Path) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not permitted' }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
function Hash([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Atomic-Write([string]$Path, [byte[]]$Bytes) {
  $temporary = Join-Path ([IO.Path]::GetDirectoryName($Path)) ('.cursorzh-' + [guid]::NewGuid().ToString() + '.tmp')
  try {
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, $null) }
    else { [IO.File]::Move($temporary, $Path) }
  } finally {
    if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
  }
}

try {
  Safe-Path $Manifest
  $Manifest = [IO.Path]::GetFullPath($Manifest)
  $directory = [IO.Path]::GetDirectoryName($Manifest)
  $identityDirectory = [IO.Directory]::GetParent($directory)
  if ([IO.Path]::GetFileName($Manifest) -ne 'manifest.json' -or $identityDirectory.Parent.Name -ne 'transactions') { throw 'Invalid transaction location' }
  $m = [IO.File]::ReadAllText($Manifest) | ConvertFrom-Json
  if ($m.schema -ne 1 -or ([guid]$m.id).ToString() -ne [IO.Path]::GetFileName($directory) -or $m.identity -ne $identityDirectory.Name) { throw 'Invalid transaction identity' }
  if (($Action -eq 'apply' -and $m.state -ne 'applying') -or ($Action -eq 'restore' -and $m.state -ne 'restoring')) { throw 'Invalid transaction state' }
  $root = [IO.Path]::GetFullPath($m.root).TrimEnd('\')
  Safe-Path $root
  if ($root.StartsWith($env:WINDIR, [StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith('\\')) { throw 'Unsupported installation root' }
  $executable = Join-Path $root 'Cursor.exe'
  $signature = Get-AuthenticodeSignature -LiteralPath $executable
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Anysphere') { throw 'Cursor executable publisher validation failed' }
  $appRoot = Join-Path $root 'resources\app'
  $product = [IO.File]::ReadAllText((Join-Path $appRoot 'product.json')) | ConvertFrom-Json
  if ($product.applicationName -ne 'cursor' -or $product.commit -ne $m.commit -or $product.version -ne $m.version) { throw 'Cursor build changed' }
  $allowed = @('out/vs/code/electron-sandbox/workbench/workbench.html', 'out/vs/code/electron-sandbox/workbench/cursor-zh-toggle.js', 'out/main.js', 'product.json')
  $jobs = @()
  for ($index = 0; $index -lt $m.entries.Count; $index++) {
    $entry = $m.entries[$index]
    if ($entry.scope -ne 'app') { continue }
    if ($allowed -notcontains $entry.path) { throw 'Resource is not allowlisted' }
    $target = Join-Path $appRoot $entry.path.Replace('/', '\')
    Safe-Path $target
    $current = Hash $target
    if ($Action -eq 'apply') {
      $expected = $entry.after
      $blob = Join-Path $directory ($index.ToString() + '.after')
      if ($current -ne $entry.before -and $current -ne $expected) { throw 'Concurrent resource modification' }
    } else {
      if (-not ($entry.PSObject.Properties.Name -contains 'restoreHash')) { throw 'Restore was not prepared' }
      $expected = $entry.restoreHash
      if ($entry.restoreBlob -and $entry.restoreBlob -notmatch '^\d+\.restore$') { throw 'Invalid restore blob' }
      $blob = if ($entry.restoreBlob) { Join-Path $directory $entry.restoreBlob } else { $null }
      if ($current -ne $entry.after -and $current -ne $expected -and $current -ne $entry.before) { throw 'Concurrent resource modification' }
    }
    $bytes = $null
    if ($null -ne $expected) {
      Safe-Path $blob
      if ((Hash $blob) -ne $expected) { throw 'Staged resource hash mismatch' }
      $bytes = [IO.File]::ReadAllBytes($blob)
    }
    $jobs += [pscustomobject]@{ target=$target; expected=$expected; before=$current; bytes=$bytes; acl=$entry.windowsAcl }
  }
  if ($Action -eq 'restore') { [array]::Reverse($jobs) }
  foreach ($job in $jobs) {
    Safe-Path $job.target
    if ((Hash $job.target) -ne $job.expected) {
      if ((Hash $job.target) -ne $job.before) { throw 'Resource changed during commit' }
      if ($null -eq $job.expected) { [IO.File]::Delete($job.target) }
      else { Atomic-Write $job.target $job.bytes }
    }
    if ($null -ne $job.expected -and $job.acl) {
      $acl = Get-Acl -LiteralPath $job.target
      $acl.SetSecurityDescriptorSddlForm($job.acl, [System.Security.AccessControl.AccessControlSections]::Access)
      Set-Acl -LiteralPath $job.target -AclObject $acl
    }
    if ((Hash $job.target) -ne $job.expected) { throw 'Resource verification failed' }
  }
  exit 0
} catch {
  Write-Error $_ -ErrorAction Continue
  exit 1
}
