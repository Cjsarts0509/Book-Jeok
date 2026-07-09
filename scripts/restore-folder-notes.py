#!/usr/bin/env python3
"""
원본 스테이징 폴더명 → 업로드된 계정 폴더 비고 복구

이관 당시 폴더명에서 (YYYYMMDD)는 정상적으로 떼어냈지만 '비고'에는
날짜가 들어가지 못한 경우, 원본 폴더명(날짜 포함)에서 매핑을 다시 뽑아
이미 업로드된(이름이 정리된) 폴더의 비고에 날짜를 채워 넣습니다.

  - 원본(SRC)의 폴더 구조를 걸으며 각 폴더의 (날짜)를 추출
  - import-files.py 와 동일한 정리 규칙으로 '정리된 경로'를 계산
  - 그 경로 폴더의 비고에 날짜를 설정
  - ⚠️ 폴더만 처리합니다. 파일은 건드리지 않습니다.

환경변수:
  API        기본 http://localhost:4000
  LOGIN_USER 로그인 계정 (기본 admin)
  LOGIN_PASS 로그인 비밀번호 (없으면 물어봄)
  OWNER_ID   대상 계정 id (관리자만 타 계정 지정. 없으면 본인)
  SRC        원본 폴더 (기본 /mnt/bookjeok-data/_import)
  DRY_RUN    1 이면 미리보기만

사용 예:
  LOGIN_USER=ajis LOGIN_PASS='12345678' DRY_RUN=1 python3 scripts/restore-folder-notes.py
  LOGIN_USER=ajis LOGIN_PASS='12345678' python3 scripts/restore-folder-notes.py
"""
import os, sys, re, json, getpass, urllib.request, urllib.error

API = os.environ.get('API', 'http://localhost:4000').rstrip('/')
LOGIN_USER = os.environ.get('LOGIN_USER', 'admin')
LOGIN_PASS = os.environ.get('LOGIN_PASS') or getpass.getpass(f'{LOGIN_USER} 비밀번호: ')
OWNER_ID = os.environ.get('OWNER_ID')
SRC = os.environ.get('SRC', '/mnt/bookjeok-data/_import')
DRY_RUN = os.environ.get('DRY_RUN') in ('1', 'true', 'yes')

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
        cleaned = date or seg
    return cleaned, date


def build_notes(src):
    """원본을 걸으며 정리된 경로 -> {날짜들} 매핑을 만든다 (폴더만)."""
    notes = {}
    for root, dirs, _files in os.walk(src):
        rel = os.path.relpath(root, src)
        if rel in ('.', ''):
            continue
        parts = [p for p in rel.split(os.sep) if p and p != '.']
        acc = ''
        for p in parts:
            c, date = clean_segment(p)
            acc = acc + '/' + c
            if date:
                notes.setdefault(acc, set()).add(date)
    return notes


def main():
    if not os.path.isdir(SRC):
        print(f'❌ 원본 폴더가 없습니다: {SRC}')
        print('   원본이 이미 지워졌다면 이 방법으로는 복구할 수 없습니다. 알려주세요.')
        sys.exit(1)

    notes = build_notes(SRC)
    if not notes:
        print(f'원본({SRC})에서 (날짜) 형식 폴더를 찾지 못했습니다.')
        return

    token = api('POST', '/api/auth/login', data={'username': LOGIN_USER, 'password': LOGIN_PASS})['token']
    me = api('GET', '/api/auth/me', token=token)['user']
    owner = int(OWNER_ID) if OWNER_ID else me['id']

    # 대상 계정에 실제 존재하는 폴더만 대상으로
    tree = api('GET', f'/api/files/tree?ownerId={owner}', token=token)
    existing = set(tree.get('folders', []))

    items = sorted(notes.items())
    print(f'복구 대상 폴더 {len(items)}개 {"(미리보기)" if DRY_RUN else ""}')
    done = fail = miss = 0
    for path, dates in items:
        note = ', '.join(sorted(dates))
        present = path in existing
        mark = '' if present else '  ⚠️(계정에 폴더 없음 — 건너뜀)'
        print(f'  {path}   [비고: {note}]{mark}')
        if not present:
            miss += 1
            continue
        if DRY_RUN:
            continue
        try:
            api('PATCH', '/api/files/folders/note', token=token,
                data={'path': path, 'note': note, 'ownerId': owner})
            done += 1
        except Exception as e:
            fail += 1
            print(f'    ❌ 실패: {e}')

    if DRY_RUN:
        print(f'── 미리보기 완료. 적용 대상 {len(items) - miss}개, 계정에 없는 폴더 {miss}개. '
              'DRY_RUN 없이 다시 실행하면 적용됩니다. ──')
    else:
        print(f'── 완료: 비고 설정 {done}개, 실패 {fail}개, 계정에 없는 폴더 {miss}개 ──')


if __name__ == '__main__':
    main()
