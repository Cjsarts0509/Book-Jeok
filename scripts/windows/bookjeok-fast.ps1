#requires -Version 5.1
<#
  북적북적 접속 경로 고정 (KT 인터넷 느림 해결)

  KT 인터넷(IPv4)으로 Cloudflare 무료 요금제 주소(104.21.x / 172.67.x)에 접속하면
  미국 등 해외 거점으로 돌아가 1초 가까운 지연과 20% 안팎의 손실이 생긴다.
  같은 Cloudflare 라도 서울(ICN)로 잘 잡히는 주소로 직접 붙으면 3ms 로 정상이 된다.
  Cloudflare 는 접속 시 보내는 도메인 이름(SNI)만 맞으면 어느 입구 주소로 와도 같은 사이트로 처리하기 때문.

  이 스크립트는 PC 의 hosts 파일에 북적북적 두 주소를 '서울로 잡히는 Cloudflare 주소'로 적어 둔다.
  - 적용 전 hosts 를 백업한다.
  - 후보 주소를 실제로 시험해서(서울 거점 + 정상 응답) 가장 빠른 것을 고른다.
  - 언제든 '되돌리기'로 원래대로 돌아간다. 이 스크립트가 넣은 줄(# bookjeok-fast 표시)만 지운다.

  사용: bookjeok-fast.bat 을 더블클릭(관리자 권한으로 자동 실행).
  고급: powershell -ExecutionPolicy Bypass -File bookjeok-fast.ps1 -Mode apply|revert|status [-Ip 162.159.140.16]
#>
param(
  [ValidateSet('menu', 'apply', 'revert', 'status')] [string]$Mode = 'menu',
  [string]$Ip = '',                       # 후보 대신 이 주소로 고정(시험은 그대로 함)
  [string]$HostsPath = '',                # 시험용. 비우면 Windows 기본 hosts
  [switch]$SkipCheck,                     # 접속 시험 생략(시험용)
  [switch]$NoFlush,                       # DNS 캐시 비우기 생략(시험용)
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$Tag = '# bookjeok-fast'
$Names = @('bookjeok.cjs0509.xyz', 'bookjeok-api.cjs0509.xyz')
$ApiName = 'bookjeok-api.cjs0509.xyz'
$WebName = 'bookjeok.cjs0509.xyz'
# KT 회선에서 서울(ICN)로 잡히는 것을 확인한 Cloudflare 주소들(2026-10 측정, 둘 다 3ms)
$Candidates = @('104.16.0.1', '162.159.140.16')

$onWindows = ($env:OS -eq 'Windows_NT')
if (-not $HostsPath) { $HostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts' }

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# Windows PowerShell 에서 'curl' 은 다른 명령의 별명이라 반드시 curl.exe 를 쓴다.
$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curl) { $curl = Get-Command curl -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 }
$curlPath = if ($curl) { $curl.Source } else { $null }

# 한 주소로 접속해 본다. $ip 가 비면 지금 PC 가 쓰는 경로(DNS 또는 hosts) 그대로.
function Probe([string]$ip) {
  $r = [pscustomobject]@{ Ip = $ip; Colo = ''; Code = ''; Seconds = $null; WebCode = ''; Ok = $false }
  if (-not $curlPath) { return $r }
  $resolveApi = @(); $resolveWeb = @()
  if ($ip) { $resolveApi = @('--resolve', "${ApiName}:443:$ip"); $resolveWeb = @('--resolve', "${WebName}:443:$ip") }
  try {
    $trace = & $curlPath -s -m 8 @resolveApi "https://$ApiName/cdn-cgi/trace" 2>$null
    $m = [regex]::Match(($trace -join "`n"), '(?m)^colo=(\w+)')
    if ($m.Success) { $r.Colo = $m.Groups[1].Value }
    $nul = if ($onWindows) { 'NUL' } else { '/dev/null' }
    $h = & $curlPath -s -o $nul -m 10 -w '%{http_code} %{time_total}' @resolveApi "https://$ApiName/api/health" 2>$null
    $parts = "$h".Trim().Split(' ')
    if ($parts.Count -ge 2) { $r.Code = $parts[0]; $r.Seconds = [double]::Parse($parts[1], [Globalization.CultureInfo]::InvariantCulture) }
    $r.WebCode = "$(& $curlPath -s -o $nul -m 10 -w '%{http_code}' @resolveWeb "https://$WebName/" 2>$null)".Trim()
  } catch { }
  $r.Ok = ($r.Code -eq '200' -and $r.WebCode -eq '200')
  return $r
}

function Show([object]$p, [string]$label) {
  if (-not $curlPath) { Say "  $label : (curl.exe 가 없어 확인 불가 - Windows 10 1803 이상 필요)" 'Yellow'; return }
  if (-not $p.Code -or $p.Code -eq '000') { Say "  $label : 접속 실패" 'Red'; return }
  $t = if ($p.Seconds -ne $null) { '{0:N2}초' -f $p.Seconds } else { '?' }
  $where = if ($p.Colo -eq 'ICN') { '서울(ICN)' } elseif ($p.Colo) { "$($p.Colo) - 해외 거점" } else { '?' }
  $color = if ($p.Colo -eq 'ICN' -and $p.Ok) { 'Green' } elseif ($p.Ok) { 'Yellow' } else { 'Red' }
  Say ("  {0} : 거점 {1} · 응답 {2} · 상태 {3}/{4}" -f $label, $where, $t, $p.Code, $p.WebCode) $color
}

function Read-HostsLines {
  if (-not (Test-Path -LiteralPath $HostsPath)) { return @() }
  return [IO.File]::ReadAllLines($HostsPath, [Text.Encoding]::Default)
}
function Write-HostsLines([string[]]$lines) {
  $item = Get-Item -LiteralPath $HostsPath -ErrorAction SilentlyContinue
  $wasRO = $false
  if ($item -and $item.IsReadOnly) { $wasRO = $true; $item.IsReadOnly = $false }
  try { [IO.File]::WriteAllLines($HostsPath, $lines, [Text.Encoding]::Default) }
  finally { if ($wasRO) { (Get-Item -LiteralPath $HostsPath).IsReadOnly = $true } }
}
# 이 스크립트가 넣은 줄 + 같은 두 주소를 가리키는 줄(겹치면 충돌하므로)
function Is-OurLine([string]$line) {
  if ($line -match [regex]::Escape($Tag)) { return $true }
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith('#')) { return $false }
  $tokens = $t -split '\s+'
  foreach ($n in $Names) { if ($tokens.Count -ge 2 -and ($tokens[1..($tokens.Count - 1)] -contains $n)) { return $true } }
  return $false
}
function Current-Mapping { return @(Read-HostsLines | Where-Object { Is-OurLine $_ }) }

function Flush-Dns {
  if ($NoFlush -or -not $onWindows) { return }
  try { ipconfig /flushdns | Out-Null } catch { }
}

function Do-Status {
  Say ''
  Say '[현재 상태]' 'Cyan'
  $map = Current-Mapping
  $ours = @($map | Where-Object { $_ -match [regex]::Escape($Tag) })
  if ($ours.Count) { Say '  hosts 고정: 적용됨' 'Green'; $ours | ForEach-Object { Say "    $_" } }
  $others = @($map | Where-Object { $_ -notmatch [regex]::Escape($Tag) })
  if ($others.Count) {
    Say '  hosts 에 북적북적 주소를 가리키는 다른 줄이 있습니다(적용하면 백업 후 정리됩니다):' 'Yellow'
    $others | ForEach-Object { Say "    $_" }
  }
  if (-not $map.Count) { Say '  hosts 고정: 없음 (기본 경로 사용)' }
  if (-not $SkipCheck) { Show (Probe '') '지금 이 PC의 접속' }
}

function Do-Apply {
  Say ''
  Say '[적용] 서울로 잡히는 입구 주소를 찾는 중…' 'Cyan'
  $chosen = $null
  if ($SkipCheck) {
    $chosen = if ($Ip) { $Ip } else { $Candidates[0] }
  } else {
    if (-not $curlPath) { Say '  curl.exe 를 찾지 못했습니다. Windows 10(1803) 이상에서 실행해 주세요.' 'Red'; return $false }
    $list = if ($Ip) { @($Ip) } else { $Candidates }
    $best = $null
    foreach ($c in $list) {
      $p = Probe $c
      Show $p "후보 $c"
      if ($p.Ok -and $p.Colo -eq 'ICN') { if (-not $best -or $p.Seconds -lt $best.Seconds) { $best = $p } }
    }
    if (-not $best) {
      Say '  서울로 잡히면서 정상 응답하는 주소가 없습니다. hosts 는 바꾸지 않았습니다.' 'Red'
      Say '  (인터넷 연결을 확인하시거나, 관리자에게 이 화면을 보내 주세요.)' 'Yellow'
      return $false
    }
    $chosen = $best.Ip
  }

  $backup = "$HostsPath.bookjeok-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $HostsPath -Destination $backup -Force
  $kept = @(Read-HostsLines | Where-Object { -not (Is-OurLine $_) })
  $add = $Names | ForEach-Object { "$chosen`t$_`t$Tag" }
  try { Write-HostsLines ($kept + $add) }
  catch {
    Say "  hosts 파일을 쓰지 못했습니다: $($_.Exception.Message)" 'Red'
    Say '  관리자 권한으로 실행했는지, 백신이 hosts 변경을 막고 있지 않은지 확인해 주세요.' 'Yellow'
    return $false
  }
  Flush-Dns
  Say "  적용 완료 → $chosen (백업: $backup)" 'Green'
  if (-not $SkipCheck) { Show (Probe '') '적용 후 이 PC의 접속' }
  Say ''
  Say '  브라우저를 완전히 닫았다가 다시 여세요.' 'Cyan'
  Say "  그래도 느리면 브라우저 설정에서 '보안 DNS'를 꺼 주세요(웨일·크롬 공통)."
  return $true
}

function Do-Revert {
  Say ''
  Say '[되돌리기]' 'Cyan'
  $map = Current-Mapping
  if (-not $map.Count) { Say '  고정된 줄이 없습니다. 이미 원래 상태입니다.'; return $true }
  $backup = "$HostsPath.bookjeok-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $HostsPath -Destination $backup -Force
  try { Write-HostsLines @(Read-HostsLines | Where-Object { -not (Is-OurLine $_) }) }
  catch { Say "  hosts 파일을 쓰지 못했습니다: $($_.Exception.Message)" 'Red'; return $false }
  Flush-Dns
  Say "  원래대로 되돌렸습니다. ($($map.Count)줄 삭제, 백업: $backup)" 'Green'
  return $true
}

Say '=============================================' 'Cyan'
Say '  북적북적 접속 경로 고정 (KT 인터넷 느림 해결)' 'Cyan'
Say '=============================================' 'Cyan'

switch ($Mode) {
  'apply'  { [void](Do-Apply) }
  'revert' { [void](Do-Revert) }
  'status' { Do-Status }
  default {
    Do-Status
    Say ''
    Say '  1) 적용 — 서울 경로로 고정'
    Say '  2) 되돌리기 — 원래대로'
    Say '  3) 상태 다시 확인'
    Say '  Q) 종료'
    $choice = Read-Host '번호를 입력하고 Enter'
    switch ("$choice".Trim().ToUpper()) {
      '1' { [void](Do-Apply) }
      '2' { [void](Do-Revert) }
      '3' { Do-Status }
      default { }
    }
  }
}
if (-not $NoPause -and $Mode -eq 'menu') { Say ''; [void](Read-Host '창을 닫으려면 Enter') }
