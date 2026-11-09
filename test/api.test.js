// 실제 서버를 띄워 HTTP로 검증: 동시 대출, 권한 분리, 본인 정보만 조회
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openDb, resetForTests } from '../src/db.js';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
let proc;

async function call(method, p, body, cookie) {
  const res = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null };
}

before(async () => {
  // 서버를 띄우기 전에 테스트 DB를 비워 둔다 (Postgres는 SQLite ':memory:'처럼 매번 새로 만들 수 없다).
  const setupDb = await openDb(TEST_DB_URL);
  await resetForTests(setupDb);
  await setupDb.end();

  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    env: { ...process.env, PORT: String(PORT), DATABASE_URL: TEST_DB_URL, FAKE_TODAY: '2026-11-04' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/config'); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
after(async () => {
  if (proc) {
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      proc.kill();
    });
  }
});

test('API 전체 흐름: 동시 대출 1명만 성공, 권한 분리', async () => {
  assert.equal((await call('POST', '/api/setup', { username: 'teacher', password: 'password123' })).status, 200);
  assert.equal((await call('POST', '/api/setup', { username: 'x', password: 'password123' })).status, 403); // 두 번째 설정 불가
  const login = await call('POST', '/api/admin/login', { username: 'teacher', password: 'password123' });
  const A = login.cookie;
  assert.equal((await call('POST', '/api/admin/login', { username: 'teacher', password: 'wrong-pass' })).status, 401);

  const names = Array.from({ length: 8 }, (_, i) => ({ name: `학생${i + 1}`, number: i + 1 }));
  await call('POST', '/api/admin/students/import', { rows: names }, A);
  await call('POST', '/api/admin/books', { title: '한 권뿐인 책', copies: 1 }, A);
  const students = (await call('GET', '/api/admin/print/students', null, A)).data;
  const copy = (await call('GET', '/api/admin/print/copies', null, A)).data[0];

  // 학생 세션은 공용 기기에서 하나씩이지만, 여기서는 서로 다른 기기를 흉내 내기 위해 로그인 직후 쿠키를 모아 둔다
  // (새 학생 로그인 시 이전 학생 세션이 끊기므로 쿠키마다 다시 로그인)
  const tries = await Promise.all(students.map(async (s) => {
    const l = await call('POST', '/api/student/login', { code: s.qr_token });
    return l.cookie;
  }));
  // 마지막 로그인 학생 1명만 유효 → 공용 기기 정책 확인
  const valid = [];
  for (const c of tries) if ((await call('GET', '/api/student/me', null, c)).status === 200) valid.push(c);
  assert.equal(valid.length, 1);

  // 동시 대출: 서로 다른 기기라고 가정하고 관리자 대리 대출 API로 8명이 동시에 같은 소장본 요청
  const results = await Promise.all(students.map(s => call('POST', '/api/admin/loans', { student_id: s.id, code: copy.qr_token }, A)));
  const ok = results.filter(r => r.status === 200);
  assert.equal(ok.length, 1, '정확히 한 명만 대출 성공');
  assert.ok(results.filter(r => r.status === 409).length === 7);

  // 학생은 관리자 API 접근 불가
  const sc = valid[0];
  assert.equal((await call('GET', '/api/admin/students', null, sc)).status, 401);
  assert.equal((await call('GET', '/api/admin/dashboard', null, sc)).status, 401);
  // 관리자 쿠키로 학생 API 불가 (역할 분리)
  assert.equal((await call('GET', '/api/student/me', null, A)).status, 401);
  // 학생 도서 목록에는 다른 학생 이름이 없다
  const books = await call('GET', '/api/student/books', null, sc);
  assert.equal(books.status, 200);
  assert.ok(!JSON.stringify(books.data).includes('학생'));
  // 학생 반납: 남의 책 반납 불가
  const borrower = ok[0];
  void borrower;
  const ret = await call('POST', '/api/student/return', { code: copy.qr_token }, sc);
  const me = (await call('GET', '/api/student/me', null, sc)).data;
  if (me.loans.length === 0) assert.equal(ret.data.error.code, 'NOT_YOURS');
  // 교차 출처 쓰기 차단
  const csrf = await fetch(BASE + '/api/admin/students', { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json', Cookie: A }, body: '{"name":"x"}' });
  assert.equal(csrf.status, 403);
  // 변경 사유 없는 관리자 조치 거부
  const loanId = (await call('GET', '/api/admin/loans?status=active', null, A)).data[0].id;
  assert.equal((await call('POST', `/api/admin/loans/${loanId}/return`, {}, A)).status, 400);
  assert.equal((await call('POST', `/api/admin/loans/${loanId}/return`, { reason: '테스트' }, A)).status, 200);
});
