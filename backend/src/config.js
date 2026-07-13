'use strict';

require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`환경변수 ${name} 가 설정되지 않았습니다. .env 파일을 확인하세요.`);
  }
  return value;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),

  // PostgreSQL (오라클 클라우드 독립 디스크에 데이터 저장)
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'bookjeok',
    password: required('DB_PASSWORD', 'bookjeok_dev'),
    database: process.env.DB_NAME || 'bookjeok',
    max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  },

  // 파일이 저장되는 루트 경로 (오라클 독립 블록 볼륨 마운트 지점)
  storageRoot: process.env.STORAGE_ROOT || require('path').join(__dirname, '..', '..', 'storage'),

  // 공유 링크 생성 시 사용할 공개 API 주소 (미지정 시 요청 헤더에서 유추)
  publicApiUrl: (process.env.PUBLIC_API_URL || '').replace(/\/$/, ''),

  // 계정별 기본 할당량 (bytes). 0 = 무제한
  defaultQuota: parseInt(process.env.DEFAULT_QUOTA || '0', 10),

  // 인증
  jwtSecret: required('JWT_SECRET', 'change-me-in-production-please-32chars'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  cookieName: 'bookjeok_token',

  // 암호 열람용 AES-256-GCM 마스터 키 (64 hex 문자 = 32 bytes)
  // 관리자 암호 열람 기능을 위해 사용. 절대 DB와 같은 곳에 두지 말 것.
  masterKey: required('MASTER_KEY', '0'.repeat(64)),

  // CORS 허용 오리진 (콤마 구분)
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // 관리자 권한을 항상 가지는 아이디 목록 (콤마 구분). 초기 부트스트랩용.
  superAdmins: (process.env.SUPER_ADMINS || 'admin')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

module.exports = config;
