import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, resetForTests, all } from '../src/db.js';
import { Library, LibError } from '../src/library.js';
import { Admin } from '../src/admin.js';

// 2026-11-04 = 수요일
const T = { type: 'admin', id: 1, name: 'teacher' };

// Postgres(Neon)에는 SQLite의 ':memory:' 같은 1회용 DB가 없으므로, 테스트 전용 DB(또는 브랜치)를
// TEST_DATABASE_URL로 지정하고 매 테스트 전에 TRUNCATE로 초기화한다. 지정하지 않으면 DATABASE_URL을
// 쓰지만, 그러면 테스트가 실제 데이터를 지울 수 있으니 반드시 별도 DB를 추천한다.
let db, lib, admin;

before(async () => {
  db = await openDb(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
});

beforeEach(async () => {
  await resetForTests(db);
  lib = await Library.create(db);
  admin = new Admin(db, lib);
});

after(async () => {
  await db.end();
});

function setup() {
  const ctx = (today, actor = T) => ({ actor, today, now: `${today}T01:00:00.000Z` });
  const st = (name) => admin.createStudent({ name }, ctx('2026-11-01'));
  const book = (title, copies = 1) => admin.createBook({ title, copies }, ctx('2026-11-01'));
  const sctx = (s, today) => ctx(today, { type: 'student', id: s.id });
  return { db, lib, admin, ctx, st, book, sctx };
}

const code = (e) => (e instanceof LibError ? e.code : e.message);
async function throwsCode(fn, c) {
  try { await fn(); } catch (e) { assert.equal(code(e), c); return e; }
  assert.fail(`expected ${c}`);
}

test('수업일 계산: 주말·공휴일·교사 휴업일 제외, 교사 지정 우선', async () => {
  const { admin, ctx } = setup();
  const cal = lib.cal;
  assert.equal(cal.isSchoolDay('2026-11-07'), false); // 토
  assert.equal(cal.isSchoolDay('2026-12-25'), false); // 성탄절
  assert.equal(cal.isSchoolDay('2027-05-03'), false); // 대체공휴일(노동절)
  assert.equal(cal.addSchoolDays('2026-11-04', 3), '2026-11-09'); // PRD 예시: 수→월
  await admin.setCalendarDay('2026-11-06', { is_school_day: false, reason: '재량휴업일' }, ctx('2026-11-01'));
  assert.equal(cal.addSchoolDays('2026-11-04', 3), '2026-11-10');
  // 공휴일을 교사가 수업일로 지정 → 우선
  await admin.setCalendarDay('2026-12-25', { is_school_day: true, reason: '테스트' }, ctx('2026-11-01'));
  assert.equal(cal.isSchoolDay('2026-12-25'), true);
  await admin.clearCalendarDay('2026-12-25', ctx('2026-11-01'));
  assert.equal(cal.isSchoolDay('2026-12-25'), false); // 지우면 공휴일로 복원
  assert.equal(cal.countSchoolDays('2026-11-09', '2026-11-10'), 1);
  assert.equal(cal.countSchoolDays('2026-11-13', '2026-11-15'), 0); // 금→일
});

test('대출: 수요일 대출 → 월요일 반납 예정, 1인 1권', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b1 = await book('해리'); const b2 = await book('모모');
  const r = await lib.borrow(a.id, b1.copies[0].qr_token, sctx(a, '2026-11-04'));
  assert.equal(r.due_date, '2026-11-09');
  await throwsCode(() => lib.borrow(a.id, b2.copies[0].qr_token, sctx(a, '2026-11-04')), 'LIMIT');
  await throwsCode(() => lib.borrow(a.id, b1.copies[0].qr_token, sctx(a, '2026-11-04')), 'ALREADY_YOURS');
  // 소장본 코드(바코드)로도 인식
  const c = await st('나래');
  const r2 = await lib.borrow(c.id, b2.copies[0].copy_code.toLowerCase(), sctx(c, '2026-11-04'));
  assert.equal(r2.title, '모모');
});

test('반납: 본인 대출만 반납 가능, 연체 계산과 이용 정지', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b = await st('나래'); const bk = await book('해리');
  const tok = bk.copies[0].qr_token;
  await lib.borrow(a.id, tok, sctx(a, '2026-11-04')); // 기한 11/9(월)
  await throwsCode(() => lib.returnBook(b.id, tok, sctx(b, '2026-11-05')), 'NOT_YOURS');
  // 화요일 = 연체 1일
  assert.equal((await lib.studentState(a.id, { today: '2026-11-10' })).loans[0].overdue_days, 1);
  // 금요일(11/13) 반납 → 연체 4일(화수목금), 정지 4수업일: 월~목 (11/16~11/19)
  const r = await lib.returnBook(a.id, tok, sctx(a, '2026-11-13'));
  assert.equal(r.overdue_school_days, 4);
  assert.equal(r.suspension_start, '2026-11-16');
  assert.equal(r.suspension_until, '2026-11-19');
  await throwsCode(() => lib.borrow(a.id, tok, sctx(a, '2026-11-19')), 'SUSPENDED');
  const ok = await lib.borrow(a.id, tok, sctx(a, '2026-11-20'));
  assert.ok(ok.loan_id);
});

test('연체 일수는 수업일에만 증가', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const bk = await book('해리');
  await lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-11')); // 수 → 기한 11/16(월)
  assert.equal((await lib.studentState(a.id, { today: '2026-11-17' })).loans[0].overdue_days, 1);
  assert.equal((await lib.studentState(a.id, { today: '2026-11-21' })).loans[0].overdue_days, 4); // 토요일: 화~금 4일
  assert.equal((await lib.studentState(a.id, { today: '2026-11-22' })).loans[0].overdue_days, 4); // 일요일 증가 없음
});

test('연장: 예약자 없을 때 1회 2수업일, 승인 후 예약 생겨도 유지', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b = await st('나래'); const bk = await book('해리');
  const l = await lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  const e = await lib.extend(a.id, l.loan_id, sctx(a, '2026-11-06'));
  assert.equal(e.due_date, '2026-11-11'); // 11/9(월) + 2수업일 = 11/11(수)
  await throwsCode(() => lib.extend(a.id, l.loan_id, sctx(a, '2026-11-06')), 'EXTENDED');
  await lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-06'));
  assert.equal((await lib.studentState(a.id, { today: '2026-11-06' })).loans[0].due_date, '2026-11-11');
});

test('연장: 예약자가 있으면 불가, 연체 중 불가', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b = await st('나래'); const bk = await book('해리');
  const l = await lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  await lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-05'));
  await throwsCode(() => lib.extend(a.id, l.loan_id, sctx(a, '2026-11-05')), 'HAS_RESERVATION');
  const st2 = await lib.studentState(a.id, { today: '2026-11-05' });
  assert.equal(st2.loans[0].can_extend, false);
  const c = await st('다온'); const bk2 = await book('모모');
  const l2 = await lib.borrow(c.id, bk2.copies[0].qr_token, sctx(c, '2026-11-04'));
  await throwsCode(() => lib.extend(c.id, l2.loan_id, sctx(c, '2026-11-10')), 'LATE');
});

test('예약: 대출 중인 책만, 1인 1권, 중복 불가, 빌리는 중인 책 불가', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b = await st('나래'); const c = await st('다온');
  const bk = await book('해리'); const bk2 = await book('모모'); const bk3 = await book('어린왕자');
  await throwsCode(() => lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-04')), 'AVAILABLE_NOW');
  await lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  await lib.borrow(c.id, bk2.copies[0].qr_token, sctx(c, '2026-11-04'));
  await throwsCode(() => lib.reserve(a.id, bk.book.id, sctx(a, '2026-11-04')), 'BORROWING');
  const r = await lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-04'));
  assert.equal(r.position, 1);
  await throwsCode(() => lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-04')), 'DUPLICATE');
  await throwsCode(() => lib.reserve(b.id, bk2.book.id, sctx(b, '2026-11-04')), 'RES_LIMIT');
  const r2 = await lib.reserve(c.id, bk.book.id, sctx(c, '2026-11-04'));
  assert.equal(r2.position, 2);
  // 예약 취소 후 다른 책 예약 가능
  await lib.cancelReservation(r.reservation_id, sctx(b, '2026-11-04'), { studentId: b.id });
  assert.equal((await lib.studentState(c.id, { today: '2026-11-04' })).reservations[0].position, 1);
  void bk3;
});

test('우선권: 금요일 반납 → 월요일까지, 다른 학생은 대출 불가, 만료 시 다음 예약자 승계', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b = await st('나래'); const c = await st('다온'); const d = await st('라온');
  const bk = await book('해리');
  const tok = bk.copies[0].qr_token;
  await lib.borrow(a.id, tok, sctx(a, '2026-11-04'));
  await lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-04'));
  await lib.reserve(c.id, bk.book.id, sctx(c, '2026-11-05'));
  const ret = await lib.returnBook(a.id, tok, sctx(a, '2026-11-06')); // 금요일 반납
  assert.equal(ret.reserved_by_other, true);
  let sb = (await lib.studentState(b.id, { today: '2026-11-06' })).reservations[0];
  assert.equal(sb.status, 'priority');
  assert.equal(sb.priority_expires_on, '2026-11-09'); // 월요일까지
  await throwsCode(() => lib.borrow(d.id, tok, sctx(d, '2026-11-09')), 'RESERVED_FOR_OTHER');
  await throwsCode(() => lib.borrow(c.id, tok, sctx(c, '2026-11-09')), 'RESERVED_FOR_OTHER');
  // 화요일: b 만료 → c 우선권 (월요일 기준 다음 수업일인 화요일까지)
  await lib.refreshAll({ actor: { type: 'system' }, today: '2026-11-10', now: '2026-11-10T01:00:00Z' });
  const sc2 = (await lib.studentState(c.id, { today: '2026-11-10' })).reservations[0];
  assert.equal(sc2.status, 'priority');
  assert.equal(sc2.priority_expires_on, '2026-11-10');
  assert.equal((await lib.studentState(b.id, { today: '2026-11-10' })).reservations.length, 0);
  const l = await lib.borrow(c.id, tok, sctx(c, '2026-11-10'));
  assert.ok(l.loan_id);
  assert.equal((await lib.studentState(c.id, { today: '2026-11-10' })).reservations.length, 0); // 예약 완료 처리
});

test('우선권: 처리 지연 시에도 만료일 기준으로 연쇄 승계, 대기자 없으면 일반 대출', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b = await st('나래'); const c = await st('다온'); const d = await st('라온');
  const bk = await book('해리'); const tok = bk.copies[0].qr_token;
  await lib.borrow(a.id, tok, sctx(a, '2026-11-02'));
  await lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-02'));
  await lib.reserve(c.id, bk.book.id, sctx(c, '2026-11-02'));
  await lib.returnBook(a.id, tok, sctx(a, '2026-11-04')); // 수 반납 → b: 목(11/5)까지
  // 아무도 접속하지 않다가 다음 주 월요일(11/9)에 d가 대출 시도:
  // b 11/5 만료 → c 11/6(금)까지 → 만료 → 대기자 없음 → d 일반 대출 가능
  const l = await lib.borrow(d.id, tok, sctx(d, '2026-11-09'));
  assert.ok(l.loan_id);
});

test('복수 소장본: 예약은 도서 단위, 반납된 아무 소장본이나 예약자에게 배정', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b = await st('나래'); const c = await st('다온'); const d = await st('라온');
  const bk = await book('해리', 2);
  const [t1, t2] = bk.copies.map(x => x.qr_token);
  await lib.borrow(a.id, t1, sctx(a, '2026-11-04'));
  // 1권 남아 있으니 예약 불가
  await throwsCode(() => lib.reserve(c.id, bk.book.id, sctx(c, '2026-11-04')), 'AVAILABLE_NOW');
  await lib.borrow(b.id, t2, sctx(b, '2026-11-04'));
  await lib.reserve(c.id, bk.book.id, sctx(c, '2026-11-04'));
  await lib.returnBook(b.id, t2, sctx(b, '2026-11-05'));
  await throwsCode(() => lib.borrow(d.id, t2, sctx(d, '2026-11-05')), 'RESERVED_FOR_OTHER');
  await lib.returnBook(a.id, t1, sctx(a, '2026-11-05'));
  // 두 번째 소장본은 대기자가 없으니 일반 대출 가능, c는 어느 소장본이든 빌릴 수 있다
  await lib.borrow(d.id, t2, sctx(d, '2026-11-05'));
  const l = await lib.borrow(c.id, t1, sctx(c, '2026-11-05'));
  assert.ok(l.loan_id);
});

test('이용 정지 중에도 반납·예약 취소·조회 가능, 신규 예약 불가', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b = await st('나래');
  const bk = await book('해리'); const bk2 = await book('모모');
  await lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-02'));
  await lib.borrow(b.id, bk2.copies[0].qr_token, sctx(b, '2026-11-02'));
  const r = await lib.reserve(a.id, bk2.book.id, sctx(a, '2026-11-02'));
  await lib.returnBook(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-09')); // 기한 11/5, 연체 2일
  const s = await lib.studentState(a.id, { today: '2026-11-10' });
  assert.equal(s.suspension_until, '2026-11-11');
  assert.equal(s.can_borrow, false);
  await lib.cancelReservation(r.reservation_id, sctx(a, '2026-11-10'), { studentId: a.id });
  await throwsCode(() => lib.reserve(a.id, bk2.book.id, sctx(a, '2026-11-10')), 'SUSPENDED');
});

test('관리자: 강제 반납(정지 면제), 기한 수정, 학사일정 변경 영향 확인·반영', async () => {
  const { admin, st, book, sctx, ctx } = setup();
  const a = await st('가람'); const bk = await book('해리');
  const l = await lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  await admin.setCalendarDay('2026-11-06', { is_school_day: false, reason: '재량휴업일' }, ctx('2026-11-04'));
  const imp = await lib.calendarImpact();
  assert.equal(imp.loans.length, 1);
  assert.equal(imp.loans[0].recalculated, '2026-11-10');
  assert.equal((await lib.studentState(a.id, { today: '2026-11-05' })).loans[0].due_date, '2026-11-09'); // 자동 소급 안 함
  await lib.applyCalendarImpact(ctx('2026-11-04'), { loanIds: [l.loan_id] });
  assert.equal((await lib.studentState(a.id, { today: '2026-11-05' })).loans[0].due_date, '2026-11-10');
  const r = await lib.adminReturn(l.loan_id, ctx('2026-11-13'), { waive: true, reason: '결석' });
  assert.equal(r.overdue_school_days, 3);
  assert.equal(r.suspension_until, null);
  assert.equal((await lib.studentState(a.id, { today: '2026-11-16' })).suspension_until, null);
});

test('설정 변경은 기존 대출 기한을 소급하지 않음', async () => {
  const { admin, st, book, sctx, ctx } = setup();
  const a = await st('가람'); const b = await st('나래'); const bk = await book('해리'); const bk2 = await book('모모');
  await lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  await admin.updateSettings({ loan_days: 5 }, ctx('2026-11-04'));
  assert.equal((await lib.studentState(a.id, { today: '2026-11-04' })).loans[0].due_date, '2026-11-09');
  const l = await lib.borrow(b.id, bk2.copies[0].qr_token, sctx(b, '2026-11-04'));
  assert.equal(l.due_date, '2026-11-11');
});

test('동시 대출: 같은 소장본은 한 명만 성공 (DB 고유 제약)', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b = await st('나래'); const bk = await book('해리');
  await lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  // 상태 검사를 우회해 직접 넣어도 고유 인덱스가 막는다
  await assert.rejects(() => db.query(
    "INSERT INTO loans(student_id, copy_id, loaned_at, loan_date, original_due_date, final_due_date, status) VALUES ($1, $2, 'x', '2026-11-04', '2026-11-09', '2026-11-09', 'active')",
    [b.id, bk.copies[0].id]));
});

test('감사 로그 기록', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const bk = await book('해리');
  await lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  const actions = (await all(db, 'SELECT action FROM audit_logs')).map(r => r.action);
  assert.ok(actions.includes('loan'));
  assert.ok(actions.includes('admin_create_student'));
  assert.ok(actions.includes('admin_create_book'));
});

test('책 후기: 빌려 본 책만 별점·한줄평 작성, 수정은 덮어쓰기', async () => {
  const { st, book, sctx } = setup();
  const a = await st('가람'); const b = await st('나래'); const bk = await book('해리');
  // 빌린 적 없으면 후기 불가
  await throwsCode(() => lib.rateBook(a.id, bk.book.id, 5, '재밌어요', sctx(a, '2026-11-04')), 'CANNOT_REVIEW');
  let detail = await lib.bookDetail(bk.book.id, a.id);
  assert.equal(detail.can_review, false);
  assert.equal(detail.review_count, 0);
  assert.equal(detail.avg_rating, null);

  await lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  await throwsCode(() => lib.rateBook(a.id, bk.book.id, 0, '', sctx(a, '2026-11-04')), 'BAD_RATING');
  await throwsCode(() => lib.rateBook(a.id, bk.book.id, 6, '', sctx(a, '2026-11-04')), 'BAD_RATING');
  await lib.rateBook(a.id, bk.book.id, 5, '  정말 재밌어요  ', sctx(a, '2026-11-04'));

  detail = await lib.bookDetail(bk.book.id, a.id);
  assert.equal(detail.can_review, true);
  assert.equal(detail.review_count, 1);
  assert.equal(detail.avg_rating, 5);
  assert.equal(detail.my_review.comment, '정말 재밌어요'); // 앞뒤 공백 제거
  assert.equal(detail.reviews[0].student_name, '가람');

  // 같은 학생이 다시 남기면 새 행이 아니라 기존 후기를 수정
  await lib.rateBook(a.id, bk.book.id, 3, '다시 보니 보통이에요', sctx(a, '2026-11-05'));
  detail = await lib.bookDetail(bk.book.id, a.id);
  assert.equal(detail.review_count, 1);
  assert.equal(detail.avg_rating, 3);

  // 다른 학생이 빌리지 않고는 못 씀. 빌리면 평균에 반영된다
  await throwsCode(() => lib.rateBook(b.id, bk.book.id, 4, '', sctx(b, '2026-11-05')), 'CANNOT_REVIEW');
  await lib.returnBook(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-09'));
  await lib.borrow(b.id, bk.copies[0].qr_token, sctx(b, '2026-11-09'));
  await lib.rateBook(b.id, bk.book.id, 4, '', sctx(b, '2026-11-09'));
  detail = await lib.bookDetail(bk.book.id, b.id);
  assert.equal(detail.review_count, 2);
  assert.equal(detail.avg_rating, 3.5);
  assert.equal(detail.my_review.rating, 4);
});
