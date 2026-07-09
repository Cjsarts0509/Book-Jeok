/* 북적북적 매뉴얼 콘텐츠 (사용자용 / 관리자용 공용) */
const Manual = (() => {
  // ── 일반 사용자(담당자·일반) 매뉴얼 본문 ──────────────
  const userSections = `
    <section class="manual-sec">
      <h2>1. 시작하기</h2>
      <ul>
        <li><b>로그인</b> — 관리자에게 받은 아이디·비밀번호로 로그인합니다.</li>
        <li><b>비밀번호 변경</b> — 상단 <span class="kbd">🔑 비밀번호</span>. 현재 비밀번호 확인 후 8자 이상으로.</li>
        <li><b>홈으로</b> — 왼쪽 위 <b>북적북적</b> 로고를 누르면 최상위 폴더로 갑니다.</li>
        <li><b>도움말</b> — 상단 <span class="kbd">❓ 도움말</span>에서 이 매뉴얼을 언제든 다시 봅니다.</li>
        <li><b>모바일</b> — 좁은 화면에서는 왼쪽 위 <span class="kbd">☰</span>로 폴더 사이드바를 엽니다.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>2. 폴더 탐색 (윈도우 탐색기처럼)</h2>
      <ul>
        <li><b>이동 버튼</b> — 툴바 왼쪽의 <span class="kbd">◀ 뒤로</span> <span class="kbd">▶ 앞으로</span> <span class="kbd">▲ 상위</span>로 오갑니다. <b>Backspace</b> 키도 "뒤로"로 동작합니다(브라우저가 사이트를 벗어나지 않음).</li>
        <li><b>왼쪽 트리</b> — 폴더를 <b>한 번 클릭</b>하면 그 폴더로 이동하고, 현재 위치에 맞춰 트리가 자동으로 펼쳐집니다. 접기/펼치기는 <span class="kbd">▸</span> 캐럿, 위쪽 <span class="kbd">⊞</span>/<span class="kbd">⊟</span>로 전체 펴기/닫기.</li>
        <li><b>경로(주소)</b> — 오른쪽 위 브레드크럼(홈 / 폴더 / …)의 각 조각을 눌러 이동합니다.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>3. 올리기 · 내려받기 · 미리보기</h2>
      <ul>
        <li><b>업로드</b> — 상단 <span class="kbd">⬆️ 업로드</span> 버튼, 또는 <b>화면 아무 곳에나 파일을 끌어다 놓으면</b> 현재 폴더로 올라갑니다.</li>
        <li><b>허용 형식</b> — 관리자가 지정한 확장자만 가능(업로드 버튼에 마우스를 올리면 목록 표시).</li>
        <li><b>다운로드</b> — 파일의 <span class="kbd">⬇️</span> 버튼. 여러 개는 선택 후 아래 막대의 <b>다운로드(ZIP)</b>.</li>
        <li><b>미리보기</b> — 파일의 <span class="kbd">👁️</span> 버튼으로 <b>이미지·PDF·텍스트</b>를 내려받지 않고 바로 봅니다.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>4. 폴더 다루기</h2>
      <ul>
        <li><b>새 폴더</b> — <span class="kbd">📂 새 폴더</span>. 아이콘·색상 지정 가능(색은 폴더 아이콘에 입혀집니다).</li>
        <li><b>영업점 폴더</b> — 새 폴더 창의 <b>영업점 폴더</b> 탭에서 등록된 영업점을 골라 한 번에 생성.</li>
        <li><b>폴더 설정</b> — 폴더의 <span class="kbd">⚙️</span>에서 이름·아이콘·색상 변경.</li>
        <li><b>비고(메모)</b> — 폴더·파일의 <b>비고</b> 칸을 눌러 바로 편집.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>5. 찾기 · 정렬 · 필터</h2>
      <ul>
        <li><b>이름 검색</b> — 툴바의 검색창에 입력하고 <b>엔터</b> 또는 <span class="kbd">🔎 조회</span>. 내 계정의 폴더·파일 이름을 찾습니다. <b>✕ 검색 나가기</b>로 복귀.</li>
        <li><b>확장자 필터</b> — <span class="kbd">🧩 확장자</span>에서 보고 싶은 확장자만 켜면 해당 파일만 표시됩니다.</li>
        <li><b>정렬</b> — 리스트 뷰의 <b>이름·크기·등록일·수정일·비고</b> 머리글 클릭(다시 누르면 오름/내림).</li>
        <li><b>업데이트 태그</b> — 최근 7일 내 추가는 <span class="tagx new">NEW</span>, 수정은 <span class="tagx upd">수정</span>.</li>
        <li><b>보기 전환</b> — 오른쪽 위 <span class="kbd">▦</span>(미리보기) / <span class="kbd">☰</span>(리스트).</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>6. 선택 · 이동 · 삭제</h2>
      <ul>
        <li><b>선택</b> — 항목을 <b>클릭</b>하면 단일 선택, <b>Ctrl(⌘)+클릭</b> 토글, <b>Shift+클릭</b> 범위 선택. 왼쪽 체크박스도 사용할 수 있습니다.</li>
        <li><b>선택 메뉴</b> — 목록 위 막대는 항상 있고, 선택하면 <b>이름변경·다운로드(ZIP)·폴더이동·삭제·선택해제</b>가 켜집니다.</li>
        <li><b>드래그 이동</b> — 항목을 잡아 <b>다른 폴더(행·카드) 또는 왼쪽 트리 폴더</b>에 놓으면 이동합니다.</li>
        <li><b>폴더 이동 선택기</b> — 선택 막대의 <b>📂 폴더이동</b>은 탐색기형 트리에서 목적지를 골라 옮깁니다.</li>
        <li><b>삭제/복원</b> — 삭제한 항목은 휴지통으로 갑니다. 상단 <span class="kbd">🗑️ 휴지통</span>에서 <b>최근 30일</b> 내 직접 복원.</li>
      </ul>
      <table class="manual-table">
        <thead><tr><th>단축키</th><th>동작</th></tr></thead>
        <tbody>
          <tr><td><span class="kbd">Ctrl/⌘ + A</span></td><td>전체 선택</td></tr>
          <tr><td><span class="kbd">Esc</span></td><td>선택 해제</td></tr>
          <tr><td><span class="kbd">Delete</span></td><td>선택 항목 삭제</td></tr>
          <tr><td><span class="kbd">F2</span></td><td>이름 변경(1개 선택 시)</td></tr>
          <tr><td><span class="kbd">Enter</span></td><td>열기(폴더)/다운로드(파일)</td></tr>
          <tr><td><span class="kbd">Backspace</span></td><td>폴더 뒤로가기</td></tr>
        </tbody>
      </table>
    </section>

    <section class="manual-sec">
      <h2>7. 공유 · 압축 · 업로드 요청</h2>
      <ul>
        <li><b>공유 링크</b> — 파일의 <span class="kbd">🔗</span>로 <b>로그인 없이 받을 수 있는</b> 링크 생성. <b>만료 기간·비밀번호·다운로드 횟수 제한</b>을 걸 수 있습니다.</li>
        <li><b>폴더 공유(읽기 전용)</b> — 폴더의 <span class="kbd">🔗</span>로 외부인이 그 폴더만 열람·<b>다운로드만</b> 할 수 있는 링크(업로드·이동 불가, 다른 폴더 접근 불가).</li>
        <li><b>공유 관리</b> — 상단 <span class="kbd">🔗 공유</span>에서 내가 만든 파일·압축·폴더 공유를 한눈에 보고 <b>폐기</b>할 수 있습니다.</li>
        <li><b>압축(ZIP)</b> — 여러 개(또는 폴더) 선택 → <b>다운로드(ZIP)</b> → <b>내 기기 저장</b> 또는 <b>공유 링크</b> 선택. 폴더 하나만 고르면 파일명이 그 폴더명이 됩니다.</li>
        <li><b>업로드 요청 링크</b> — 폴더의 <span class="kbd">📥</span> 버튼으로 <b>외부인이 로그인 없이 그 폴더로 올리는</b> 링크를 만듭니다. 라벨·만료·<b>비밀번호</b>·최대 개수/용량을 지정하고, 만든 링크는 목록에서 받은 수량 확인·취소가 됩니다.</li>
        <li><b>용량 리포트</b> — 용량 막대 옆 <span class="kbd">📊</span>로 폴더별 사용량을 봅니다.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>8. 권한 안내</h2>
      <table class="manual-table">
        <thead><tr><th>권한</th><th>볼 수 있는 파일</th><th>디스크</th></tr></thead>
        <tbody>
          <tr><td><b>담당자</b></td><td>본인 + 일반 사용자</td><td>할당량</td></tr>
          <tr><td><b>일반</b></td><td>본인만</td><td>할당량</td></tr>
        </tbody>
      </table>
      <p class="manual-note">담당자는 상단 <b>계정 전환</b>으로 일반 사용자의 파일을 열람·업로드할 수 있습니다(관리 기능은 없음).</p>
    </section>

    <section class="manual-sec manual-tips">
      <h3>💡 팁 &amp; 주의</h3>
      <ul>
        <li>공유·업로드 요청 링크는 <b>링크를 아는 누구나</b> 접근합니다. 민감하면 <b>비밀번호</b>·<b>짧은 만료</b>·<b>횟수 제한</b>을 거세요.</li>
        <li>삭제해도 30일간 휴지통에서 되돌릴 수 있습니다.</li>
        <li>화면이 최신이 아니면 <b>강력 새로고침</b>(Windows <span class="kbd">Ctrl+Shift+R</span> / Mac <span class="kbd">⌘+Shift+R</span>).</li>
      </ul>
    </section>`;

  // ── 관리자 전용 매뉴얼 본문 ──────────────
  const adminSections = `
    <section class="manual-sec">
      <h2>1. 계정 관리</h2>
      <ul>
        <li><b>계정 발급</b> — 아이디·표시이름·권한·<b>디스크 할당(GB)</b> 지정. 비밀번호는 비우면 자동 생성(1회 표시). 할당 총합은 디스크 전체를 넘을 수 없습니다.</li>
        <li><b>비밀번호</b> — 계정별 <span class="kbd">🔑 암호</span>로 현재 비밀번호 열람/재설정(열람은 감사 로그에 기록).</li>
        <li><b>수정</b> — 권한·할당량·활성/정지·표시이름 변경. 현재 사용량보다 작게 할당량을 줄일 수 없습니다.</li>
        <li><b>파일 열람</b> — 계정의 <b>📁 열람</b>으로 그 계정 파일을 대신 관리(상단 계정 전환).</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>2. 권한 체계</h2>
      <table class="manual-table">
        <thead><tr><th>권한</th><th>볼 수 있는 파일</th><th>관리 기능</th><th>디스크</th></tr></thead>
        <tbody>
          <tr><td><b>관리자</b></td><td>모든 계정</td><td>전체</td><td>무제한</td></tr>
          <tr><td><b>담당자</b></td><td>본인 + 일반 사용자</td><td>없음(열람·업로드만)</td><td>할당량</td></tr>
          <tr><td><b>일반</b></td><td>본인만</td><td>없음</td><td>할당량</td></tr>
        </tbody>
      </table>
    </section>

    <section class="manual-sec">
      <h2>3. 영업점 · 공지 · 확장자</h2>
      <ul>
        <li><b>영업점</b> — 사용자가 '영업점 폴더'에서 고르는 목록을 추가·수정·삭제.</li>
        <li><b>공지사항</b> — 리치텍스트(굵게·색상·이미지·링크)로 작성. <b>노출 기간</b>과 <b>노출 대상 권한</b>(관리자/담당자/일반)을 지정. 사용자는 자기 권한이 대상인 공지만 팝업으로 봅니다. (본문은 보안상 자동 정화되어 표시됩니다.)</li>
        <li><b>허용 확장자</b> — <b>카탈로그에서 아이콘과 함께 선택</b>(약 110종). 현재 허용 확장자는 미리 체크되어 있고, 그룹 전체 토글·직접 추가도 됩니다. 여기서 켠 확장자가 사용자 화면의 확장자 필터로도 매핑됩니다.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>4. 휴지통 · 용량 · DB · 로그</h2>
      <ul>
        <li><b>휴지통</b> — 전 계정의 삭제 항목을 <b>복원/영구삭제</b>. 1년 지난 항목은 자동 영구삭제(사용자는 본인 것 30일 셀프복원).</li>
        <li><b>용량</b> — <span class="kbd">📊 용량</span> 탭에서 디스크 전체/사용/할당/남음과 <b>계정별 사용량</b>(많은 순)을 봅니다.</li>
        <li><b>DB 상태</b> — 데이터베이스 용량·연결·테이블 현황.</li>
        <li><b>감사 로그</b> — 로그인·업로드·비밀번호 열람·삭제·공유/업로드요청 생성 등 주요 동작의 시각·사용자·IP.</li>
      </ul>
    </section>

    <section class="manual-sec manual-tips">
      <h3>💡 운영 팁 &amp; 주의</h3>
      <ul>
        <li>업로드 요청·공유 링크는 링크를 아는 누구나 접근하니, 민감 폴더는 <b>비밀번호·만료·한도</b> 사용을 안내하세요.</li>
        <li>압축 공유본은 공유 만료까지 유지, 미공유 임시 압축본은 하루 뒤 자동 정리됩니다.</li>
        <li>비밀번호 열람은 감사 로그에 남으니 꼭 필요할 때만 사용하세요.</li>
        <li>할당 총합이 디스크를 넘지 않도록 발급 화면의 남은 용량을 확인하세요.</li>
      </ul>
    </section>`;

  function userHTML() {
    return `<div class="manual">
      <p class="manual-intro">북적북적(Book-Jeok)은 우리끼리 파일을 나누는 웹 파일 창고입니다. 아래로 기본 사용법을 익힐 수 있어요. 인쇄가 필요하면 <b>Ctrl/⌘ + P</b>.</p>
      ${userSections}
    </div>`;
  }
  function adminHTML() {
    return `<div class="manual">
      <p class="manual-intro">관리자 전용 기능 안내입니다. 일반 사용법(업로드·폴더·검색·공유·미리보기 등)은 메인 화면의 <b>❓ 도움말</b>을 참고하세요. 인쇄는 <b>Ctrl/⌘ + P</b>.</p>
      ${adminSections}
    </div>`;
  }
  return { userHTML, adminHTML };
})();
