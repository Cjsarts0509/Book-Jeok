# =========================================================================
# 북적북적 · projectmanager 거점 진단 — 어느 Cloudflare IP 로 들어가야 서울(ICN)에 닿는지 찾는다.
#
# 왜: 두 주소는 hosting.kr DNS 에 Cloudflare IP 를 직접 적어 KT 회선에서도 서울로 들어오게 했다
#     (A 104.16.0.1 · 162.159.140.16). 통신사 경로나 Cloudflare IP 운영이 바뀌면 다시 해외로 돌 수 있다.
#     서버 상태 화면의 «접속 거점»이 나빠졌을 때, 이 스크립트로 새 IP 를 골라 A 레코드만 바꾸면 된다.
#
# 실행 (KT 회선에 붙은 PC 에서 — 회사 PC 가 좋다):
#   powershell -ExecutionPolicy Bypass -File cf-ip-probe.ps1
#   powershell -ExecutionPolicy Bypass -File cf-ip-probe.ps1 -Random 40      # 무작위 후보를 더 많이
#
# 하는 일: 후보 IP 마다 DNS 를 거치지 않고 그 IP 로 직접 https://<주소>/cdn-cgi/trace 를 3번 불러
#          닿은 거점(colo)과 응답 시간(중앙값)을 잰다. 아무것도 바꾸지 않는다(읽기만).
# =========================================================================
param(
  [string]$HostName = 'bookjeok.cjslabs.kr',
  [int]$Random = 20,
  [int]$Tries = 3
)
$ErrorActionPreference = 'Continue'
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  Write-Host 'curl.exe 가 없습니다 (Windows 10 1803 이상에는 기본으로 있습니다).' -ForegroundColor Red
  exit 1
}

# 지금 hosting.kr 에 적힌 값 — DNS 로 읽고, 못 읽으면 2026-10 에 적은 값으로 본다
$Current = @()
try { $Current = @([System.Net.Dns]::GetHostAddresses($HostName) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.ToString() } | Sort-Object -Unique) } catch { }
if (-not $Current.Count) { $Current = @('104.16.0.1', '162.159.140.16') }
# 대역마다 대표 몇 개 — 2026-10 에 KT 에서 서울로 간 것(104.16.0.1 · 162.159.140.16)과 그 이웃
$Fixed = @(
  '104.16.0.1', '104.16.1.1', '104.16.132.229', '104.17.0.1', '104.18.0.1', '104.19.0.1', '104.20.0.1',
  '104.21.0.1', '104.22.0.1', '104.24.0.1', '104.25.0.1', '104.26.0.1', '104.27.0.1',
  '172.64.0.1', '172.65.0.1', '172.66.0.1', '172.67.0.1',
  '162.159.0.1', '162.159.128.1', '162.159.135.1', '162.159.136.1', '162.159.140.16', '162.159.152.4', '162.159.153.4',
  '188.114.96.1', '188.114.97.1', '141.101.64.1', '108.162.192.1', '190.93.240.1', '173.245.48.1'
)
# Cloudflare 공개 IPv4 대역 (https://www.cloudflare.com/ips-v4) — 무작위 후보를 여기서 뽑는다
$Ranges = @('173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '162.158.0.0/15',
  '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22')

$rng = New-Object System.Random
function Get-RandomIp([string]$cidr) {
  $parts = $cidr.Split('/'); $b = ([System.Net.IPAddress]::Parse($parts[0])).GetAddressBytes()
  [uint32]$base = ([uint32]$b[0] -shl 24) -bor ([uint32]$b[1] -shl 16) -bor ([uint32]$b[2] -shl 8) -bor [uint32]$b[3]
  $size = [math]::Pow(2, 32 - [int]$parts[1])
  [uint32]$n = $base + [uint32]$rng.Next(1, [int]$size - 1)
  return '{0}.{1}.{2}.{3}' -f (($n -shr 24) -band 255), (($n -shr 16) -band 255), (($n -shr 8) -band 255), ($n -band 255)
}
$cands = New-Object System.Collections.Generic.List[string]
foreach ($ip in $Current + $Fixed) { if (-not $cands.Contains($ip)) { $cands.Add($ip) } }
for ($i = 0; $i -lt $Random; $i++) { $ip = Get-RandomIp $Ranges[$rng.Next(0, $Ranges.Count)]; if (-not $cands.Contains($ip)) { $cands.Add($ip) } }

Write-Host ''
Write-Host "▶ $HostName (지금 DNS: $($Current -join ', ')) — 후보 IP $($cands.Count)개를 $Tries 번씩 시험합니다 (1~3분)..." -ForegroundColor Cyan
$rows = @()
$k = 0
foreach ($ip in $cands) {
  $k++
  Write-Progress -Activity '거점 진단' -Status "$ip ($k/$($cands.Count))" -PercentComplete ([int](100 * $k / $cands.Count))
  $times = @(); $colo = ''; $ok = $false
  for ($t = 0; $t -lt $Tries; $t++) {
    $out = & curl.exe -s -m 6 --resolve "${HostName}:443:${ip}" "https://${HostName}/cdn-cgi/trace" -w "`nTIME=%{time_total}" 2>$null
    $text = ($out -join "`n")
    if ($text -match "(?m)^h=$([regex]::Escape($HostName))\s*$" -and $text -match '(?m)^colo=([A-Z]{3})') {
      $colo = $Matches[1]; $ok = $true
      if ($text -match 'TIME=([0-9.]+)') { $times += [double]$Matches[1] }
    }
  }
  if ($ok -and $times.Count) {
    $sorted = $times | Sort-Object
    $med = [int][math]::Round($sorted[[int][math]::Floor(($sorted.Count - 1) / 2)] * 1000)
    $rows += [pscustomobject]@{ IP = $ip; 거점 = $colo; 응답ms = $med; 성공 = "$($times.Count)/$Tries"; 비고 = $(if ($Current -contains $ip) { '현재 사용 중' } else { '' }) }
  } else {
    $rows += [pscustomobject]@{ IP = $ip; 거점 = '-'; 응답ms = 99999; 성공 = "0/$Tries"; 비고 = $(if ($Current -contains $ip) { '현재 사용 중 · 응답 없음!' } else { '응답 없음' }) }
  }
}
Write-Progress -Activity '거점 진단' -Completed

$good = $rows | Where-Object { $_.거점 -eq 'ICN' } | Sort-Object 응답ms
$rest = $rows | Where-Object { $_.거점 -ne 'ICN' -and $_.거점 -ne '-' } | Sort-Object 응답ms
Write-Host ''
Write-Host '── 서울(ICN)로 가는 IP (빠른 순) ──' -ForegroundColor Green
if ($good) { $good | Format-Table -AutoSize | Out-String -Width 200 | Write-Host } else { Write-Host '  없음' -ForegroundColor Red }
Write-Host '── 다른 거점으로 가는 IP ──' -ForegroundColor Yellow
if ($rest) { $rest | Select-Object -First 15 | Format-Table -AutoSize | Out-String -Width 200 | Write-Host } else { Write-Host '  없음' }
$cur = $rows | Where-Object { $Current -contains $_.IP }
Write-Host '── 지금 쓰는 IP ──' -ForegroundColor Cyan
$cur | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

# 추천: ICN 중 빠른 것 2개, 가능하면 앞 두 자리(대역)가 다른 것끼리 — 한 대역이 통째로 틀어져도 버티게
$pick = @()
foreach ($r in $good) {
  if ($pick.Count -ge 2) { break }
  $pre = ($r.IP.Split('.')[0..1] -join '.')
  if (-not ($pick | Where-Object { ($_.IP.Split('.')[0..1] -join '.') -eq $pre })) { $pick += $r }
}
foreach ($r in $good) { if ($pick.Count -ge 2) { break }; if (-not ($pick | Where-Object { $_.IP -eq $r.IP })) { $pick += $r } }

$curOk = @($cur | Where-Object { $_.거점 -eq 'ICN' }).Count -eq $Current.Count
if ($curOk) {
  Write-Host '✅ 지금 쓰는 IP 가 모두 서울로 갑니다 — 바꿀 필요 없습니다.' -ForegroundColor Green
} elseif ($pick.Count) {
  Write-Host '⚠️ 지금 쓰는 IP 중 서울로 가지 않는 것이 있습니다. 아래 값으로 바꾸세요:' -ForegroundColor Yellow
  Write-Host "   hosting.kr → cjslabs.kr DNS → A 레코드 bookjeok · projectmanager 각각"
  foreach ($r in $pick) { Write-Host "     $($r.IP)   ($($r.응답ms)ms)" -ForegroundColor White }
  Write-Host '   바꾼 뒤 확인: nslookup bookjeok.cjslabs.kr 43.201.141.93  /  curl -s https://bookjeok.cjslabs.kr/cdn-cgi/trace | findstr colo'
} else {
  Write-Host '❌ 서울로 가는 IP 를 찾지 못했습니다. -Random 60 으로 다시 돌려 보세요.' -ForegroundColor Red
}
Write-Host ''
