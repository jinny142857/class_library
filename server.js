// 양배추 책방 서버. (neon-vercel-migration 브랜치: Postgres(Neon) + Vercel 배포용)
//   로컬/Railway 실행: node server.js        (기본 포트 3000, DATABASE_URL 환경변수 필요)
//   Vercel 배포: api/index.js 가 이 파일의 getApp()을 재사용한다.
//   환경변수: DATABASE_URL(필수, Neon 연결 문자열), PORT, TLS_CERT/TLS_KEY, NL_API_KEY, KAKAO_REST_API_KEY, HOLIDAY_API_KEY, CRON_SECRET
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, getSettings, importHolidays, get, all, run, audit } from './src/db.js';
import { Library, LibError, makeCtx } from './src/library.js';
import { Admin } from './src/admin.js';
import { Sessions, RateLimiter, verifyPassword, createAdmin, hashPassword } from './src/auth.js';
import { lookupIsbn } from './src/isbn.js';
import { fetchHolidaysFromApi } from './src/holidays.js';
import { todayKST, isValidDate } from './src/clock.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 이 변수들은 buildApp()이 채운 뒤에야 라우트 핸들러가 실행되므로(getApp()이 항상 먼저 끝난다), 클로저로 참조해도 안전하다.
let db, lib, admin, sessions;
const loginLimiter = new RateLimiter(10, 60_000);
const studentLimiter = new RateLimiter(30, 60_000);

let _appPromise = null;
export function getApp() {
  if (!_appPromise) _appPromise = buildApp();
  return _appPromise;
}

async function buildApp() {
  db = await openDb();
  lib = await Library.create(db);
  admin = new Admin(db, lib);
  sessions = new Sessions(db);
  // 초기 관리자 계정을 환경변수로 만들 수도 있다 (없으면 첫 접속 시 화면에서 생성)
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && !(await get(db, 'SELECT COUNT(*) c FROM admins')).c) {
    await createAdmin(db, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD, '선생님');
  }
  return { db, lib, admin, sessions, handle };
}

// ───────────── HTTP 유틸 ─────────────
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders(),
    ...headers,
  });
  res.end(data);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(self)',
  };
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  // Vercel 서버리스 런타임은 req.socket을 노출하지 않는다(null) — 거기선 x-forwarded-proto로만 판단해야 한다.
  return !!req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function cookie(req, name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict${isSecure(req) ? '; Secure' : ''}${maxAge != null ? `; Max-Age=${maxAge}` : ''}`;
}

async function readBody(req, limit = 2 * 1024 * 1024, raw = false) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, '요청이 너무 큽니다.');
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  if (raw) return buf;
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, '잘못된 요청입니다.'); }
}

function ip(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
}

// ───────────── 라우터 ─────────────
const routes = [];
const route = (method, pattern, role, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, role, handler });
};

// 공용
route('GET', '/api/config', null, async () => ({
  setup_needed: !(await get(db, 'SELECT COUNT(*) c FROM admins')).c,
  student_idle_seconds: (await getSettings(db)).student_idle_seconds,
  today: todayKST(),
}));

route('POST', '/api/setup', null, async ({ body }) => {
  if ((await get(db, 'SELECT COUNT(*) c FROM admins')).c) throw new HttpError(403, '이미 관리자 계정이 있습니다.');
  await createAdmin(db, body.username, body.password, body.display_name);
  return { ok: true };
});

// 로그인 전 첫 화면에 보여줄 책꽂이 (개인정보 없이 제목·표지·대출 상태·별점만)
route('GET', '/api/public/books', null, async ({ ctx }) => {
  await lib.refreshAll(ctx);
  const rows = await all(db, `SELECT b.id, b.title, b.author, b.cover_image, b.category,
      (SELECT COUNT(*) FROM copies c WHERE c.book_id=b.id AND c.status='available') AS available,
      (SELECT COUNT(*) FROM copies c WHERE c.book_id=b.id AND c.status IN ('available','loaned','repair')) AS usable,
      (SELECT COUNT(*) FROM reservations r WHERE r.book_id=b.id AND r.status='priority') AS held,
      (SELECT COUNT(*) FROM reviews rv WHERE rv.book_id=b.id) AS review_count,
      (SELECT AVG(rating) FROM reviews rv WHERE rv.book_id=b.id) AS avg_rating
    FROM books b WHERE b.status='active'
    ORDER BY b.title LIMIT 60`);
  return rows.filter(b => b.usable > 0).map(b => ({
    id: b.id, title: b.title, author: b.author, cover_image: b.cover_image, category: b.category,
    on_shelf: b.available - b.held > 0,
    review_count: Number(b.review_count), avg_rating: b.review_count ? Math.round(b.avg_rating * 10) / 10 : null,
  }));
});

// ── 학생 ──
route('POST', '/api/student/login', null, async ({ req, body, res }) => {
  if (!studentLimiter.hit(ip(req))) throw new HttpError(429, '잠시 후 다시 해 주세요.');
  const code = String(body.code || '').trim();
  const s = await get(db, 'SELECT * FROM students WHERE qr_token=?', [code]);
  if (!s) {
    if (code.startsWith('BK-')) throw new LibError('WRONG_QR', '이건 책의 QR코드예요.', '내 이름이 적힌 QR 카드를 보여 주세요.');
    throw new LibError('UNKNOWN_STUDENT', '등록되지 않은 QR 카드예요.', '선생님께 말씀해 주세요.');
  }
  if (s.status !== 'active') throw new LibError('STUDENT_INACTIVE', '사용할 수 없는 QR 카드예요.', '선생님께 말씀해 주세요.');
  const token = await sessions.create('student', s.id);
  res.setHeader('Set-Cookie', cookie(req, 'cl_student', token));
  await audit(db, { type: 'student', id: s.id }, 'student_login', 'student', s.id, null);
  return { ok: true, name: s.name };
});

route('POST', '/api/student/logout', null, async ({ req, res }) => {
  const t = parseCookies(req).cl_student;
  if (t) await sessions.destroy(t);
  res.setHeader('Set-Cookie', cookie(req, 'cl_student', '', 0));
  return { ok: true };
});

route('GET', '/api/student/me', 'student', async ({ actor, ctx }) => {
  await lib.refreshAll(ctx);
  return { ...(await lib.studentState(actor.id, ctx)), idle_seconds: (await getSettings(db)).student_idle_seconds };
});
route('POST', '/api/student/borrow', 'student', ({ actor, ctx, body }) => lib.borrow(actor.id, body.code, ctx));
route('POST', '/api/student/return', 'student', ({ actor, ctx, body }) => lib.returnBook(actor.id, body.code, ctx));
route('POST', '/api/student/extend', 'student', ({ actor, ctx, body }) => lib.extend(actor.id, Number(body.loan_id), ctx));
route('GET', '/api/student/history', 'student', ({ actor }) => lib.history(actor.id, 200));
route('GET', '/api/student/books', 'student', async ({ actor, url, ctx }) => {
  await lib.refreshAll(ctx);
  const q = (url.searchParams.get('q') || '').trim();
  const like = `%${q}%`;
  const rows = await all(db, `SELECT b.id, b.title, b.author, b.cover_image, b.category,
      (SELECT COUNT(*) FROM copies c WHERE c.book_id=b.id AND c.status='available') AS available,
      (SELECT COUNT(*) FROM copies c WHERE c.book_id=b.id AND c.status IN ('available','loaned','repair')) AS usable,
      (SELECT COUNT(*) FROM reservations r WHERE r.book_id=b.id AND r.status='priority') AS held,
      (SELECT COUNT(*) FROM reservations r WHERE r.book_id=b.id AND r.status IN ('waiting','priority')) AS queue,
      (SELECT r.id FROM reservations r WHERE r.book_id=b.id AND r.student_id=? AND r.status IN ('waiting','priority')) AS my_reservation,
      (SELECT l.id FROM loans l JOIN copies c ON c.id=l.copy_id WHERE c.book_id=b.id AND l.student_id=? AND l.status='active') AS my_loan,
      (SELECT COUNT(*) FROM reviews rv WHERE rv.book_id=b.id) AS review_count,
      (SELECT AVG(rating) FROM reviews rv WHERE rv.book_id=b.id) AS avg_rating
    FROM books b WHERE b.status='active' AND (b.title ILIKE ? OR COALESCE(b.author,'') ILIKE ?)
    ORDER BY b.title LIMIT 60`, [actor.id, actor.id, like, like]);
  return rows.map(b => ({
    id: b.id, title: b.title, author: b.author, cover_image: b.cover_image, category: b.category,
    on_shelf: b.available - b.held > 0, queue: b.queue, usable: b.usable > 0,
    my_reservation: !!b.my_reservation, my_loan: !!b.my_loan,
    review_count: Number(b.review_count), avg_rating: b.review_count ? Math.round(b.avg_rating * 10) / 10 : null,
  }));
});
route('POST', '/api/student/reserve', 'student', async ({ actor, ctx, body }) => {
  let bookId = Number(body.book_id);
  if (!bookId && body.code) {
    const c = await lib.resolveCopy(body.code);
    if (!c) throw new LibError('UNKNOWN_BOOK', '등록되지 않은 책이에요.');
    bookId = c.book_id;
  }
  return lib.reserve(actor.id, bookId, ctx);
});
route('POST', '/api/student/reservations/:id/cancel', 'student', ({ actor, ctx, params }) =>
  lib.cancelReservation(Number(params.id), ctx, { studentId: actor.id }));
route('GET', '/api/student/books/:id', 'student', async ({ actor, params, ctx }) => {
  await lib.refreshAll(ctx);
  return lib.bookDetail(Number(params.id), actor.id);
});
route('POST', '/api/student/books/:id/review', 'student', ({ actor, params, body, ctx }) =>
  lib.rateBook(actor.id, Number(params.id), body.rating, body.comment, ctx));

// ── 관리자 ──
route('POST', '/api/admin/login', null, async ({ req, res, body }) => {
  if (!loginLimiter.hit(ip(req))) throw new HttpError(429, '로그인 시도가 너무 많습니다. 1분 후 다시 시도해 주세요.');
  const a = await get(db, 'SELECT * FROM admins WHERE username=?', [String(body.username || '').trim()]);
  if (!a || !verifyPassword(String(body.password || ''), a.password_hash)) throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
  const token = await sessions.create('admin', a.id);
  res.setHeader('Set-Cookie', cookie(req, 'cl_admin', token));
  await audit(db, { type: 'admin', id: a.id }, 'admin_login', 'admin', a.id, null);
  return { ok: true };
});
route('POST', '/api/admin/logout', null, async ({ req, res }) => {
  const t = parseCookies(req).cl_admin;
  if (t) await sessions.destroy(t);
  res.setHeader('Set-Cookie', cookie(req, 'cl_admin', '', 0));
  return { ok: true };
});
route('GET', '/api/admin/me', 'admin', ({ actor }) => ({ id: actor.id, username: actor.username, name: actor.name }));
route('GET', '/api/admin/dashboard', 'admin', async ({ ctx }) => { await lib.refreshAll(ctx); return admin.dashboard(ctx.today); });

// 도서
route('GET', '/api/admin/books', 'admin', ({ url }) => admin.listBooks({ q: url.searchParams.get('q'), includeInactive: url.searchParams.get('inactive') === '1' }));
route('POST', '/api/admin/books', 'admin', ({ body, ctx }) => admin.createBook(body, ctx));
route('GET', '/api/admin/books/:id', 'admin', async ({ params, ctx }) => { await lib.refreshAll(ctx); return admin.bookDetail(Number(params.id)); });
route('PUT', '/api/admin/books/:id', 'admin', ({ params, body, ctx }) => admin.updateBook(Number(params.id), body, ctx));
route('DELETE', '/api/admin/books/:id', 'admin', ({ params, ctx }) => admin.deleteBook(Number(params.id), ctx));
route('POST', '/api/admin/books/:id/copies', 'admin', ({ params, body, ctx }) => admin.addCopies(Number(params.id), body.count, body.codes, ctx));
route('PUT', '/api/admin/copies/:id', 'admin', ({ params, body, ctx }) => admin.updateCopy(Number(params.id), body, ctx));
route('DELETE', '/api/admin/copies/:id', 'admin', ({ params, ctx }) => admin.deleteCopy(Number(params.id), ctx));
route('POST', '/api/admin/copies/:id/reissue', 'admin', ({ params, ctx }) => admin.reissueCopyQr(Number(params.id), ctx));
route('GET', '/api/admin/categories', 'admin', () => admin.categories());
route('GET', '/api/admin/isbn/:isbn', 'admin', async ({ params }) => {
  const r = await lookupIsbn(params.isbn);
  const existing = r.isbn ? await all(db, 'SELECT id, title FROM books WHERE isbn=?', [r.isbn]) : [];
  return { ...r, existing };
});
route('GET', '/api/admin/lookup-code', 'admin', async ({ url }) => {
  const code = url.searchParams.get('code') || '';
  const c = await lib.resolveCopy(code);
  if (c) return { type: 'copy', copy_id: c.id, book_id: c.book_id, title: c.title, copy_code: c.copy_code };
  const s = await get(db, 'SELECT id, name FROM students WHERE qr_token=?', [code.trim()]);
  if (s) return { type: 'student', student_id: s.id, name: s.name };
  return { type: null };
});

// 학생
route('GET', '/api/admin/students', 'admin', ({ ctx }) => admin.listStudents(ctx.today));
route('POST', '/api/admin/students', 'admin', ({ body, ctx }) => admin.createStudent(body, ctx));
route('POST', '/api/admin/students/import', 'admin', async ({ body, ctx }) => {
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 200) : [];
  if (!rows.length) throw new HttpError(400, '등록할 학생이 없습니다.');
  const created = await admin.importStudents(rows, ctx);
  return { created: created.length };
});
route('GET', '/api/admin/students/:id', 'admin', ({ params, ctx }) => admin.studentDetail(Number(params.id), ctx.today));
route('PUT', '/api/admin/students/:id', 'admin', ({ params, body, ctx }) => admin.updateStudent(Number(params.id), body, ctx));
route('POST', '/api/admin/students/:id/reissue', 'admin', ({ params, ctx }) => admin.reissueStudentQr(Number(params.id), ctx));
route('POST', '/api/admin/students/:id/waive', 'admin', ({ params, body, ctx }) => lib.adminWaiveSuspension(Number(params.id), reasonOf(body), ctx));

// 대출
route('GET', '/api/admin/loans', 'admin', ({ url, ctx }) => admin.listLoans({ status: url.searchParams.get('status'), q: url.searchParams.get('q'), today: ctx.today }));
route('POST', '/api/admin/loans', 'admin', ({ body, ctx }) => {
  const studentId = Number(body.student_id);
  if (body.copy_id) return lib.adminBorrow(studentId, Number(body.copy_id), ctx);
  return lib.borrow(studentId, body.code, ctx);
});
route('POST', '/api/admin/loans/:id/return', 'admin', ({ params, body, ctx }) => lib.adminReturn(Number(params.id), ctx, { waive: !!body.waive, reason: reasonOf(body) }));
route('PUT', '/api/admin/loans/:id/due', 'admin', ({ params, body, ctx }) => {
  if (!isValidDate(body.due_date)) throw new HttpError(400, '날짜가 올바르지 않습니다.');
  return lib.adminSetDue(Number(params.id), body.due_date, reasonOf(body), ctx);
});

// 예약
route('GET', '/api/admin/reservations', 'admin', async ({ url, ctx }) => { await lib.refreshAll(ctx); return admin.listReservations({ scope: url.searchParams.get('scope') }); });
route('POST', '/api/admin/reservations/:id/cancel', 'admin', ({ params, body, ctx }) => lib.cancelReservation(Number(params.id), ctx, { reason: reasonOf(body) }));
route('GET', '/api/admin/reservation-events', 'admin', () => admin.auditLogs({ limit: 200, action: 'reservation' }));

// 학사일정
route('GET', '/api/admin/calendar', 'admin', ({ url, ctx }) => admin.calendarMonth(url.searchParams.get('month') || ctx.today.slice(0, 7)));
route('PUT', '/api/admin/calendar/:date', 'admin', ({ params, body, ctx }) => admin.setCalendarDay(params.date, body, ctx));
route('DELETE', '/api/admin/calendar/:date', 'admin', ({ params, ctx }) => admin.clearCalendarDay(params.date, ctx));
route('PUT', '/api/admin/holidays/:date', 'admin', ({ params, body, ctx }) => admin.setHoliday(params.date, body.name, ctx));
route('DELETE', '/api/admin/holidays/:date', 'admin', ({ params, ctx }) => admin.deleteHoliday(params.date, ctx));
route('POST', '/api/admin/holidays/sync', 'admin', async ({ body, ctx }) => {
  const key = process.env.HOLIDAY_API_KEY;
  if (!key) throw new HttpError(400, '공휴일 API 키(HOLIDAY_API_KEY)가 설정되지 않았습니다. 내장 공휴일 데이터를 사용 중입니다.');
  const year = Number(body.year);
  if (!(year >= 2020 && year <= 2100)) throw new HttpError(400, '연도가 올바르지 않습니다.');
  const list = await fetchHolidaysFromApi(year, key);
  const n = await importHolidays(db, list);
  await lib.cal.refresh();
  await audit(db, ctx.actor, 'admin_holiday_sync', 'calendar', null, { year, count: n });
  return { imported: n, impact: await lib.calendarImpact() };
});
route('GET', '/api/admin/calendar-impact', 'admin', () => lib.calendarImpact());
route('POST', '/api/admin/calendar-impact/apply', 'admin', ({ body, ctx }) => lib.applyCalendarImpact(ctx, {
  loanIds: (body.loan_ids || []).map(Number), reservationIds: (body.reservation_ids || []).map(Number),
}));

// 설정·통계·이력
route('GET', '/api/admin/settings', 'admin', async () => ({
  settings: await getSettings(db),
  meta: await all(db, 'SELECT key, updated_at, updated_by FROM settings'),
  integrations: { nl: !!process.env.NL_API_KEY, kakao: !!process.env.KAKAO_REST_API_KEY, holiday: !!process.env.HOLIDAY_API_KEY },
}));
route('PUT', '/api/admin/settings', 'admin', ({ body, ctx }) => admin.updateSettings(body, ctx));
route('GET', '/api/admin/stats', 'admin', ({ url }) => admin.stats({ from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
route('GET', '/api/admin/audit', 'admin', ({ url }) => admin.auditLogs({ limit: Math.min(1000, Number(url.searchParams.get('limit')) || 300), action: url.searchParams.get('action') }));

// QR 인쇄용 데이터
route('GET', '/api/admin/print/students', 'admin', async ({ url }) => {
  const ids = idsOf(url);
  const rows = await all(db, "SELECT id, number, name, qr_token FROM students WHERE status='active' ORDER BY COALESCE(number, 9999), name");
  return ids ? rows.filter(r => ids.includes(r.id)) : rows;
});
route('GET', '/api/admin/print/copies', 'admin', async ({ url }) => {
  const ids = idsOf(url);
  const bookIds = (url.searchParams.get('books') || '').split(',').map(Number).filter(Boolean);
  const rows = await all(db, `SELECT c.id, c.copy_code, c.qr_token, b.id AS book_id, b.title FROM copies c JOIN books b ON b.id=c.book_id
    WHERE c.status<>'discarded' AND b.status='active' ORDER BY b.title, c.id`);
  if (ids) return rows.filter(r => ids.includes(r.id));
  if (bookIds.length) return rows.filter(r => bookIds.includes(r.book_id));
  return rows;
});

// 관리자 계정
route('GET', '/api/admin/admins', 'admin', () => all(db, 'SELECT id, username, display_name, created_at FROM admins ORDER BY id'));
route('POST', '/api/admin/admins', 'admin', async ({ body, ctx }) => {
  const id = await createAdmin(db, body.username, body.password, body.display_name);
  await audit(db, ctx.actor, 'admin_create_admin', 'admin', id, { username: body.username });
  return { ok: true };
});
route('PUT', '/api/admin/password', 'admin', async ({ body, actor, ctx }) => {
  const a = await get(db, 'SELECT * FROM admins WHERE id=?', [actor.id]);
  if (!verifyPassword(String(body.current || ''), a.password_hash)) throw new HttpError(400, '현재 비밀번호가 올바르지 않습니다.');
  if (String(body.next || '').length < 8) throw new HttpError(400, '새 비밀번호는 8자 이상이어야 합니다.');
  await run(db, 'UPDATE admins SET password_hash=? WHERE id=?', [hashPassword(String(body.next)), actor.id]);
  await audit(db, ctx.actor, 'admin_change_password', 'admin', actor.id, null);
  return { ok: true };
});

// 유지보수(예약 우선권 승계·만료, 세션 정리). Vercel에서는 서버가 상시로 떠 있지 않으므로
// 평소엔 각 라우트가 호출하는 lib.refreshAll()로 충분하지만, 아무도 접속하지 않는 기간이 길어지면
// 밀린 처리가 쌓일 수 있다 — vercel.json의 Cron이 이 주소를 주기적으로 호출해 보완한다.
route('GET', '/api/cron/maintenance', null, async ({ url }) => {
  if (process.env.CRON_SECRET && url.searchParams.get('key') !== process.env.CRON_SECRET) throw new HttpError(401, 'unauthorized');
  const n = await lib.refreshAll(makeCtx({ type: 'system' }));
  await sessions.cleanup();
  return { ok: true, refreshed_books: n };
});

function reasonOf(body) {
  const r = String(body?.reason || '').trim().slice(0, 300);
  if (!r) throw new HttpError(400, '변경 사유를 입력해 주세요.');
  return r;
}
function idsOf(url) {
  const v = url.searchParams.get('ids');
  return v ? v.split(',').map(Number).filter(Boolean) : null;
}

// ───────────── 정적 파일 (로컬/Railway 실행 시. Vercel에서는 vercel.json이 CDN에서 직접 서빙) ─────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.webp': 'image/webp' };
const PUBLIC = path.join(ROOT, 'public');

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  if (pathname === '/print') pathname = '/print.html';
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...securityHeaders(),
    });
    res.end(data);
  });
}

// ───────────── 요청 처리 ─────────────
export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  }
  // 교차 출처 쓰기 요청 차단 (CSRF 방지)
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: { message: '허용되지 않은 요청입니다.' } });
  }
  const m = routes.find(r => r.method === req.method && r.re.test(url.pathname));
  if (!m) return send(res, 404, { error: { message: '없는 주소입니다.' } });
  const params = Object.fromEntries(m.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(m.re)[i + 1])]));
  try {
    let actor = null;
    if (m.role) {
      const cookies = parseCookies(req);
      const s = await sessions.touch(m.role === 'student' ? cookies.cl_student : cookies.cl_admin, m.role);
      if (!s) throw new HttpError(401, m.role === 'student' ? '다시 QR 카드로 로그인해 주세요.' : '로그인이 필요합니다.');
      if (m.role === 'student') {
        const st = await get(db, 'SELECT * FROM students WHERE id=?', [s.subject_id]);
        if (!st || st.status !== 'active') throw new HttpError(401, '다시 QR 카드로 로그인해 주세요.');
        actor = { type: 'student', id: st.id, name: st.name };
      } else {
        const a = await get(db, 'SELECT * FROM admins WHERE id=?', [s.subject_id]);
        if (!a) throw new HttpError(401, '로그인이 필요합니다.');
        actor = { type: 'admin', id: a.id, name: a.display_name || a.username, username: a.username };
      }
    }
    const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    const ctx = makeCtx(actor || { type: 'system' });
    const out = await m.handler({ req, res, url, params, body, actor, ctx });
    if (out !== undefined && !res.writableEnded) send(res, 200, out);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof LibError) return send(res, 409, { error: { code: e.code, message: e.message, hint: e.hint, extra: e.extra } });
    if (e.status) return send(res, e.status, { error: { message: e.message } });
    if (e.code === '23505') return send(res, 409, { error: { code: 'CONFLICT', message: '방금 다른 친구가 이 책을 빌렸어요.' } });
    console.error(e);
    send(res, 500, { error: { message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' } });
  }
}

// ───────────── 시작 (node server.js로 직접 실행할 때만 — Vercel에서는 api/index.js가 getApp()만 재사용) ─────────────
const isMain = (() => {
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
})();

if (isMain) {
  const PORT = Number(process.env.PORT) || 3000;
  getApp().then(() => {
    let server;
    if (process.env.TLS_CERT && process.env.TLS_KEY) {
      server = https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handle);
    } else {
      server = http.createServer(handle);
    }
    server.listen(PORT, () => {
      const proto = process.env.TLS_CERT ? 'https' : 'http';
      console.log(`양배추 책방 실행 중: ${proto}://localhost:${PORT}  (교사용: ${proto}://localhost:${PORT}/admin)`);
    });
    // 상시 서버에서만 의미 있는 주기 작업(예약 우선권 만료/승계, 세션 정리). Vercel에서는 /api/cron/maintenance + Cron으로 대체.
    setInterval(() => {
      lib.refreshAll(makeCtx({ type: 'system' })).then(() => sessions.cleanup()).catch(console.error);
    }, 5 * 60_000).unref();
  }).catch(e => { console.error('서버 시작 실패:', e); process.exit(1); });
}
