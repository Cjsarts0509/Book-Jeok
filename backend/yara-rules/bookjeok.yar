/*
  북적북적 업로드 악성 패턴 룰셋 (클래식 YARA)
  - 목적: 확장자·매직바이트 다음 단계로 "명백히 악성 의도"인 파일을 차단.
  - 방침: 오탐(정상 업무파일 차단) 최소화 — 일반 문서/이미지엔 나올 수 없는
          고신뢰 패턴만 사용. 전부 로컬 매칭(외부 전송 없음).
*/

rule EICAR_Test_File
{
  meta:
    description = "EICAR 표준 백신 테스트 파일(동작 확인용)"
    severity = "test"
  strings:
    $eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
  condition:
    $eicar
}

rule PHP_Webshell
{
  meta:
    description = "PHP 웹셸(사용자 입력을 코드/명령으로 실행)"
    severity = "high"
  strings:
    $php  = "<?"
    $a1 = /eval\s*\(\s*\$_(POST|GET|REQUEST|COOKIE|SERVER)/ nocase
    $a2 = /assert\s*\(\s*\$_(POST|GET|REQUEST|COOKIE)/ nocase
    $a3 = /(system|shell_exec|exec|passthru|popen|proc_open)\s*\(\s*\$_(POST|GET|REQUEST|COOKIE)/ nocase
    $a4 = /preg_replace\s*\(\s*['"].*\/e['"]/ nocase
    $a5 = "c99shell" nocase
    $a6 = "r57shell" nocase
    $a7 = "b374k" nocase
    $a8 = "FilesMan" nocase
  condition:
    $php and any of ($a*)
}

rule JSP_Webshell
{
  meta:
    description = "JSP 웹셸(명령 실행)"
    severity = "high"
  strings:
    $j  = "<%"
    $r  = "Runtime.getRuntime().exec("
    $p  = "ProcessBuilder"
    $req = "getParameter"
  condition:
    $j and ($r or $p) and $req
}

rule ASP_Webshell
{
  meta:
    description = "ASP/ASPX 웹셸(요청을 코드/셸로 실행)"
    severity = "high"
  strings:
    $a1 = /eval\s*\(\s*Request/ nocase
    $a2 = /execute\s*\(\s*Request/ nocase
    $a3 = "CreateObject(\"WScript.Shell\")" nocase
    $a4 = "Server.CreateObject(\"WSCRIPT.SHELL\")" nocase
  condition:
    any of them
}

rule Suspicious_PowerShell
{
  meta:
    description = "난독화 파워셸(인코딩 실행/원격 다운로드 실행)"
    severity = "high"
  strings:
    $enc = /-e(nc|ncodedcommand)?\s+[A-Za-z0-9+\/=]{40,}/ nocase
    $b64 = "FromBase64String" nocase
    $iex = /IEX\s*\(/ nocase
    $inv = "Invoke-Expression" nocase
    $dl  = "DownloadString" nocase
    $dl2 = "DownloadFile" nocase
  condition:
    $enc or ($b64 and ($iex or $inv)) or (($dl or $dl2) and ($iex or $inv))
}

rule Office_VBA_AutoExec_Shell
{
  meta:
    description = "오피스 매크로 자동실행 + 셸/다운로드 의심"
    severity = "medium"
  strings:
    $auto1 = "AutoOpen" nocase
    $auto2 = "Document_Open" nocase
    $auto3 = "Workbook_Open" nocase
    $auto4 = "AutoExec" nocase
    $sh1 = "WScript.Shell" nocase
    $sh2 = "powershell" nocase
    $sh3 = "cmd.exe" nocase
    $sh4 = "URLDownloadToFile" nocase
    $sh5 = "CreateObject" nocase
  condition:
    any of ($auto*) and any of ($sh*)
}

rule Script_Dropper
{
  meta:
    description = "스크립트 드로퍼(원격 다운로드 후 저장/실행)"
    severity = "high"
  strings:
    $s1 = "WScript.Shell" nocase
    $s2 = "MSXML2.XMLHTTP" nocase
    $s3 = "ADODB.Stream" nocase
    $s4 = "URLDownloadToFile" nocase
    $s5 = "powershell -" nocase
  condition:
    ($s2 and $s3) or (3 of ($s*))
}
