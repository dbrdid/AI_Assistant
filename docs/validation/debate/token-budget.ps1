# Shares Claude and Codex usage percentages. Reads only limit numbers; never prompts or message text.
$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot 'token-budget.json'
$now = [DateTimeOffset]::Now

function Get-Mode($session, $weekly, $fresh) {
  if ($null -eq $session -or $null -eq $weekly -or -not $fresh) { return 'unknown' }
  if ($session -ge 85 -or $weekly -ge 90) { return 'stop' }
  if ($session -ge 70 -or $weekly -ge 75) { return 'conserve' }
  return 'normal'
}
function Format-Reset($epochSeconds) {
  if (-not $epochSeconds) { return $null }
  return [DateTimeOffset]::FromUnixTimeSeconds([long]$epochSeconds).ToLocalTime().ToString('yyyy-MM-dd HH:mm')
}

$claude = [ordered]@{ session = $null; weekly = $null; sessionReset = $null; weeklyReset = $null; ageMinutes = 0; mode = 'unknown' }
try {
  $c = (orca account list --json | ConvertFrom-Json).result.rateLimits.claude
  $claude.session = $c.session.usedPercent
  $claude.weekly = $c.weekly.usedPercent
  $claude.sessionReset = Format-Reset ([long]($c.session.resetsAt / 1000))
  $claude.weeklyReset = Format-Reset ([long]($c.weekly.resetsAt / 1000))
  $claude.mode = Get-Mode $claude.session $claude.weekly $true
} catch { $claude.error = 'claude usage unavailable' }

$codex = [ordered]@{ session = $null; weekly = $null; sessionReset = $null; weeklyReset = $null; ageMinutes = $null; mode = 'unknown' }
try {
  $files = Get-ChildItem -LiteralPath "$env:USERPROFILE\.codex\sessions" -Recurse -File -Filter '*.jsonl' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 5
  $best = $null
  foreach ($f in $files) {
    $line = Get-Content -LiteralPath $f.FullName -Tail 400 -Encoding UTF8 | Where-Object { $_ -match '"rate_limits"' } | Select-Object -Last 1
    if (-not $line) { continue }
    $j = $line | ConvertFrom-Json
    $t = [DateTimeOffset]::Parse($j.timestamp)
    if ($j.payload.rate_limits.primary -and (-not $best -or $t -gt $best.time)) { $best = @{ time = $t; limits = $j.payload.rate_limits } }
  }
  if ($best) {
    $age = [math]::Round(($now - $best.time).TotalMinutes, 1)
    $codex.session = $best.limits.primary.used_percent
    $codex.weekly = $best.limits.secondary.used_percent
    $codex.sessionReset = Format-Reset $best.limits.primary.resets_at
    $codex.weeklyReset = Format-Reset $best.limits.secondary.resets_at
    $codex.ageMinutes = $age
    $codex.mode = Get-Mode $codex.session $codex.weekly ($age -le 60)
  }
} catch { $codex.error = 'codex usage unavailable' }

$rank = @{ normal = 0; conserve = 1; unknown = 2; stop = 3 }
$lead = if ($claude.mode -eq 'stop' -and $codex.mode -eq 'stop') { 'none' }
  elseif ($rank[$codex.mode] -lt $rank[$claude.mode]) { 'gpt' }
  elseif ($rank[$claude.mode] -lt $rank[$codex.mode]) { 'claude' }
  elseif ($null -ne $claude.session -and $null -ne $codex.session -and $codex.session -lt $claude.session) { 'gpt' }
  else { 'claude' }

$result = [ordered]@{ checkedAt = $now.ToString('yyyy-MM-dd HH:mm:ss'); lead = $lead; claude = $claude; gpt = $codex }
$json = $result | ConvertTo-Json -Depth 4
$tmp = "$out.tmp"
[IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $tmp -Destination $out -Force
"lead=$lead | claude $($claude.mode) session=$($claude.session)% weekly=$($claude.weekly)% reset=$($claude.sessionReset) | gpt $($codex.mode) session=$($codex.session)% weekly=$($codex.weekly)% reset=$($codex.sessionReset) age=$($codex.ageMinutes)m"
