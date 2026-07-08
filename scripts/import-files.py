#!/usr/bin/env python3
"""
북적북적 대량 파일 이관 스크립트 (폴더명 날짜 → 비고 처리 포함)

- 로컬 디렉터리의 모든 파일을 북적북적 계정으로 업로드 (폴더 구조 유지)
- 폴더명에 (YYYYMMDD) 형식이 있으면: 괄호+날짜를 폴더명에서 제거하고,
  그 날짜를 해당 폴더의 '비고'에 넣습니다. 예) 강남점(20260115) → 폴더 '강남점', 비고 '20260115'
- 파일 이름 충돌 시 서버가 자동으로 번호를 붙입니다.

환경변수:
  API        기본 http://localhost:4000  (같은 서버면 그대로)
  LOGIN_USER 로그인 계정 (기본 admin)
  LOGIN_PASS 로그인 비밀번호 (없으면 물어봄)
  OWNER_ID   업로드 대상 계정 id (기본: 로그인한 본인). 관리자만 타 계정 지정 가능.
  SRC        원본 폴더 (예: /mnt/bookjeok-data/_import)

사용 예:
  # 계정 목록 확인
  LOGIN_USER=admin LOGIN_PASS='관리자비번' python3 scripts/import-files.py --list
  # ajis(본인)로 로그인해 본인 창고에 업로드
  LOGIN_USER=ajis LOGIN_PASS='12345678' SRC=/mnt/bookjeok-data/_import python3 scripts/import-files.py
  # 관리자로 로그인해 ajis(id=3) 창고에 업로드
  LOGIN_USER=admin LOGIN_PASS='관리자비번' OWNER_ID=3 SRC=/mnt/bookjeok-data/_import python3 scripts/import-files.py
"""
import os, sys, re, json, getpass, subprocess, urllib.request, urllib.error

API = os.environ.get('API', 'http://localhost:4000').rstrip('/')
LOGIN_USER = os.environ.get('LOGIN_USER', 'admin')
LOGIN_PASS = os.environ.get('LOGIN_PASS') or getpass.getpass(f'{LOGIN_USER} 비밀번호: ')
OWNER_ID = os.environ.get('OWNER_ID')
SRC = os.environ.get('SRC')

# (20260115) / ( 2026-01-15 ) 등 괄호 안 날짜
DATE_RE = re.compile(r'\s*\(\s*(\d{4}[-.]?\d{2}[-.]?\d{2})\s*\)')


def api(method, path, token=None, data=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(API + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{e.code} {e.read().decode(errors="replace")[:200]}')


def clean_segment(seg):
    m = DATE_RE.search(seg)
    date = m.group(1) if m else None
    cleaned = DATE_RE.sub('', seg).strip()
    if not cleaned:
        cleaned = date or seg  # 날짜만 있는 폴더명이면 날짜를 이름으로
    return cleaned, date


folder_notes = {}  # 정리된 폴더 경로 -> {날짜들}


def clean_path(rel_dir):
    parts = [p for p in rel_dir.split(os.sep) if p and p != '.']
    acc, out = '', []
    for p in parts:
        c, date = clean_segment(p)
        acc = acc + '/' + c
        out.append(c)
        if date:
            folder_notes.setdefault(acc, set()).add(date)
    return '/' + '/'.join(out) if out else '/'


def main():
    token = api('POST', '/api/auth/login', data={'username': LOGIN_USER, 'password': LOGIN_PASS})['token']
    me = api('GET', '/api/auth/me', token=token)['user']

    if '--list' in sys.argv:
        for u in api('GET', '/api/admin/users', token=token)['users']:
            print(u['id'], u['username'], u['role'])
        return

    owner = OWNER_ID or str(me['id'])
    if not SRC or not os.path.isdir(SRC):
        print(f'❌ SRC 폴더를 확인하세요: {SRC}')
        sys.exit(1)

    print(f'▶ 업로드 시작: {SRC} → 계정 #{owner} ({API})')
    ok = fail = 0
    fails = []
    for root, _dirs, files in os.walk(SRC):
        for name in files:
            full = os.path.join(root, name)
            rel_dir = os.path.relpath(root, SRC)
            folder = clean_path(rel_dir) if rel_dir not in ('.', '') else '/'
            p = subprocess.run(
                ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}',
                 '-X', 'POST', f'{API}/api/files/upload?ownerId={owner}',
                 '-H', f'Authorization: Bearer {token}',
                 '-F', f'folder={folder}', '-F', f'file=@{full}'],
                capture_output=True, text=True)
            if p.stdout.strip() == '201':
                ok += 1
                print(f'\r  올림 {ok}개 · 실패 {fail}개   ', end='', flush=True)
            else:
                fail += 1
                fails.append((p.stdout.strip(), os.path.relpath(full, SRC)))
    print()

    # 폴더 비고(날짜) 설정
    noted = 0
    for path, dates in folder_notes.items():
        note = ', '.join(sorted(dates))
        try:
            api('PATCH', '/api/files/folders/note', token=token,
                data={'path': path, 'note': note, 'ownerId': int(owner)})
            noted += 1
        except Exception as e:
            print(f'  비고 실패 {path}: {e}')

    print(f'── 완료: 성공 {ok}개, 실패 {fail}개, 폴더비고 {noted}개 ──')
    if fails:
        print('실패 목록 (415=확장자 불허, 413=용량초과):')
        for code, rel in fails[:80]:
            print(f'  [{code}] {rel}')


if __name__ == '__main__':
    main()
