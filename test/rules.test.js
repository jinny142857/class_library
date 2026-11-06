import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Library, LibError } from '../src/library.js';
import { Admin } from '../src/admin.js';

// 2026-11-04 = 수요일
const T = { type: 'admin', id: 1, name: 'teacher' };

function setup() {
  const db = openDb(':memory:');
  const lib = new Library(db);
  const admin = new Admin(db, lib);
  const ctx = (today, actor = T) => ({ actor, today, now: `${today}T01:00:00.000Z` });
  const st = (name) => admin.createStudent({ name }, ctx('2026-11-01'));
  const book = (title, copies = 1) => admin.createBook({ title, copies }, ctx('2026-11-01'));
  const sctx = (s, today) => ctx(today, { type: 'student', id: s.id });
  return { db, lib, admin, ctx, st, book, sctx };
}

const code = (e) => (e instanceof LibError ? e.code : e.message);
function throwsCode(fn, c) {
  try { fn(); } catch (e) { assert.equal(code(e), c); return e; }
  assert.fail(`expected ${c}`);
}

test('수업일 계산: 주말·공휴일·교사 휴업일 제외, 교사 지정 우선', () => {
  const { lib, admin, ctx } = setup();
  const cal = lib.cal;
  assert.equal(cal.isSchoolDay('2026-11-07'), false); // 토
  assert.equal(cal.isSchoolDay('2026-12-25'), false); // 성탄절
  assert.equal(cal.isSchoolDay('2027-05-03'), false); // 대체공휴일(노동절)
  assert.equal(cal.addSchoolDays('2026-11-04', 3), '2026-11-09'); // PRD 예시: 수→월
  admin.setCalendarDay('2026-11-06', { is_school_day: false, reason: '재량휴업일' }, ctx('2026-11-01'));
  assert.equal(cal.addSchoolDays('2026-11-04', 3), '2026-11-10');
  // 공휴일을 교사가 수업일로 지정 → 우선
  admin.setCalendarDay('2026-12-25', { is_school_day: true, reason: '테스트' }, ctx('2026-11-01'));
  assert.equal(cal.isSchoolDay('2026-12-25'), true);
  admin.clearCalendarDay('2026-12-25', ctx('2026-11-01'));
  assert.equal(cal.isSchoolDay('2026-12-25'), false); // 지우면 공휴일로 복원
  assert.equal(cal.countSchoolDays('2026-11-09', '2026-11-10'), 1);
  assert.equal(cal.countSchoolDays('2026-11-13', '2026-11-15'), 0); // 금→일
});

test('대출: 수요일 대출 → 월요일 반납 예정, 1인 1권', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const b1 = book('해리'); const b2 = book('모모');
  const r = lib.borrow(a.id, b1.copies[0].qr_token, sctx(a, '2026-11-04'));
  assert.equal(r.due_date, '2026-11-09');
  throwsCode(() => lib.borrow(a.id, b2.copies[0].qr_token, sctx(a, '2026-11-04')), 'LIMIT');
  throwsCode(() => lib.borrow(a.id, b1.copies[0].qr_token, sctx(a, '2026-11-04')), 'ALREADY_YOURS');
  // 소장본 코드(바코드)로도 인식
  const c = st('나래');
  const r2 = lib.borrow(c.id, b2.copies[0].copy_code.toLowerCase(), sctx(c, '2026-11-04'));
  assert.equal(r2.title, '모모');
});

test('반납: 본인 대출만 반납 가능, 연체 계산과 이용 정지', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const b = st('나래'); const bk = book('해리');
  const tok = bk.copies[0].qr_token;
  lib.borrow(a.id, tok, sctx(a, '2026-11-04')); // 기한 11/9(월)
  throwsCode(() => lib.returnBook(b.id, tok, sctx(b, '2026-11-05')), 'NOT_YOURS');
  // 화요일 = 연체 1일
  assert.equal(lib.studentState(a.id, { today: '2026-11-10' }).loans[0].overdue_days, 1);
  // 금요일(11/13) 반납 → 연체 4일(화수목금), 정지 4수업일: 월~목 (11/16~11/19)
  const r = lib.returnBook(a.id, tok, sctx(a, '2026-11-13'));
  assert.equal(r.overdue_school_days, 4);
  assert.equal(r.suspension_start, '2026-11-16');
  assert.equal(r.suspension_until, '2026-11-19');
  throwsCode(() => lib.borrow(a.id, tok, sctx(a, '2026-11-19')), 'SUSPENDED');
  const ok = lib.borrow(a.id, tok, sctx(a, '2026-11-20'));
  assert.ok(ok.loan_id);
});

test('연체 일수는 수업일에만 증가', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const bk = book('해리');
  lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-11')); // 수 → 기한 11/16(월)
  assert.equal(lib.studentState(a.id, { today: '2026-11-17' }).loans[0].overdue_days, 1);
  assert.equal(lib.studentState(a.id, { today: '2026-11-21' }).loans[0].overdue_days, 4); // 토요일: 화~금 4일
  assert.equal(lib.studentState(a.id, { today: '2026-11-22' }).loans[0].overdue_days, 4); // 일요일 증가 없음
});

test('연장: 예약자 없을 때 1회 2수업일, 승인 후 예약 생겨도 유지', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const b = st('나래'); const bk = book('해리');
  const l = lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  const e = lib.extend(a.id, l.loan_id, sctx(a, '2026-11-06'));
  assert.equal(e.due_date, '2026-11-11'); // 11/9(월) + 2수업일 = 11/11(수)
  throwsCode(() => lib.extend(a.id, l.loan_id, sctx(a, '2026-11-06')), 'EXTENDED');
  lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-06'));
  assert.equal(lib.studentState(a.id, { today: '2026-11-06' }).loans[0].due_date, '2026-11-11');
});

test('연장: 예약자가 있으면 불가, 연체 중 불가', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const b = st('나래'); const bk = book('해리');
  const l = lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-05'));
  throwsCode(() => lib.extend(a.id, l.loan_id, sctx(a, '2026-11-05')), 'HAS_RESERVATION');
  const st2 = lib.studentState(a.id, { today: '2026-11-05' });
  assert.equal(st2.loans[0].can_extend, false);
  const c = st('다온'); const bk2 = book('모모');
  const l2 = lib.borrow(c.id, bk2.copies[0].qr_token, sctx(c, '2026-11-04'));
  throwsCode(() => lib.extend(c.id, l2.loan_id, sctx(c, '2026-11-10')), 'LATE');
});

test('예약: 대출 중인 책만, 1인 1권, 중복 불가, 빌리는 중인 책 불가', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const b = st('나래'); const c = st('다온');
  const bk = book('해리'); const bk2 = book('모모'); const bk3 = book('어린왕자');
  throwsCode(() => lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-04')), 'AVAILABLE_NOW');
  lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  lib.borrow(c.id, bk2.copies[0].qr_token, sctx(c, '2026-11-04'));
  throwsCode(() => lib.reserve(a.id, bk.book.id, sctx(a, '2026-11-04')), 'BORROWING');
  const r = lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-04'));
  assert.equal(r.position, 1);
  throwsCode(() => lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-04')), 'DUPLICATE');
  throwsCode(() => lib.reserve(b.id, bk2.book.id, sctx(b, '2026-11-04')), 'RES_LIMIT');
  const r2 = lib.reserve(c.id, bk.book.id, sctx(c, '2026-11-04'));
  assert.equal(r2.position, 2);
  // 예약 취소 후 다른 책 예약 가능
  lib.cancelReservation(r.reservation_id, sctx(b, '2026-11-04'), { studentId: b.id });
  assert.equal(lib.studentState(c.id, { today: '2026-11-04' }).reservations[0].position, 1);
  void bk3;
});

test('우선권: 금요일 반납 → 월요일까지, 다른 학생은 대출 불가, 만료 시 다음 예약자 승계', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const b = st('나래'); const c = st('다온'); const d = st('라온');
  const bk = book('해리');
  const tok = bk.copies[0].qr_token;
  lib.borrow(a.id, tok, sctx(a, '2026-11-04'));
  lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-04'));
  lib.reserve(c.id, bk.book.id, sctx(c, '2026-11-05'));
  const ret = lib.returnBook(a.id, tok, sctx(a, '2026-11-06')); // 금요일 반납
  assert.equal(ret.reserved_by_other, true);
  let sb = lib.studentState(b.id, { today: '2026-11-06' }).reservations[0];
  assert.equal(sb.status, 'priority');
  assert.equal(sb.priority_expires_on, '2026-11-09'); // 월요일까지
  throwsCode(() => lib.borrow(d.id, tok, sctx(d, '2026-11-09')), 'RESERVED_FOR_OTHER');
  throwsCode(() => lib.borrow(c.id, tok, sctx(c, '2026-11-09')), 'RESERVED_FOR_OTHER');
  // 화요일: b 만료 → c 우선권 (월요일 기준 다음 수업일인 화요일까지)
  const sc = lib.studentState(c.id, { today: '2026-11-10' });
  lib.refreshAll({ actor: { type: 'system' }, today: '2026-11-10', now: '2026-11-10T01:00:00Z' });
  const sc2 = lib.studentState(c.id, { today: '2026-11-10' }).reservations[0];
  assert.equal(sc2.status, 'priority');
  assert.equal(sc2.priority_expires_on, '2026-11-10');
  assert.equal(lib.studentState(b.id, { today: '2026-11-10' }).reservations.length, 0);
  const l = lib.borrow(c.id, tok, sctx(c, '2026-11-10'));
  assert.ok(l.loan_id);
  assert.equal(lib.studentState(c.id, { today: '2026-11-10' }).reservations.length, 0); // 예약 완료 처리
  void sc;
});

test('우선권: 처리 지연 시에도 만료일 기준으로 연쇄 승계, 대기자 없으면 일반 대출', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const b = st('나래'); const c = st('다온'); const d = st('라온');
  const bk = book('해리'); const tok = bk.copies[0].qr_token;
  lib.borrow(a.id, tok, sctx(a, '2026-11-02'));
  lib.reserve(b.id, bk.book.id, sctx(b, '2026-11-02'));
  lib.reserve(c.id, bk.book.id, sctx(c, '2026-11-02'));
  lib.returnBook(a.id, tok, sctx(a, '2026-11-04')); // 수 반납 → b: 목(11/5)까지
  // 아무도 접속하지 않다가 다음 주 월요일(11/9)에 d가 대출 시도:
  // b 11/5 만료 → c 11/6(금)까지 → 만료 → 대기자 없음 → d 일반 대출 가능
  const l = lib.borrow(d.id, tok, sctx(d, '2026-11-09'));
  assert.ok(l.loan_id);
});

test('복수 소장본: 예약은 도서 단위, 반납된 아무 소장본이나 예약자에게 배정', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const b = st('나래'); const c = st('다온'); const d = st('라온');
  const bk = book('해리', 2);
  const [t1, t2] = bk.copies.map(x => x.qr_token);
  lib.borrow(a.id, t1, sctx(a, '2026-11-04'));
  // 1권 남아 있으니 예약 불가
  throwsCode(() => lib.reserve(c.id, bk.book.id, sctx(c, '2026-11-04')), 'AVAILABLE_NOW');
  lib.borrow(b.id, t2, sctx(b, '2026-11-04'));
  lib.reserve(c.id, bk.book.id, sctx(c, '2026-11-04'));
  lib.returnBook(b.id, t2, sctx(b, '2026-11-05'));
  throwsCode(() => lib.borrow(d.id, t2, sctx(d, '2026-11-05')), 'RESERVED_FOR_OTHER');
  lib.returnBook(a.id, t1, sctx(a, '2026-11-05'));
  // 두 번째 소장본은 대기자가 없으니 일반 대출 가능, c는 어느 소장본이든 빌릴 수 있다
  lib.borrow(d.id, t2, sctx(d, '2026-11-05'));
  const l = lib.borrow(c.id, t1, sctx(c, '2026-11-05'));
  assert.ok(l.loan_id);
});

test('이용 정지 중에도 반납·예약 취소·조회 가능, 신규 예약 불가', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const b = st('나래');
  const bk = book('해리'); const bk2 = book('모모');
  lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-02'));
  lib.borrow(b.id, bk2.copies[0].qr_token, sctx(b, '2026-11-02'));
  const r = lib.reserve(a.id, bk2.book.id, sctx(a, '2026-11-02'));
  lib.returnBook(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-09')); // 기한 11/5, 연체 2일
  const s = lib.studentState(a.id, { today: '2026-11-10' });
  assert.equal(s.suspension_until, '2026-11-11');
  assert.equal(s.can_borrow, false);
  lib.cancelReservation(r.reservation_id, sctx(a, '2026-11-10'), { studentId: a.id });
  throwsCode(() => lib.reserve(a.id, bk2.book.id, sctx(a, '2026-11-10')), 'SUSPENDED');
});

test('관리자: 강제 반납(정지 면제), 기한 수정, 학사일정 변경 영향 확인·반영', () => {
  const { lib, admin, st, book, sctx, ctx } = setup();
  const a = st('가람'); const bk = book('해리');
  const l = lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  admin.setCalendarDay('2026-11-06', { is_school_day: false, reason: '재량휴업일' }, ctx('2026-11-04'));
  const imp = lib.calendarImpact();
  assert.equal(imp.loans.length, 1);
  assert.equal(imp.loans[0].recalculated, '2026-11-10');
  assert.equal(lib.studentState(a.id, { today: '2026-11-05' }).loans[0].due_date, '2026-11-09'); // 자동 소급 안 함
  lib.applyCalendarImpact(ctx('2026-11-04'), { loanIds: [l.loan_id] });
  assert.equal(lib.studentState(a.id, { today: '2026-11-05' }).loans[0].due_date, '2026-11-10');
  const r = lib.adminReturn(l.loan_id, ctx('2026-11-13'), { waive: true, reason: '결석' });
  assert.equal(r.overdue_school_days, 3);
  assert.equal(r.suspension_until, null);
  assert.equal(lib.studentState(a.id, { today: '2026-11-16' }).suspension_until, null);
});

test('설정 변경은 기존 대출 기한을 소급하지 않음', () => {
  const { lib, admin, st, book, sctx, ctx } = setup();
  const a = st('가람'); const b = st('나래'); const bk = book('해리'); const bk2 = book('모모');
  lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  admin.updateSettings({ loan_days: 5 }, ctx('2026-11-04'));
  assert.equal(lib.studentState(a.id, { today: '2026-11-04' }).loans[0].due_date, '2026-11-09');
  const l = lib.borrow(b.id, bk2.copies[0].qr_token, sctx(b, '2026-11-04'));
  assert.equal(l.due_date, '2026-11-11');
});

test('동시 대출: 같은 소장본은 한 명만 성공 (DB 고유 제약)', () => {
  const { db, lib, st, book, sctx } = setup();
  const a = st('가람'); const b = st('나래'); const bk = book('해리');
  lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  // 상태 검사를 우회해 직접 넣어도 고유 인덱스가 막는다
  assert.throws(() => db.prepare("INSERT INTO loans(student_id, copy_id, loaned_at, loan_date, original_due_date, final_due_date, status) VALUES (?, ?, 'x', '2026-11-04', '2026-11-09', '2026-11-09', 'active')").run(b.id, bk.copies[0].id));
});

test('감사 로그 기록', () => {
  const { db, lib, st, book, sctx } = setup();
  const a = st('가람'); const bk = book('해리');
  lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  const actions = db.prepare('SELECT action FROM audit_logs').all().map(r => r.action);
  assert.ok(actions.includes('loan'));
  assert.ok(actions.includes('admin_create_student'));
  assert.ok(actions.includes('admin_create_book'));
});

test('책 후기: 빌려 본 책만 별점·한줄평 작성, 수정은 덮어쓰기', () => {
  const { lib, st, book, sctx } = setup();
  const a = st('가람'); const b = st('나래'); const bk = book('해리');
  // 빌린 적 없으면 후기 불가
  throwsCode(() => lib.rateBook(a.id, bk.book.id, 5, '재밌어요', sctx(a, '2026-11-04')), 'CANNOT_REVIEW');
  let detail = lib.bookDetail(bk.book.id, a.id);
  assert.equal(detail.can_review, false);
  assert.equal(detail.review_count, 0);
  assert.equal(detail.avg_rating, null);

  lib.borrow(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-04'));
  throwsCode(() => lib.rateBook(a.id, bk.book.id, 0, '', sctx(a, '2026-11-04')), 'BAD_RATING');
  throwsCode(() => lib.rateBook(a.id, bk.book.id, 6, '', sctx(a, '2026-11-04')), 'BAD_RATING');
  lib.rateBook(a.id, bk.book.id, 5, '  정말 재밌어요  ', sctx(a, '2026-11-04'));

  detail = lib.bookDetail(bk.book.id, a.id);
  assert.equal(detail.can_review, true);
  assert.equal(detail.review_count, 1);
  assert.equal(detail.avg_rating, 5);
  assert.equal(detail.my_review.comment, '정말 재밌어요'); // 앞뒤 공백 제거
  assert.equal(detail.reviews[0].student_name, '가람');

  // 같은 학생이 다시 남기면 새 행이 아니라 기존 후기를 수정
  lib.rateBook(a.id, bk.book.id, 3, '다시 보니 보통이에요', sctx(a, '2026-11-05'));
  detail = lib.bookDetail(bk.book.id, a.id);
  assert.equal(detail.review_count, 1);
  assert.equal(detail.avg_rating, 3);

  // 다른 학생이 빌리지 않고는 못 씀. 빌리면 평균에 반영된다
  throwsCode(() => lib.rateBook(b.id, bk.book.id, 4, '', sctx(b, '2026-11-05')), 'CANNOT_REVIEW');
  lib.returnBook(a.id, bk.copies[0].qr_token, sctx(a, '2026-11-09'));
  lib.borrow(b.id, bk.copies[0].qr_token, sctx(b, '2026-11-09'));
  lib.rateBook(b.id, bk.book.id, 4, '', sctx(b, '2026-11-09'));
  detail = lib.bookDetail(bk.book.id, b.id);
  assert.equal(detail.review_count, 2);
  assert.equal(detail.avg_rating, 3.5);
  assert.equal(detail.my_review.rating, 4);
});
