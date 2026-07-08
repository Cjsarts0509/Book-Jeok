#!/usr/bin/env python3
"""
이미 업로드된 계정의 폴더명 날짜 → 비고 정리 (사후 보정용)

이관(import-files.py)이 끝난 뒤, 폴더 이름에 (YYYYMMDD) 형식이 남아 있는 경우
이 스크립트로 한 번에 정리합니다.

  - 폴더 이름 마지막 조각에 (날짜)가 있으면:
      · 그 날짜를 해당 폴더의 '비고'에 넣고
      · 폴더 이름에서 괄호+날짜를 제거합니다.
    예) 강남점(20260115) → 폴더 '강남점', 비고 '20260115'
  - ⚠️ 폴더만 처리합니다. 파일 이름은 건드리지 않습니다.

환경변수:
  API        기본 http://localhost:4000
  LOGIN_USER 로그인 계정 (기본 admin)
  LOGIN_PASS 로그인 비밀번호 (없으면 물어봄)
  OWNER_ID   대상 계정 id (관리자만 타 계정 지정 가능. 없으면 본인)
  DRY_RUN    1 이면 실제 변경 없이 미리보기만

사용 예:
  # ajis 본인 계정 미리보기
  LOGIN_USER=ajis LOGIN_PASS='12345678' DRY_RUN=1 python3 scripts/fix-folder-dates.py
  # 실제 적용
  LOGIN_USER=ajis LOGIN_PASS='12345678' python3 scripts/fix-folder-dates.py
"""
import os, sys, re, json, getpass, urllib.request, urllib.error

API = os.environ.get('API', 'http://localhost:4000').rstrip('/')
LOGIN_USER = os.environ.get('LOGIN_USER', 'admin')
LOGIN_PASS = os.environ.get('LOGIN_PASS') or getpass.getpass(f'{LOGIN_USER} 비밀번호: ')
OWNER_ID = os.environ.get('OWNER_ID')
DRY_RUN = os.environ.get('DRY_RUN') in ('1', 'true', 'yes')

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


def main():
    token = api('POST', '/api/auth/login', data={'username': LOGIN_USER, 'password': LOGIN_PASS})['token']
    me = api('GET', '/api/auth/me', token=token)['user']
    owner = int(OWNER_ID) if OWNER_ID else me['id']

    tree = api('GET', f'/api/files/tree?ownerId={owner}', token=token)
    folders = [p for p in tree.get('folders', []) if p and p != '/']

    # 마지막 조각에 날짜가 있는 폴더만 대상. 깊은 폴더부터 처리해야
    # 상위 폴더 이름변경(접두사 치환)에도 하위 경로가 어긋나지 않는다.
    targets = []
    for path in folders:
        seg = path.rsplit('/', 1)[-1]
        cleaned, date = clean_segment(seg)
        if date and cleaned != seg:
            parent = path[:path.rfind('/')] or ''
            new_path = (parent + '/' + cleaned) if parent else ('/' + cleaned)
            targets.append((path.count('/'), path, new_path, date))
    targets.sort(key=lambda t: t[0], reverse=True)  # 깊은 것 먼저

    if not targets:
        print('정리할 폴더가 없습니다. (폴더 이름에 (날짜) 형식이 없음)')
        return

    print(f'대상 폴더 {len(targets)}개 {"(미리보기)" if DRY_RUN else ""}')
    done = fail = 0
    for _depth, old_path, new_path, date in targets:
        print(f'  {old_path}  →  {new_path}   [비고: {date}]')
        if DRY_RUN:
            continue
        try:
            # 비고 먼저 (현재 경로 기준). 이후 이름변경 시 같은 행의 path만 바뀌고 비고는 유지됨.
            api('PATCH', '/api/files/folders/note', token=token,
                data={'path': old_path, 'note': date, 'ownerId': owner})
            api('PATCH', '/api/files/folders', token=token,
                data={'oldPath': old_path, 'newPath': new_path, 'ownerId': owner})
            done += 1
        except Exception as e:
            fail += 1
            print(f'    ❌ 실패: {e}')

    if DRY_RUN:
        print('── 미리보기 완료 (DRY_RUN). 실제 적용하려면 DRY_RUN 없이 다시 실행하세요. ──')
    else:
        print(f'── 완료: 정리 {done}개, 실패 {fail}개 ──')


if __name__ == '__main__':
    main()
