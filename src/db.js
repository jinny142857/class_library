// 데이터베이스(SQLite, Node 내장 node:sqlite) 스키마와 공통 헬퍼.
import { DatabaseSync } from 'node:sqlite';
import { BUILTIN_HOLIDAYS } from './holidays.js';
import { nowISO } from './clock.js';

export const DEFAULT_SETTINGS = {
  loan_days: 3,              // 기본 대출 기간(수업일)
  extend_days: 2,            // 연장 기간(수업일)
  max_loans: 1,              // 1인당 최대 대출 권수
  max_extensions: 1,         // 대출 1건당 연장 가능 횟수
  max_reservations: 1,       // 학생별 최대 활성 예약 수
  priority_days: 1,          // 예약 우선권 기간(수업일)
  suspension_multiplier: 1,  // 이용 정지 수업일 = 연체 수업일 × 배수 (0이면 정지 없음)
  student_idle_seconds: 90,  // 학생 자동 로그아웃(미사용 초)
};

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER,
  name TEXT NOT NULL,
  qr_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  memo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT,
  publisher TEXT,
  isbn TEXT,
  category TEXT,
  cover_image TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn);

CREATE TABLE IF NOT EXISTS copies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id),
  copy_code TEXT NOT NULL UNIQUE,
  qr_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available','loaned','lost','repair','discarded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copies_book ON copies(book_id);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  copy_id INTEGER NOT NULL REFERENCES copies(id),
  loaned_at TEXT NOT NULL,
  loan_date TEXT NOT NULL,
  original_due_date TEXT NOT NULL,
  extension_count INTEGER NOT NULL DEFAULT 0,
  extended_at TEXT,
  final_due_date TEXT NOT NULL,
  due_school_days INTEGER NOT NULL DEFAULT 0,
  returned_at TEXT,
  return_date TEXT,
  overdue_school_days INTEGER NOT NULL DEFAULT 0,
  suspension_until TEXT,
  suspension_waived INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','returned','admin_closed')),
  reservation_id INTEGER
);
-- 같은 소장본에 활성 대출은 1건만 존재 (동시 대출 방지 최종 안전장치)
CREATE UNIQUE INDEX IF NOT EXISTS uq_loans_active_copy ON loans(copy_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_loans_student ON loans(student_id, status);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  book_id INTEGER NOT NULL REFERENCES books(id),
  reserved_at TEXT NOT NULL,
  priority_started_at TEXT,
  priority_start_date TEXT,
  priority_expires_on TEXT,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','priority','completed','cancelled','expired')),
  closed_at TEXT
);
-- 같은 학생의 같은 도서 활성 예약 중복 방지
CREATE UNIQUE INDEX IF NOT EXISTS uq_res_active ON reservations(student_id, book_id)
  WHERE status IN ('waiting','priority');
CREATE INDEX IF NOT EXISTS idx_res_book ON reservations(book_id, status);

-- 법정 공휴일·대체공휴일 (내장 데이터 또는 공공데이터 동기화)
CREATE TABLE IF NOT EXISTS public_holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 교사가 직접 지정한 학교 일정 (공휴일보다 우선). 재량휴업일·기타 휴업일·특별 수업일 등
CREATE TABLE IF NOT EXISTS school_calendar (
  date TEXT PRIMARY KEY,
  is_school_day INTEGER NOT NULL,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'teacher',
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('student','admin')),
  subject_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- 학생이 (빌려 본 적 있는) 책에 남기는 별점·한줄평
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_student_book ON reviews(student_id, book_id);
CREATE INDEX IF NOT EXISTS idx_reviews_book ON reviews(book_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('student','admin','system')),
  actor_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const now = nowISO();
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, String(v), now, 'system');
  const has = db.prepare('SELECT COUNT(*) c FROM public_holidays').get().c;
  if (!has) {
    for (const list of Object.values(BUILTIN_HOLIDAYS)) importHolidays(db, list);
  }
}

// 공휴일 반영. 교사 일정(school_calendar)은 별도 테이블이므로 영향을 받지 않는다.
export function importHolidays(db, list) {
  const now = nowISO();
  const stmt = db.prepare(`INSERT INTO public_holidays(date, name, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`);
  let n = 0;
  for (const [date, name] of list) { stmt.run(date, name, now); n++; }
  return n;
}

export function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    if (r.key in DEFAULT_SETTINGS) out[r.key] = Number(r.value);
  }
  return out;
}

// 트랜잭션: BEGIN IMMEDIATE 로 쓰기 잠금을 먼저 잡아 동시 요청을 직렬화한다.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

export function audit(db, actor, action, targetType, targetId, details) {
  db.prepare(`INSERT INTO audit_logs(actor_type, actor_id, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    actor?.type || 'system', actor?.id ?? null, action, targetType ?? null, targetId ?? null,
    details == null ? null : JSON.stringify(details), nowISO());
}
