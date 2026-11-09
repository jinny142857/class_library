// 데이터베이스(Postgres, Neon) 스키마와 공통 헬퍼. (neon-vercel-migration 브랜치)
// 원래 node:sqlite 기반이었으나, 여러 네트워크에서 서버에 접속 가능하도록
// Neon(서버리스 Postgres) + Vercel 배포용으로 옮기는 중입니다.
import { Pool, types } from '@neondatabase/serverless';
import { BUILTIN_HOLIDAYS } from './holidays.js';
import { nowISO } from './clock.js';

// Postgres는 COUNT(*)/bigint(OID 20)를 기본으로 문자열로 돌려준다(큰 수의 정밀도 손실 방지 목적).
// 이 앱의 모든 집계는 안전한 정수 범위 안이므로, 일관되게 숫자로 받도록 전역 설정한다.
// (이걸 빼먹으면 "10" >= "9" 같은 문자열 비교가 사전식으로 되어 로직이 미묘하게 깨진다.)
types.setTypeParser(20, (v) => parseInt(v, 10));

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
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  number INTEGER,
  name TEXT NOT NULL,
  qr_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  memo TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS books (
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
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
  id SERIAL PRIMARY KEY,
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

// ? 플레이스홀더를 Postgres의 $1,$2... 로 바꿔서, SQLite 시절 쿼리 문자열을 거의 그대로 쓸 수 있게 한다.
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// conn 은 Pool(트랜잭션 밖) 또는 tx() 안에서 체크아웃한 Client(트랜잭션 안) 둘 다 가능 — 둘 다 .query()를 지원한다.
export async function get(conn, sql, params = []) {
  const r = await conn.query(toPgSql(sql), params);
  return r.rows[0];
}
export async function all(conn, sql, params = []) {
  const r = await conn.query(toPgSql(sql), params);
  return r.rows;
}
export async function run(conn, sql, params = []) {
  const r = await conn.query(toPgSql(sql), params);
  return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id };
}

export async function openDb(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL 환경변수가 설정되지 않았습니다. (Neon 연결 문자열)');
  const pool = new Pool({ connectionString });
  await pool.query(SCHEMA);
  await seed(pool);
  return pool;
}

// 테스트 전용: 모든 테이블을 비우고 기본값(설정·공휴일)을 다시 심는다.
// 반드시 별도의 테스트용 DB(TEST_DATABASE_URL)에서만 쓸 것 — 운영 데이터가 있는 DB에 쓰면 전부 지워진다.
export async function resetForTests(db) {
  await db.query(`TRUNCATE students, books, copies, loans, reservations, reviews, audit_logs,
    sessions, school_calendar, public_holidays, settings, admins RESTART IDENTITY CASCADE`);
  await seed(db);
}

async function seed(db) {
  const now = nowISO();
  // Neon은 네트워크 너머에 있어서 한 행씩 INSERT를 반복하면 왕복 시간이 쌓인다 — 한 번에 묶어서 보낸다.
  const entries = Object.entries(DEFAULT_SETTINGS);
  const values = entries.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`).join(', ');
  const params = entries.flatMap(([k, v]) => [k, String(v), now, 'system']);
  await db.query(`INSERT INTO settings(key, value, updated_at, updated_by) VALUES ${values} ON CONFLICT (key) DO NOTHING`, params);
  const has = (await get(db, 'SELECT COUNT(*) c FROM public_holidays')).c;
  if (Number(has) === 0) await importHolidays(db, Object.values(BUILTIN_HOLIDAYS).flat());
}

// 공휴일 반영. 교사 일정(school_calendar)은 별도 테이블이므로 영향을 받지 않는다.
export async function importHolidays(db, list) {
  if (!list.length) return 0;
  const now = nowISO();
  const values = list.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(', ');
  const params = list.flatMap(([date, name]) => [date, name, now]);
  await db.query(`INSERT INTO public_holidays(date, name, updated_at) VALUES ${values}
    ON CONFLICT(date) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`, params);
  return list.length;
}

export async function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of await all(db, 'SELECT key, value FROM settings')) {
    if (r.key in DEFAULT_SETTINGS) out[r.key] = Number(r.value);
  }
  return out;
}

// 트랜잭션: 같은 커넥션(client)을 체크아웃해 BEGIN~COMMIT 사이에 모든 쿼리를 실행한다.
// fn(client) 형태로 호출하므로, 트랜잭션 안에서는 this.db 대신 전달받은 client를 써야 한다.
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(db, actor, action, targetType, targetId, details) {
  await run(db, `INSERT INTO audit_logs(actor_type, actor_id, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    actor?.type || 'system', actor?.id ?? null, action, targetType ?? null, targetId ?? null,
    details == null ? null : JSON.stringify(details), nowISO()]);
}
