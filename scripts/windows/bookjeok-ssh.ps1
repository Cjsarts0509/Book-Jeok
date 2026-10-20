#requires -Version 5.1
<#
  북적북적 서버(오라클) SSH 접속 설정 — PC 마다 한 번

  왜 필요한가
    Windows 의 ssh 는 개인키 파일을 '나 말고 다른 계정도 읽을 수 있으면' 쓰지 않고 버린다
    (WARNING: UNPROTECTED PRIVATE KEY FILE → Permission denied (publickey)).
    Windows 는 파일을 복사 · 이동하면 새 폴더의 권한(Users · Everyone · Authenticated Users …)을 물려받는다.
    그래서 키 파일 하나를 바탕화면 · USB · 다른 PC 로 옮겨 다니며 쓰면, 옮길 때마다 언제든 다시 막힌다.

  근본 해결
    1) PC 마다 자기 키를 따로 만든다(ssh-keygen). 키는 그 PC 의 %USERPROFILE%\.ssh 밖으로 나가지 않는다.
    2) 그 PC 의 공개키(.pub — 남에게 보여도 되는 쪽)만 서버에 등록한다.
    3) 접속 정보는 ~/.ssh/config 에 'bookjeok' 이라는 이름으로 적어 둔다 → 어느 PC 에서든 `ssh bookjeok`.
    키를 복사할 일이 없으니 권한이 다시 풀릴 일도 없다. PC 를 잃어버리면 그 PC 의 키만 서버에서 지우면 된다.

  사용: bookjeok-ssh.bat 더블클릭(관리자 권한 필요 없음).
  고급: powershell -ExecutionPolicy Bypass -File bookjeok-ssh.ps1 -Mode setup|status|fix|import [-KeyPath <파일>]
#>
param(
  [ValidateSet('menu', 'setup', 'status', 'fix', 'import')] [string]$Mode = 'menu',
  [string]$KeyPath = '',                  # import: 그대로 쓸 키 / status: 원인을 볼 키 파일
  [string]$ServerHost = '168.110.104.214',
  [string]$ServerUser = 'ubuntu',
  [string]$Alias = 'bookjeok',
  [string]$SshDir = '',                   # 시험용. 비우면 %USERPROFILE%\.ssh
  [switch]$NoTest,                        # 접속 시험 생략(시험용)
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$onWindows = ($env:OS -eq 'Windows_NT')
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
if (-not $SshDir) { $SshDir = Join-Path $HomeDir '.ssh' }
$ConfigPath = Join-Path $SshDir 'config'
$MarkBegin = "# >>> $Alias (managed by bookjeok-ssh.ps1)"
$MarkEnd = "# <<< $Alias"

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# ---------- 이름 ----------
function Get-SafeName([string]$s) { (($s -replace '[^A-Za-z0-9_-]', '').ToLower()) }
function Get-PcName {
  $n = Get-SafeName $env:COMPUTERNAME
  if (-not $n) { $n = Get-SafeName ([System.Net.Dns]::GetHostName()) }
  if (-not $n -or $n -eq 'pc') {
    # PC 이름이 한글 등이라 영문이 안 남으면 PC 이름에서 짧은 고유 번호를 만든다(PC 마다 다르고, 같은 PC 에선 늘 같음)
    $src = "$env:COMPUTERNAME|$([System.Net.Dns]::GetHostName())"
    $h = [System.BitConverter]::ToString([System.Security.Cryptography.SHA1]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($src))).Replace('-', '').Substring(0, 6).ToLower()
    $n = "pc-$h"
  }
  $n
}
function Get-KeyFileName { "bookjeok_$(Get-PcName)" }
function Get-KeyComment {
  $u = Get-SafeName $env:USERNAME
  if (-not $u) { $u = 'user' }
  "bookjeok-$(Get-PcName)-$u-$(Get-Date -Format yyyyMMdd)"
}

# ---------- 외부 명령(ssh · ssh-keygen) ----------
# PowerShell 5.1 은 외부 명령의 stderr 를 오류로 바꿔 스크립트를 멈출 수 있다 → 이 안에서만 Continue
function Invoke-Native([string]$exe, [string[]]$argv) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    $out = & $exe @argv 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = @($out) }
  } finally { $ErrorActionPreference = $prev }
}
function Test-SshTools {
  $miss = @('ssh', 'ssh-keygen') | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
  if ($miss) {
    Say "  [!] 이 PC 에 OpenSSH 클라이언트가 없습니다 ($($miss -join ', '))." Yellow
    Say '      설정 → 시스템 → 선택적 기능 → 기능 추가 → "OpenSSH 클라이언트" 설치 후 다시 실행하세요.' Yellow
    return $false
  }
  $true
}

# ---------- 파일 권한 ----------
$SidSystem = 'S-1-5-18'
$SidAdmins = 'S-1-5-32-544'
function Get-MySid { [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
function Get-SidName([string]$sid) {
  try { (New-Object System.Security.Principal.SecurityIdentifier($sid)).Translate([System.Security.Principal.NTAccount]).Value } catch { $sid }
}
# 읽기로 치는 권한: ReadData(1) · GenericAll(0x10000000) · GenericRead(0x80000000)
$ReadBits = 0x1 -bor 0x10000000 -bor ([int]0x80000000)

# ssh 가 문제 삼는 '나 · SYSTEM · Administrators 말고 읽을 수 있는 계정' 목록
function Get-BadReaders([string]$Path) {
  if (-not $onWindows) {
    $mode = (& stat -c '%a' -- $Path 2>$null)
    if ($mode -and ([int]"0$($mode.Substring($mode.Length - 2))" -ne 0)) { return @([pscustomobject]@{ Name = "group/other ($mode)"; Sid = ''; Inherited = $false }) }
    return @()
  }
  $me = Get-MySid
  $acl = Get-Acl -LiteralPath $Path
  $bad = @()
  foreach ($r in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($r.AccessControlType -ne 'Allow') { continue }
    if (([int]$r.FileSystemRights -band $ReadBits) -eq 0) { continue }
    $sid = $r.IdentityReference.Value
    if ($sid -in @($me, $SidSystem, $SidAdmins)) { continue }
    $bad += [pscustomobject]@{ Name = (Get-SidName $sid); Sid = $sid; Inherited = $r.IsInherited }
  }
  $bad
}
function Test-OwnerIsMe([string]$Path) {
  if (-not $onWindows) { return $true }
  $o = (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $o -in @((Get-MySid), $SidSystem, $SidAdmins)
}

# 나 + SYSTEM 만 남기고 상속을 끊는다. 주인이 다른 계정이면 내용을 새 파일로 다시 써서 주인을 나로 만든다.
function Lock-File([string]$Path) {
  if (-not $onWindows) { & chmod 600 -- $Path; return }
  if (-not (Test-OwnerIsMe $Path)) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    Remove-Item -LiteralPath $Path -Force
    [System.IO.File]::WriteAllBytes($Path, $bytes)
  }
  $me = New-Object System.Security.Principal.SecurityIdentifier((Get-MySid))
  $sys = New-Object System.Security.Principal.SecurityIdentifier($SidSystem)
  try {
    # 권한 목록(DACL)만 바꿔 쓴다 — Set-Acl 은 주인 정보까지 쓰려다 실패하는 PC 가 있다
    $fi = New-Object System.IO.FileInfo($Path)
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($r in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) { [void]$acl.RemoveAccessRuleAll($r) }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sys, 'FullControl', 'Allow')))
    if ($fi | Get-Member -Name SetAccessControl -MemberType Method) { $fi.SetAccessControl($acl) }   # Windows PowerShell 5.1
    else { [System.IO.FileSystemAclExtensions]::SetAccessControl($fi, $acl) }                          # PowerShell 7
  } catch {
    # 예비: icacls (계정 이름 대신 SID 로 — 한글 Windows 에서도 같다)
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
      & icacls $Path /inheritance:r /grant:r "*$($me.Value):(F)" "*$($SidSystem):(F)" | Out-Null
      foreach ($b in @(Get-BadReaders $Path)) { if ($b.Sid) { & icacls $Path /remove:g "*$($b.Sid)" | Out-Null } }
    } finally { $ErrorActionPreference = $prev }
  }
  if (@(Get-BadReaders $Path).Count) { throw "권한을 잠그지 못했습니다: $Path" }
}

# 문제 계정의 권한이 어느 폴더에서 내려왔는지 위로 거슬러 찾는다
function Find-PermissionSource([string]$Path, [string]$Sid) {
  if (-not $onWindows -or -not $Sid) { return $null }
  $d = Split-Path -Parent $Path
  while ($d) {
    try {
      $acl = Get-Acl -LiteralPath $d
      foreach ($r in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
        if ($r.IdentityReference.Value -eq $Sid -and $r.AccessControlType -eq 'Allow' -and (([int]$r.FileSystemRights -band $ReadBits) -ne 0)) { return $d }
      }
      if ($acl.AreAccessRulesProtected) { return $d }
    } catch { return $null }
    $p = Split-Path -Parent $d
    if ($p -eq $d) { break }
    $d = $p
  }
  $null
}

function Show-KeyPermission([string]$Path) {
  $bad = @(Get-BadReaders $Path)
  $ownerOk = Test-OwnerIsMe $Path
  if (-not $bad.Count -and $ownerOk) { Say '    권한: 정상 (나만 읽을 수 있음)' Green; return $true }
  if (-not $ownerOk) { Say '    권한: 파일 주인이 다른 계정입니다 → ssh 가 이 키를 쓰지 않습니다' Yellow }
  if ($bad.Count) {
    Say '    권한: 나 말고 아래 계정도 읽을 수 있어 ssh 가 이 키를 버립니다' Yellow
    foreach ($b in $bad) {
      $from = if ($b.Inherited) { Find-PermissionSource $Path $b.Sid } else { $null }
      $how = if ($b.Inherited) { if ($from) { "← '$from' 폴더에서 물려받음" } else { '← 위쪽 폴더에서 물려받음' } } else { '← 이 파일에 직접 걸림' }
      Say "      - $($b.Name)  $how" Yellow
    }
  }
  if ($env:OneDrive -and $Path.StartsWith($env:OneDrive, [System.StringComparison]::OrdinalIgnoreCase)) {
    Say '    참고: OneDrive 동기화 폴더 안에 있는 파일입니다. 키는 OneDrive 밖(.ssh)에 두는 게 안전합니다.' Yellow
  }
  $false
}

# ---------- ~/.ssh/config ----------
# 기본 .ssh 폴더면 '~/.ssh/이름'(사용자 폴더 이름이 한글이어도 안전), 아니면 전체 경로
function Get-IdentityPath([string]$KeyFile) {
  $a = [System.IO.Path]::GetFullPath($SshDir).TrimEnd('\', '/')
  $b = [System.IO.Path]::GetFullPath((Join-Path $HomeDir '.ssh')).TrimEnd('\', '/')
  if ($a -eq $b) { return "~/.ssh/$KeyFile" }
  $full = (Join-Path $SshDir $KeyFile) -replace '\\', '/'
  if ($full -match '\s') { return "`"$full`"" }
  $full
}
function Get-ConfigBlock([string]$KeyFile) {
  @(
    $MarkBegin,
    "Host $Alias",
    "  HostName $ServerHost",
    "  User $ServerUser",
    "  IdentityFile $(Get-IdentityPath $KeyFile)",
    '  IdentitiesOnly yes',
    '  ServerAliveInterval 30',
    $MarkEnd
  ) -join "`n"
}

# 우리 블록을 맨 앞에 두고(ssh 는 먼저 나온 설정을 쓴다), 예전에 손으로 넣은 'Host <별칭>' 블록은 뺀다
function Update-ConfigText([string]$Text, [string]$Block) {
  $lines = @(($Text -replace "`r`n", "`n") -split "`n")
  $keep = New-Object System.Collections.Generic.List[string]
  $inManaged = $false; $inOld = $false; $removedOld = 0
  foreach ($l in $lines) {
    $t = $l.Trim()
    if ($t -eq $MarkBegin.Trim()) { $inManaged = $true; continue }
    if ($inManaged) { if ($t -eq $MarkEnd.Trim()) { $inManaged = $false }; continue }
    if ($t -match '^(?i)(host|match)\s') {
      $inOld = ($t -match "^(?i)host\s+$([regex]::Escape($Alias))\s*$")
      if ($inOld) { $removedOld++; continue }
    }
    if ($inOld) { continue }
    $keep.Add($l)
  }
  $rest = (($keep -join "`n").Trim("`n"))
  # 원래 맨 앞에 Host 없이 적혀 있던 공통 설정은 우리 블록 뒤로 가면 우리 블록에만 붙어 버린다 → 'Host *' 로 감싼다
  $first = @($keep | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') } | Select-Object -First 1)
  if ($first.Count -and $first[0].Trim() -notmatch '^(?i)(host|match)\s') { $rest = "Host *`n" + $rest }
  $new = if ($rest) { $Block + "`n`n" + $rest + "`n" } else { $Block + "`n" }
  [pscustomobject]@{ Text = $new; RemovedOld = $removedOld }
}

function Write-Config([string]$KeyFile) {
  $old = if (Test-Path -LiteralPath $ConfigPath) { [System.IO.File]::ReadAllText($ConfigPath) } else { '' }
  $r = Update-ConfigText $old (Get-ConfigBlock $KeyFile)
  if ($old -and $old -ne $r.Text) { Copy-Item -LiteralPath $ConfigPath -Destination "$ConfigPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force }
  [System.IO.File]::WriteAllText($ConfigPath, $r.Text, (New-Object System.Text.UTF8Encoding($false)))
  if ((@(Get-BadReaders $ConfigPath).Count) -or -not (Test-OwnerIsMe $ConfigPath)) { Lock-File $ConfigPath }
  if ($r.RemovedOld) { Say "  예전에 직접 넣은 'Host $Alias' 설정 $($r.RemovedOld)개를 새 설정으로 바꿨습니다 (원본은 config.bak-* 로 보관)." DarkGray }
}

function Get-ManagedKeyPath {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { return $null }
  $in = $false
  foreach ($l in [System.IO.File]::ReadAllLines($ConfigPath)) {
    $t = $l.Trim()
    if ($t -eq $MarkBegin.Trim()) { $in = $true; continue }
    if ($in -and $t -eq $MarkEnd.Trim()) { break }
    if ($in -and $t -match '^(?i)IdentityFile\s+(.+)$') { return (Resolve-HomePath $Matches[1].Trim('"')) }
  }
  $null
}
function Resolve-HomePath([string]$p) { if ($p -match '^~[\\/]') { Join-Path $HomeDir $p.Substring(2) } else { $p } }

# ---------- 서버 ----------
$SshCommon = @('-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'PreferredAuthentications=publickey')
function Test-Login {
  if ($NoTest) { return $false }
  $r = Invoke-Native 'ssh' ($SshCommon + @('-F', $ConfigPath, $Alias, 'echo BOOKJEOK_SSH_OK'))
  [bool]($r.Out -match 'BOOKJEOK_SSH_OK')
}
function Get-RegisterCommand([string]$PubLine) {
  $b64 = ($PubLine -split '\s+')[1]
  "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qF '$b64' ~/.ssh/authorized_keys || echo '$PubLine' >> ~/.ssh/authorized_keys) && echo BOOKJEOK_KEY_OK"
}
function Read-PathInput([string]$prompt, [string]$default) {
  $hint = if ($default) { " [Enter = $default]" } else { '' }
  $v = (Read-Host "$prompt$hint").Trim().Trim('"').Trim("'")
  if (-not $v) { $v = $default }
  $v
}

# 이미 접속되는 다른 키(예: 예전에 같이 쓰던 키)로 이 PC 의 공개키를 서버에 넣는다
function Register-WithOldKey([string]$PubLine) {
  $guess = Join-Path $SshDir 'oracle-bookjeok.key'
  if (-not (Test-Path -LiteralPath $guess)) { $guess = '' }
  $old = Read-PathInput '  지금 접속되는 키 파일 위치(파일을 이 창에 끌어다 놓아도 됩니다)' $guess
  if (-not $old -or -not (Test-Path -LiteralPath $old)) { Say '  키 파일을 찾지 못했습니다.' Yellow; return $false }
  $tmp = Join-Path $SshDir 'bookjeok_tmp_register'
  try {
    Copy-Item -LiteralPath $old -Destination $tmp -Force
    Lock-File $tmp
    Say '  서버에 공개키를 등록하는 중…' Gray
    $r = Invoke-Native 'ssh' ($SshCommon + @('-F', 'none', '-o', 'IdentitiesOnly=yes', '-i', $tmp, "$ServerUser@$ServerHost", (Get-RegisterCommand $PubLine)))
    if ($r.Out -match 'BOOKJEOK_KEY_OK') { return $true }
    Say '  등록 실패:' Yellow; $r.Out | Select-Object -Last 5 | ForEach-Object { Say "    $_" DarkGray }
    $false
  } finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
}

function Show-ManualRegister([string]$PubLine) {
  $cmd = Get-RegisterCommand $PubLine
  Say ''
  Say '  다른 PC 에서 서버에 접속한 창(ubuntu@bookpulse-arm-2:~$)에 아래 한 줄을 붙여 넣고 Enter:' Cyan
  Say ''
  Say "  $cmd" White
  Say ''
  try { Set-Clipboard -Value $cmd; Say '  (위 줄을 클립보드에 복사해 두었습니다 — 서버 창에서 오른쪽 클릭 또는 Ctrl+V)' DarkGray } catch { }
  Say '  BOOKJEOK_KEY_OK 가 나오면 등록된 것입니다. 이 줄에는 공개키만 들어 있어 메신저로 보내도 괜찮습니다.' DarkGray
}

# ---------- 메뉴 동작 ----------
function Invoke-Setup {
  if (-not (Test-SshTools)) { return }
  New-Item -ItemType Directory -Force -Path $SshDir | Out-Null
  $name = Get-KeyFileName
  # 이미 이 도구로 만든 키가 설정돼 있으면(이름 규칙이 바뀌었어도) 그 키를 그대로 쓴다
  $cur = Get-ManagedKeyPath
  if ($cur -and (Test-Path -LiteralPath $cur) -and ((Split-Path -Leaf $cur) -like 'bookjeok_*') -and ((Split-Path -Leaf $cur) -ne 'bookjeok_shared')) { $name = Split-Path -Leaf $cur }
  $key = Join-Path $SshDir $name
  if (Test-Path -LiteralPath $key) {
    Say "  이 PC 의 키가 이미 있습니다: $key (그대로 씁니다)" Gray
  } else {
    Say "  이 PC 전용 키를 만듭니다: $key" Cyan
    Say '  암호(passphrase)를 물으면: 그냥 Enter 두 번 = 암호 없이(편함) / 암호 입력 = 접속할 때마다 암호(더 안전)' DarkGray
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & ssh-keygen -t ed25519 -f $key -C (Get-KeyComment) } finally { $ErrorActionPreference = $prev }
    if (-not (Test-Path -LiteralPath $key)) { Say '  키를 만들지 못했습니다.' Red; return }
  }
  if (-not (Test-Path -LiteralPath "$key.pub")) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $pubText = & ssh-keygen -y -f $key } finally { $ErrorActionPreference = $prev }
    if (-not $pubText) { Say '  공개키(.pub)를 다시 만들지 못했습니다.' Red; return }
    [System.IO.File]::WriteAllText("$key.pub", "$(($pubText -join '').Trim()) $(Get-KeyComment)`n", (New-Object System.Text.UTF8Encoding($false)))
  }
  Lock-File $key
  Write-Config $name
  Say "  접속 설정을 적었습니다: $ConfigPath  (이름: $Alias)" Green
  $pub = ([System.IO.File]::ReadAllText("$key.pub")).Trim()

  if ($NoTest) { Show-ManualRegister $pub; return }
  Say '  서버 접속을 시험합니다…' Gray
  if (Test-Login) { Say "  [성공] 이미 등록되어 있습니다. 이제 'ssh $Alias' 만 입력하면 접속됩니다." Green; return }

  Say ''
  Say '  이 PC 의 공개키를 서버에 등록해야 합니다.' Cyan
  Say '    1) 지금 접속되는 다른 키 파일(예전에 같이 쓰던 키)이 이 PC 에 있다 → 자동 등록'
  Say '    2) 없다 → 다른 PC 에서 붙여 넣을 한 줄을 보여 주기'
  $c = (Read-Host '  선택 (1/2)').Trim()
  if ($c -eq '1') {
    if (Register-WithOldKey $pub) {
      if (Test-Login) { Say "  [성공] 등록 완료. 이제 'ssh $Alias' 만 입력하면 접속됩니다." Green }
      else { Say '  등록은 됐는데 접속 시험이 실패했습니다. 메뉴 2(상태 확인)를 실행해 화면을 보내 주세요.' Yellow }
    }
  } else {
    Show-ManualRegister $pub
    Say "  등록한 뒤 이 PC 에서 'ssh $Alias' 로 접속해 보세요." Gray
  }
}

function Invoke-Status {
  if (-not (Test-SshTools)) { return }
  $v = Invoke-Native 'ssh' @('-V')
  Say "  ssh 버전: $($v.Out -join ' ')" Gray
  $key = Get-ManagedKeyPath
  if (-not $key) { Say "  접속 설정('$Alias')이 아직 없습니다 → 메뉴 1 을 실행하세요." Yellow }
  else {
    Say "  접속 설정: $ConfigPath → 키 $key" Gray
    if (Test-Path -LiteralPath $key) { [void](Show-KeyPermission $key) } else { Say '    키 파일이 없습니다 → 메뉴 1 을 다시 실행하세요.' Yellow }
    if (-not $NoTest) {
      if (Test-Login) { Say "  서버 접속: [성공] ('ssh $Alias')" Green } else { Say '  서버 접속: [실패] 키가 서버에 등록되지 않았거나 권한 문제입니다.' Yellow }
    }
  }
  $p = if ($KeyPath) { $KeyPath } elseif ($Mode -eq 'menu') { Read-PathInput '  (선택) 왜 막혔는지 볼 다른 키 파일 — 예: 바탕화면의 예전 키. 건너뛰려면 Enter' '' } else { '' }
  if ($p) {
    if (Test-Path -LiteralPath $p) { Say "  [$p]" Gray; [void](Show-KeyPermission $p) } else { Say "  파일이 없습니다: $p" Yellow }
  }
}

function Get-PrivateKeyFiles {
  if (-not (Test-Path -LiteralPath $SshDir)) { return @() }
  Get-ChildItem -LiteralPath $SshDir -File | Where-Object {
    $_.Extension -ne '.pub' -and $_.Length -lt 20000 -and $(try { (Get-Content -LiteralPath $_.FullName -TotalCount 1) -match 'PRIVATE KEY-----' } catch { $false })
  }
}

function Invoke-Fix {
  $files = @(Get-PrivateKeyFiles)
  if (Test-Path -LiteralPath $ConfigPath) { $files += Get-Item -LiteralPath $ConfigPath }
  if (-not $files.Count) { Say "  $SshDir 에 키 파일이 없습니다." Gray; return }
  foreach ($f in $files) {
    $needs = (@(Get-BadReaders $f.FullName).Count -gt 0) -or -not (Test-OwnerIsMe $f.FullName)
    if ($needs) { Lock-File $f.FullName; Say "  고침: $($f.Name)" Green } else { Say "  정상: $($f.Name)" DarkGray }
  }
}

function Invoke-Import {
  if (-not (Test-SshTools)) { return }
  $src = if ($KeyPath) { $KeyPath } else { Read-PathInput '  그대로 쓸 키 파일 위치(파일을 끌어다 놓아도 됩니다)' '' }
  if (-not $src -or -not (Test-Path -LiteralPath $src)) { Say '  키 파일을 찾지 못했습니다.' Yellow; return }
  New-Item -ItemType Directory -Force -Path $SshDir | Out-Null
  $name = 'bookjeok_shared'
  $dst = Join-Path $SshDir $name
  Copy-Item -LiteralPath $src -Destination $dst -Force
  Lock-File $dst
  Write-Config $name
  Say "  키를 $dst 로 복사해 잠그고 접속 설정을 적었습니다." Green
  Say '  (임시 방법입니다. 시간이 될 때 메뉴 1 로 이 PC 전용 키를 만드세요.)' DarkGray
  if (-not $NoTest) { if (Test-Login) { Say "  [성공] 'ssh $Alias' 로 접속됩니다." Green } else { Say '  접속 시험 실패 — 이 키가 서버에 등록된 키인지 확인하세요.' Yellow } }
}

function Show-Menu {
  while ($true) {
    Say ''
    Say '  ===== 북적북적 서버 SSH 접속 설정 =====' Cyan
    Say "  서버 $ServerUser@$ServerHost  ·  이 PC: $(Get-PcName)"
    Say ''
    Say '  1) 이 PC 전용 키 만들기 + 서버 등록   (처음 한 번, 권장)'
    Say '  2) 상태 확인 · 막힌 원인 보기'
    Say '  3) 키 파일 권한 고치기 (.ssh 안의 키 전부)'
    Say '  4) 예전 키 파일 그대로 쓰기 (임시)'
    Say '  0) 끝내기'
    $c = (Read-Host '  번호').Trim()
    switch ($c) {
      '1' { Invoke-Setup }
      '2' { Invoke-Status }
      '3' { Invoke-Fix }
      '4' { Invoke-Import }
      '0' { return }
      default { Say '  0~4 중에서 고르세요.' Yellow }
    }
  }
}

# 점(.)으로 불러오면 함수만 정의한다(시험용)
if ($MyInvocation.InvocationName -ne '.') {
  try {
    switch ($Mode) {
      'menu' { Show-Menu }
      'setup' { Invoke-Setup }
      'status' { Invoke-Status }
      'fix' { Invoke-Fix }
      'import' { Invoke-Import }
    }
  } catch {
    Say "  오류: $($_.Exception.Message)" Red
  }
  if (-not $NoPause -and $Mode -ne 'menu') { [void](Read-Host '  Enter 를 누르면 닫힙니다') }
}
