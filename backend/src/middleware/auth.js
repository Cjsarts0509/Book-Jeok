'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');
const accountLimit = require('../accountLimit');

// 요청에서 JWT 를 추출해 검증하고 req.user 를 채웁니다.
async function authenticate(req, res, next) {
  try {
    let token = req.cookies?.[config.cookieName];
    const header = req.headers.authorization;
    if (!token && header?.startsWith('Bearer ')) {
      token = header.slice(7);
    }
    if (!token) {
      return res.status(401).json({ error: '로그인이 필요합니다.' });
    }

    // 알고리즘 고정(HS256): 향후 키 방식이 바뀌어도 알고리즘 혼동 공격이 성립하지 않게 못박는다.
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    // 토큰 발급 후 계정이 비활성/삭제되었을 수 있으므로 DB 재확인
    const result = await query(
      'SELECT id, username, display_name, role, is_active, totp_enabled, token_version FROM users WHERE id = $1',
      [payload.sub]
    );
    if (result.rowCount === 0 || !result.rows[0].is_active) {
      return res.status(401).json({ error: '유효하지 않은 계정입니다.' });
    }
    // 세션 폐기: 로그아웃·비밀번호 변경·2FA 변경 시 token_version 이 올라가 기존 토큰이 즉시 무효가 된다.
    // (구버전 토큰에는 tv 가 없으므로 0 으로 간주 → 배포 시점의 기존 세션은 그대로 유지)
    if (Number(payload.tv || 0) !== Number(result.rows[0].token_version || 0)) {
      return res.status(401).json({ error: '세션이 만료되었습니다. 다시 로그인해 주세요.' });
    }
    req.user = result.rows[0];
    // 관리자 2FA 강제를 '모든 인증 경로'에서 적용.
    //  기존엔 /api/admin 에만 걸려 있어, 2FA 미설정 관리자가 /api/files?ownerId=* 로
    //  전 계정 파일을 그대로 읽을 수 있었다(프런트 화면 차단은 브라우저를 안 쓰면 무의미).
    //  2FA 설정 자체를 하려면 /api/auth 는 열어둬야 하므로 그 경로만 예외.
    if (req.user.role === 'admin' && !req.user.totp_enabled && !req.baseUrl.startsWith('/api/auth')) {
      return res.status(403).json({ error: '보안을 위해 2단계 인증을 먼저 설정해야 합니다.', code: 'need_2fa' });
    }
    // S16 · 계정 단위 제한. 전역 제한(IP)만으로는 같은 사무실에서 한 사람의 폭주가
    // 옆자리까지 막고, 반대로 한 계정이 여러 기기로 붙으면 IP 제한을 우회한다.
    // 여기서 한 번만 걸면 인증이 필요한 모든 경로가 함께 보호된다.
    if (!accountLimit.check(req, res)) return;
    next();
  } catch (err) {
    return res.status(401).json({ error: '인증에 실패했습니다.' });
  }
}

// 관리자 전용 라우트 보호
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
  }
  next();
}

module.exports = { authenticate, requireAdmin };
