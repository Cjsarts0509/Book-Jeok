/* 북적북적 매뉴얼 콘텐츠 (사용자용 / 관리자용 공용) */
const Manual = (() => {
  // ── 일반 사용자(담당자·일반) 매뉴얼 본문 ──────────────
  const userSections = `
    <section class="manual-sec">
      <h2>1. 시작하기</h2>
      <ul>
        <li><b>로그인</b> — 관리자에게 받은 아이디·비밀번호로 로그인합니다.</li>
        <li><b>비밀번호 변경</b> — 상단 <span class="kbd">🔑 비밀번호</span> 에서 언제든 바꿀 수 있습니다(현재 비밀번호 확인 필요, 8자 이상).</li>
        <li><b>로고 클릭</b> — 화면 어디서든 왼쪽 위 <b>북적북적</b> 로고를 누르면 홈(최상위 폴더)으로 갑니다.</li>
        <li><b>모바일</b> — 좁은 화면에서는 왼쪽 위 <span class="kbd">☰</span> 로 폴더 사이드바를 엽니다.</li>
        <li><b>도움말</b> — 상단 <span class="kbd">❓ 도움말</span> 에서 이 매뉴얼을 언제든 다시 볼 수 있습니다.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>2. 파일 올리기 / 내려받기</h2>
      <ul>
        <li><b>업로드</b> — 파일 영역의 점선 상자에 파일을 <b>끌어다 놓거나</b>, 상자를 클릭해 선택합니다. 상단 <span class="kbd">⬆️ 업로드</span> 버튼도 동일합니다. 여러 개 동시 업로드 가능.</li>
        <li><b>허용 형식</b> — 관리자가 지정한 확장자만 올라갑니다. 점선 상자 아래 <b>허용: …</b> 목록을 확인하세요.</li>
        <li><b>다운로드</b> — 목록에서 파일의 <span class="kbd">⬇️</span> 버튼(또는 그리드에서 파일 카드의 메뉴)을 누릅니다.</li>
        <li><b>용량</b> — 상단 사용량 막대에서 내 사용량/할당량을 볼 수 있습니다. 할당량이 0이면 업로드가 제한됩니다(관리자 문의).</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>3. 폴더 다루기</h2>
      <ul>
        <li><b>새 폴더</b> — <span class="kbd">📂 새 폴더</span> → 이름 입력. 아이콘/색상도 지정할 수 있습니다.</li>
        <li><b>영업점 폴더</b> — 새 폴더 창의 <b>영업점 폴더</b> 탭에서 등록된 영업점을 골라 한 번에 만들 수 있습니다(전체 선택 지원).</li>
        <li><b>왼쪽 폴더 트리</b> — <b>한 번 클릭</b>: 그 폴더 열람(내용 보기). <b>더블 클릭</b> 또는 <span class="kbd">▸</span> 캐럿: 하위 폴더 펼치기/접기. 위쪽 <span class="kbd">⊞</span>/<span class="kbd">⊟</span> 로 전체 펴기/닫기.</li>
        <li><b>폴더 설정</b> — 폴더의 <span class="kbd">⚙️</span> 에서 이름 변경, 아이콘·색상 지정. 지정한 색은 폴더 아이콘에 입혀집니다.</li>
        <li><b>비고(메모)</b> — 폴더·파일마다 비고를 달 수 있습니다. 리스트의 <b>비고</b> 칸을 클릭해 바로 편집.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>4. 목록 보기 · 정렬 · 태그</h2>
      <ul>
        <li><b>보기 전환</b> — 오른쪽 위 <span class="kbd">▦</span>(미리보기) / <span class="kbd">☰</span>(리스트)로 전환.</li>
        <li><b>정렬</b> — 리스트 뷰에서 <b>이름·크기·등록일·수정일·비고</b> 머리글을 클릭하면 그 값 기준으로 정렬됩니다. 다시 누르면 오름/내림 전환(▲▼ 표시).</li>
        <li><b>업데이트 태그</b> — 최근 7일 내 추가된 항목엔 <span class="tagx new">NEW</span>, 수정된 항목엔 <span class="tagx upd">수정</span> 태그가 붙습니다.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>5. 여러 개 선택 · 공유 · 압축</h2>
      <ul>
        <li><b>선택</b> — 리스트 왼쪽 체크박스로 여러 항목 선택. 머리글 체크박스는 <b>전체 선택/해제 토글</b>입니다.</li>
        <li><b>일괄 작업</b> — 선택하면 아래 막대에 <b>이름변경 · 다운로드(ZIP) · 폴더이동 · 삭제 · 선택해제</b>가 나타납니다.</li>
        <li><b>압축 다운로드</b> — <span class="kbd">⬇️ 다운로드(ZIP)</span> 를 누르면 압축본이 만들어지고, <b>내 기기로 다운로드</b> 또는 <b>공유링크 만들기</b>를 선택할 수 있습니다. 폴더 하나만 골랐다면 파일명은 그 폴더 이름이 됩니다.</li>
        <li><b>공유 링크</b> — 파일의 <span class="kbd">🔗</span>(또는 압축 공유)로 <b>로그인 없이 접근 가능한</b> 다운로드 링크를 만듭니다. 만료 기간(무기한/1·7·30일)을 정할 수 있습니다. 링크를 아는 사람은 누구나 받을 수 있으니 주의하세요.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>6. 권한 안내</h2>
      <table class="manual-table">
        <thead><tr><th>권한</th><th>볼 수 있는 파일</th><th>디스크</th></tr></thead>
        <tbody>
          <tr><td><b>담당자</b></td><td>본인 + 일반 사용자</td><td>할당량</td></tr>
          <tr><td><b>일반</b></td><td>본인만</td><td>할당량</td></tr>
        </tbody>
      </table>
      <p class="manual-note">담당자는 상단 <b>계정 전환</b> 선택으로 일반 사용자의 파일을 열람·업로드할 수 있습니다(관리 기능은 없음).</p>
    </section>

    <section class="manual-sec manual-tips">
      <h3>💡 팁 &amp; 주의</h3>
      <ul>
        <li>공유 링크는 <b>링크를 아는 누구나</b> 접근합니다. 민감한 파일은 <b>만료 기간</b>을 짧게 설정하세요.</li>
        <li>삭제는 곧바로 사라지지 않고 휴지통으로 가니, 실수로 지워도 관리자에게 복원을 요청할 수 있습니다.</li>
        <li>화면이 최신으로 안 보이면 <b>강력 새로고침</b>(Windows <span class="kbd">Ctrl+Shift+R</span> / Mac <span class="kbd">⌘+Shift+R</span>).</li>
      </ul>
    </section>`;

  // ── 관리자 전용 매뉴얼 본문 ──────────────
  const adminSections = `
    <section class="manual-sec">
      <h2>1. 계정 관리</h2>
      <ul>
        <li><b>계정 발급</b> — 아이디·표시이름·권한·<b>디스크 할당(GB)</b> 지정. 비밀번호는 비우면 자동 생성됩니다(발급 시 1회 표시). 할당은 남은 디스크 총량을 넘을 수 없습니다.</li>
        <li><b>비밀번호</b> — 계정별 <span class="kbd">🔑 암호</span>로 현재 비밀번호를 열람하거나 재설정할 수 있습니다(열람은 감사 로그에 기록됨).</li>
        <li><b>수정</b> — 권한·할당량·활성/정지·표시이름 변경. 현재 사용량보다 작게 할당량을 줄일 수는 없습니다.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>2. 권한 체계</h2>
      <table class="manual-table">
        <thead><tr><th>권한</th><th>볼 수 있는 파일</th><th>관리 기능</th><th>디스크</th></tr></thead>
        <tbody>
          <tr><td><b>관리자</b></td><td>모든 계정</td><td>전체(계정·공지·휴지통 등)</td><td>무제한</td></tr>
          <tr><td><b>담당자</b></td><td>본인 + 일반 사용자</td><td>없음(열람·업로드만)</td><td>할당량</td></tr>
          <tr><td><b>일반</b></td><td>본인만</td><td>없음</td><td>할당량</td></tr>
        </tbody>
      </table>
    </section>

    <section class="manual-sec">
      <h2>3. 영업점 · 공지 · 확장자</h2>
      <ul>
        <li><b>영업점</b> — 사용자가 '영업점 폴더'에서 고르는 목록을 추가·수정·삭제합니다.</li>
        <li><b>공지사항</b> — 리치텍스트(굵게·색상·이미지·링크)로 작성. <b>노출 기간</b>과 <b>노출 대상 권한</b>(관리자/담당자/일반)을 정할 수 있습니다. 사용자는 자기 권한이 대상인 공지만 로그인 시 팝업으로 봅니다.</li>
        <li><b>허용 확장자</b> — 업로드 가능한 파일 형식을 관리합니다.</li>
      </ul>
    </section>

    <section class="manual-sec">
      <h2>4. 휴지통 · DB · 로그</h2>
      <ul>
        <li><b>휴지통</b> — 삭제된 파일·폴더는 휴지통으로 이동하며 여기서 <b>복원</b>하거나 <b>영구 삭제</b>할 수 있습니다. 1년이 지난 항목은 자동으로 영구 삭제됩니다.</li>
        <li><b>DB 상태</b> — 데이터베이스 용량·연결·테이블 현황을 확인합니다.</li>
        <li><b>감사 로그</b> — 로그인, 업로드, 비밀번호 열람, 삭제 등 주요 동작의 시각·사용자·IP 기록을 봅니다.</li>
      </ul>
    </section>

    <section class="manual-sec manual-tips">
      <h3>💡 운영 팁 &amp; 주의</h3>
      <ul>
        <li>공유 링크는 <b>링크를 아는 누구나</b> 접근합니다. 사용자에게 민감 파일은 만료 기간을 짧게 쓰도록 안내하세요.</li>
        <li>압축 공유본은 공유 링크의 만료 기간까지 유지되고, 공유하지 않은 임시 압축본은 하루 뒤 자동 정리됩니다.</li>
        <li>할당량 총합은 디스크 전체 용량을 넘을 수 없습니다. 발급 화면에서 남은 용량을 확인하세요.</li>
        <li>비밀번호 열람 기능은 감사 로그에 기록되니, 꼭 필요한 경우에만 사용하세요.</li>
      </ul>
    </section>`;

  function userHTML() {
    return `<div class="manual">
      <p class="manual-intro">북적북적(Book-Jeok)은 우리끼리 파일을 나누는 웹 파일 창고입니다. 아래 안내로 기본 사용법을 익힐 수 있어요. 인쇄가 필요하면 <b>Ctrl/⌘ + P</b> 를 누르세요.</p>
      ${userSections}
    </div>`;
  }

  function adminHTML() {
    return `<div class="manual">
      <p class="manual-intro">관리자 전용 기능 안내입니다. 일반 사용법(업로드·폴더·공유 등)은 메인 화면의 <b>❓ 도움말</b> 또는 사용자 매뉴얼을 참고하세요. 인쇄는 <b>Ctrl/⌘ + P</b>.</p>
      ${adminSections}
    </div>`;
  }

  return { userHTML, adminHTML };
})();
