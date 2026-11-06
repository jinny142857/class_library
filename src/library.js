// 도서관 운영 규칙 엔진. 대출·반납·연장·예약·우선권·연체·이용정지의 최종 판정은 모두 여기서 한다.
// 모든 쓰기 작업은 tx()(BEGIN IMMEDIATE) 안에서 최신 상태를 다시 읽고 판정한다.
import { getSettings, tx, audit } from './db.js';
import { SchoolCalendar } from './calendar.js';
import { nowISO, todayKST } from './clock.js';

export class LibError extends Error {
  constructor(code, message, hint, extra) {
    super(message);
    this.code = code;
    this.hint = hint || null;
    this.extra = extra || null;
  }
}

const ACTIVE_RES = "status IN ('waiting','priority')";

export function makeCtx(actor, opts = {}) {
  return { actor, today: opts.today || todayKST(), now: opts.now || nowISO() };
}

export class Library {
  constructor(db) {
    this.db = db;
    this.cal = new SchoolCalendar(db);
  }

  get settings() { return getSettings(this.db); }

  // ───────────── 조회 헬퍼 ─────────────
  student(id) { return this.db.prepare('SELECT * FROM students WHERE id = ?').get(id); }

  resolveCopy(scanned) {
    const v = String(scanned || '').trim();
    if (!v) return null;
    return this.db.prepare(`SELECT c.*, b.title, b.status AS book_status FROM copies c JOIN books b ON b.id = c.book_id
      WHERE c.qr_token = ? OR UPPER(c.copy_code) = UPPER(?)`).get(v, v) || null;
  }

  availableCount(bookId) {
    return this.db.prepare("SELECT COUNT(*) c FROM copies WHERE book_id = ? AND status = 'available'").get(bookId).c;
  }

  activeReservations(bookId) {
    return this.db.prepare(`SELECT r.*, s.name AS student_name FROM reservations r JOIN students s ON s.id = r.student_id
      WHERE r.book_id = ? AND r.${ACTIVE_RES}
      ORDER BY CASE r.status WHEN 'priority' THEN 0 ELSE 1 END, r.reserved_at, r.id`).all(bookId);
  }

  queuePosition(res) {
    const list = this.activeReservations(res.book_id);
    return list.findIndex(r => r.id === res.id) + 1;
  }

  overdueDays(loan, today) {
    if (loan.status !== 'active') return loan.overdue_school_days;
    return this.cal.countSchoolDays(loan.final_due_date, today);
  }

  // 현재 이용 정지 상태: 반납된 연체 대출에서 생긴 정지 기간 중 가장 늦은 날짜
  suspensionUntil(studentId, today) {
    const r = this.db.prepare(`SELECT MAX(suspension_until) u FROM loans
      WHERE student_id = ? AND suspension_until IS NOT NULL AND suspension_waived = 0 AND suspension_until >= ?`)
      .get(studentId, today);
    return r?.u || null;
  }

  // ───────────── 예약 우선권 자동 처리 ─────────────
  // 1) 우선권 기간이 지난 예약을 만료시키고 2) 대출 가능한 소장본 수만큼 대기자에게 우선권을 준다.
  // 처리 작업이 늦게 실행되어도(예: 며칠간 아무도 접속하지 않음) 만료일 기준으로 차례대로 승계해
  // 언제 실행해도 같은 결과가 나오도록 한다. baseDate: 이번에 새로 생긴 빈 소장본의 기준일(반납일 등).
  refreshBook(bookId, ctx, baseDate) {
    const { today, now } = ctx;
    const pd = this.settings.priority_days;
    const bases = [];
    const expire = (r) => {
      this.db.prepare("UPDATE reservations SET status='expired', closed_at=? WHERE id=?").run(now, r.id);
      audit(this.db, { type: 'system' }, 'reservation_expired', 'reservation', r.id,
        { book_id: bookId, student_id: r.student_id, priority_expires_on: r.priority_expires_on });
      bases.push(r.priority_expires_on);
    };
    for (const r of this.db.prepare("SELECT * FROM reservations WHERE book_id=? AND status='priority' AND priority_expires_on < ?").all(bookId, today)) {
      expire(r);
    }
    const book = this.db.prepare('SELECT status FROM books WHERE id=?').get(bookId);
    if (!book || book.status !== 'active') return;
    for (let guard = 0; guard < 1000; guard++) {
      const available = this.availableCount(bookId);
      const holders = this.db.prepare("SELECT COUNT(*) c FROM reservations WHERE book_id=? AND status='priority'").get(bookId).c;
      if (holders >= available) break;
      const next = this.db.prepare("SELECT * FROM reservations WHERE book_id=? AND status='waiting' ORDER BY reserved_at, id LIMIT 1").get(bookId);
      if (!next) break;
      bases.sort();
      const base = bases.length ? bases.shift() : (baseDate || today);
      const expires = this.cal.addSchoolDays(base, pd);
      this.db.prepare("UPDATE reservations SET status='priority', priority_started_at=?, priority_start_date=?, priority_expires_on=? WHERE id=?")
        .run(now, base, expires, next.id);
      audit(this.db, { type: 'system' }, 'reservation_priority', 'reservation', next.id,
        { book_id: bookId, student_id: next.student_id, base_date: base, priority_expires_on: expires });
      if (expires < today) expire({ ...next, priority_expires_on: expires });
    }
  }

  refreshAll(ctx = makeCtx({ type: 'system' })) {
    return tx(this.db, () => {
      const ids = this.db.prepare(`SELECT DISTINCT book_id FROM reservations WHERE ${ACTIVE_RES}`).all().map(r => r.book_id);
      for (const id of ids) this.refreshBook(id, ctx);
      return ids.length;
    });
  }

  // ───────────── 공통 자격 검사 ─────────────
  assertStudentActive(studentId) {
    const s = this.student(studentId);
    if (!s || s.status !== 'active') throw new LibError('STUDENT_INACTIVE', '사용할 수 없는 계정이에요.', '선생님께 말씀해 주세요.');
    return s;
  }

  // 신규 대출·신규 예약을 막는 상태(연체 중, 이용 정지 중)
  assertNotBlocked(studentId, today) {
    const active = this.db.prepare("SELECT l.*, b.title FROM loans l JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id WHERE l.student_id=? AND l.status='active'").all(studentId);
    const late = active.find(l => this.overdueDays(l, today) > 0);
    if (late) throw new LibError('OVERDUE', `반납일이 지난 책이 있어요: 「${late.title}」`, '먼저 그 책을 반납해 주세요.');
    const until = this.suspensionUntil(studentId, today);
    if (until) throw new LibError('SUSPENDED', `지금은 책을 빌리거나 예약할 수 없어요. (${fmtDate(until)}까지)`,
      '반납이 늦어서 잠시 쉬는 기간이에요. 기간이 끝나면 다시 이용할 수 있어요.', { until });
    return active;
  }

  // ───────────── 대출 ─────────────
  borrow(studentId, scanned, ctx) {
    return tx(this.db, () => {
      const { today, now } = ctx;
      this.assertStudentActive(studentId);
      const copy = this.resolveCopy(scanned);
      if (!copy) throw new LibError('UNKNOWN_BOOK', '등록되지 않은 책이에요.', '책에 붙은 QR코드를 다시 찍어 보거나 선생님께 말씀해 주세요.');
      this.refreshBook(copy.book_id, ctx);
      const active = this.assertNotBlocked(studentId, today);
      const s = this.settings;
      if (copy.status === 'loaned') {
        const l = this.db.prepare("SELECT student_id FROM loans WHERE copy_id=? AND status='active'").get(copy.id);
        if (l && l.student_id === studentId) throw new LibError('ALREADY_YOURS', '이 책은 이미 내가 빌린 책이에요.');
        // 이 소장본은 대출 중이지만 같은 책의 다른 소장본이 책꽂이에 있을 수 있다
        const free = this.availableCount(copy.book_id)
          - this.db.prepare("SELECT COUNT(*) c FROM reservations WHERE book_id=? AND status='priority'").get(copy.book_id).c;
        if (free > 0) throw new LibError('OTHER_COPY', '이 책은 다른 친구가 빌려 간 책이에요.', '책꽂이에 같은 책이 더 있어요. 그 책의 QR코드를 찍어 주세요.');
        throw new LibError('LOANED_BY_OTHER', '다른 친구가 빌려 간 책이에요.', '「도서 예약하기」에서 예약할 수 있어요.', { book_id: copy.book_id });
      }
      if (copy.status !== 'available' || copy.book_status !== 'active') {
        throw new LibError('NOT_AVAILABLE', '지금은 빌릴 수 없는 책이에요.', '선생님께 말씀해 주세요.');
      }
      if (active.length >= s.max_loans) {
        throw new LibError('LIMIT', s.max_loans === 1 ? `이미 「${active[0].title}」을(를) 빌리고 있어요.` : `책은 ${s.max_loans}권까지 빌릴 수 있어요.`,
          '빌린 책을 먼저 반납해 주세요.');
      }
      const holders = this.db.prepare("SELECT * FROM reservations WHERE book_id=? AND status='priority'").all(copy.book_id);
      const mine = this.db.prepare(`SELECT * FROM reservations WHERE book_id=? AND student_id=? AND ${ACTIVE_RES}`).get(copy.book_id, studentId);
      const available = this.availableCount(copy.book_id);
      const iAmHolder = mine && mine.status === 'priority';
      if (!iAmHolder && available - holders.length < 1) {
        throw new LibError('RESERVED_FOR_OTHER', '이 책은 예약한 친구가 먼저 빌릴 차례예요.', '「도서 예약하기」에서 예약하고 기다려 주세요.', { book_id: copy.book_id });
      }
      const due = this.cal.addSchoolDays(today, s.loan_days);
      const info = this.db.prepare(`INSERT INTO loans(student_id, copy_id, loaned_at, loan_date, original_due_date, final_due_date, status, reservation_id, due_school_days)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(studentId, copy.id, now, today, due, due, mine?.id ?? null, s.loan_days);
      const up = this.db.prepare("UPDATE copies SET status='loaned', updated_at=? WHERE id=? AND status='available'").run(now, copy.id);
      if (up.changes !== 1) throw new LibError('CONFLICT', '방금 다른 친구가 이 책을 빌렸어요.', '다시 확인해 주세요.');
      if (mine) this.db.prepare("UPDATE reservations SET status='completed', closed_at=? WHERE id=?").run(now, mine.id);
      const loanId = Number(info.lastInsertRowid);
      audit(this.db, ctx.actor, 'loan', 'loan', loanId, { student_id: studentId, copy_id: copy.id, due, via_reservation: mine?.id ?? null });
      return { loan_id: loanId, title: copy.title, copy_code: copy.copy_code, loan_date: today, due_date: due };
    });
  }

  // ───────────── 반납 ─────────────
  returnBook(studentId, scanned, ctx) {
    return tx(this.db, () => {
      const copy = this.resolveCopy(scanned);
      if (!copy) throw new LibError('UNKNOWN_BOOK', '등록되지 않은 책이에요.', '책에 붙은 QR코드를 다시 찍어 보세요.');
      const loan = this.db.prepare("SELECT * FROM loans WHERE copy_id=? AND status='active'").get(copy.id);
      if (!loan) throw new LibError('NOT_LOANED', '빌려 간 기록이 없는 책이에요.', '책꽂이에 그대로 꽂아 두면 돼요.');
      if (loan.student_id !== studentId) throw new LibError('NOT_YOURS', '내가 빌린 책이 아니에요.', '이 책을 빌린 친구가 직접 반납해야 해요.');
      return this._closeLoan(loan, copy, ctx, { by: 'student' });
    });
  }

  _closeLoan(loan, copy, ctx, { by, waive = false, reason = null, status = 'returned' }) {
    const { today, now } = ctx;
    const s = this.settings;
    const overdue = this.cal.countSchoolDays(loan.final_due_date, today);
    const days = overdue * s.suspension_multiplier;
    const until = days > 0 ? this.cal.addSchoolDays(today, days) : null;
    this.db.prepare(`UPDATE loans SET status=?, returned_at=?, return_date=?, overdue_school_days=?, suspension_until=?, suspension_waived=?
      WHERE id=? AND status='active'`).run(status, now, today, overdue, until, waive ? 1 : 0, loan.id);
    this.db.prepare("UPDATE copies SET status='available', updated_at=? WHERE id=? AND status='loaned'").run(now, copy.id);
    audit(this.db, ctx.actor, by === 'admin' ? 'admin_return' : 'return', 'loan', loan.id,
      { copy_id: copy.id, overdue_school_days: overdue, suspension_until: until, waived: waive, reason });
    this.refreshBook(copy.book_id, ctx, today);
    const reserved = this.db.prepare("SELECT COUNT(*) c FROM reservations WHERE book_id=? AND status='priority'").get(copy.book_id).c > 0;
    return { title: copy.title, overdue_school_days: overdue, suspension_until: waive ? null : until,
      suspension_start: until ? this.cal.nextSchoolDay(today) : null, reserved_by_other: reserved };
  }

  // ───────────── 연장 ─────────────
  extend(studentId, loanId, ctx) {
    return tx(this.db, () => {
      const { today, now } = ctx;
      const loan = this.db.prepare("SELECT l.*, c.book_id FROM loans l JOIN copies c ON c.id=l.copy_id WHERE l.id=?").get(loanId);
      if (!loan || loan.student_id !== studentId || loan.status !== 'active') throw new LibError('NO_LOAN', '연장할 수 있는 대출이 없어요.');
      const block = this._extendBlock(loan, ctx, true);
      if (block) throw block;
      const s = this.settings;
      const newDue = this.cal.addSchoolDays(loan.final_due_date, s.extend_days);
      this.db.prepare('UPDATE loans SET extension_count=extension_count+1, extended_at=?, final_due_date=?, due_school_days=due_school_days+? WHERE id=?')
        .run(now, newDue, s.extend_days, loan.id);
      audit(this.db, ctx.actor, 'extend', 'loan', loan.id, { from: loan.final_due_date, to: newDue });
      return { loan_id: loan.id, old_due_date: loan.final_due_date, due_date: newDue };
    });
  }

  // 연장 불가 사유(없으면 null). refresh=true 면 우선권 상태를 먼저 갱신한다.
  _extendBlock(loan, ctx, refresh) {
    const s = this.settings;
    if (loan.extension_count >= s.max_extensions) return new LibError('EXTENDED', s.max_extensions === 1 ? '이미 한 번 연장한 책이에요.' : `연장은 ${s.max_extensions}번까지만 할 수 있어요.`, '반납일까지 반납해 주세요.');
    if (ctx.today > loan.final_due_date) return new LibError('LATE', '반납일이 지나서 연장할 수 없어요.', '오늘 바로 반납해 주세요.');
    if (refresh) this.refreshBook(loan.book_id, ctx);
    const waiting = this.db.prepare(`SELECT COUNT(*) c FROM reservations WHERE book_id=? AND ${ACTIVE_RES}`).get(loan.book_id).c;
    if (waiting > 0) return new LibError('HAS_RESERVATION', '이 책을 기다리는 친구가 있어서 연장할 수 없어요.', '반납일까지 반납해 주세요.');
    return null;
  }

  // ───────────── 예약 ─────────────
  reserve(studentId, bookId, ctx) {
    return tx(this.db, () => {
      const { today, now } = ctx;
      this.assertStudentActive(studentId);
      const book = this.db.prepare('SELECT * FROM books WHERE id=?').get(bookId);
      if (!book || book.status !== 'active') throw new LibError('NO_BOOK', '찾을 수 없는 책이에요.');
      this.refreshBook(bookId, ctx);
      this.assertNotBlocked(studentId, today);
      const s = this.settings;
      const dup = this.db.prepare(`SELECT id FROM reservations WHERE student_id=? AND book_id=? AND ${ACTIVE_RES}`).get(studentId, bookId);
      if (dup) throw new LibError('DUPLICATE', '이미 예약한 책이에요.', '「나의 도서관」에서 순서를 확인할 수 있어요.');
      const mine = this.db.prepare(`SELECT COUNT(*) c FROM reservations WHERE student_id=? AND ${ACTIVE_RES}`).get(studentId).c;
      if (mine >= s.max_reservations) throw new LibError('RES_LIMIT', s.max_reservations === 1 ? '예약은 한 권만 할 수 있어요.' : `예약은 ${s.max_reservations}권까지 할 수 있어요.`, '먼저 예약한 책을 취소하거나 빌린 뒤에 다시 예약해 주세요.');
      const borrowing = this.db.prepare("SELECT l.id FROM loans l JOIN copies c ON c.id=l.copy_id WHERE l.student_id=? AND l.status='active' AND c.book_id=?").get(studentId, bookId);
      if (borrowing) throw new LibError('BORROWING', '지금 내가 빌리고 있는 책이에요.');
      const usable = this.db.prepare("SELECT COUNT(*) c FROM copies WHERE book_id=? AND status IN ('available','loaned','repair')").get(bookId).c;
      if (!usable) throw new LibError('NO_COPY', '지금은 예약할 수 없는 책이에요.', '선생님께 말씀해 주세요.');
      const holders = this.db.prepare("SELECT COUNT(*) c FROM reservations WHERE book_id=? AND status='priority'").get(bookId).c;
      if (this.availableCount(bookId) - holders > 0) throw new LibError('AVAILABLE_NOW', '지금 책꽂이에 있는 책이에요! 바로 빌릴 수 있어요.', '「책 빌리기」에서 책의 QR코드를 찍어 주세요.');
      const info = this.db.prepare("INSERT INTO reservations(student_id, book_id, reserved_at, status) VALUES (?, ?, ?, 'waiting')").run(studentId, bookId, now);
      const id = Number(info.lastInsertRowid);
      audit(this.db, ctx.actor, 'reserve', 'reservation', id, { book_id: bookId, student_id: studentId });
      const res = this.db.prepare('SELECT * FROM reservations WHERE id=?').get(id);
      return { reservation_id: id, title: book.title, position: this.queuePosition(res) };
    });
  }

  cancelReservation(resId, ctx, { studentId = null, reason = null } = {}) {
    return tx(this.db, () => {
      const r = this.db.prepare('SELECT * FROM reservations WHERE id=?').get(resId);
      if (!r || (studentId != null && r.student_id !== studentId)) throw new LibError('NO_RES', '예약을 찾을 수 없어요.');
      if (!['waiting', 'priority'].includes(r.status)) throw new LibError('NO_RES', '이미 끝난 예약이에요.');
      this.db.prepare("UPDATE reservations SET status='cancelled', closed_at=? WHERE id=?").run(ctx.now, r.id);
      audit(this.db, ctx.actor, ctx.actor.type === 'admin' ? 'admin_cancel_reservation' : 'cancel_reservation', 'reservation', r.id,
        { book_id: r.book_id, student_id: r.student_id, prev_status: r.status, reason });
      this.refreshBook(r.book_id, ctx, ctx.today);
      return { ok: true };
    });
  }

  // ───────────── 학생 현황 ─────────────
  studentState(studentId, ctx) {
    const { today } = ctx;
    const s = this.settings;
    const student = this.student(studentId);
    const loans = this.db.prepare(`SELECT l.*, b.id AS book_id, b.title, b.author, b.cover_image, c.copy_code
      FROM loans l JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id
      WHERE l.student_id=? AND l.status='active' ORDER BY l.loaned_at`).all(studentId).map(l => {
      const overdue = this.overdueDays(l, today);
      const block = this._extendBlock(l, ctx, false);
      return {
        id: l.id, book_id: l.book_id, title: l.title, author: l.author, cover_image: l.cover_image, copy_code: l.copy_code,
        loan_date: l.loan_date, original_due_date: l.original_due_date, due_date: l.final_due_date,
        extension_count: l.extension_count, overdue_days: overdue,
        school_days_left: overdue > 0 ? 0 : this.cal.countSchoolDays(today, l.final_due_date),
        can_extend: !block, extend_block: block ? { code: block.code, message: block.message } : null,
      };
    });
    const reservations = this.db.prepare(`SELECT r.*, b.title, b.author, b.cover_image FROM reservations r JOIN books b ON b.id=r.book_id
      WHERE r.student_id=? AND r.${ACTIVE_RES} ORDER BY r.reserved_at`).all(studentId).map(r => ({
      id: r.id, book_id: r.book_id, title: r.title, author: r.author, cover_image: r.cover_image, status: r.status,
      reserved_at: r.reserved_at, position: this.queuePosition(r), priority_expires_on: r.priority_expires_on,
    }));
    const suspension_until = this.suspensionUntil(studentId, today);
    const overdue = loans.some(l => l.overdue_days > 0);
    return {
      student: student && { id: student.id, name: student.name, number: student.number },
      today, loans, reservations, suspension_until, overdue,
      can_borrow: !overdue && !suspension_until && loans.length < s.max_loans,
      can_reserve: !overdue && !suspension_until && reservations.length < s.max_reservations,
      settings: { max_loans: s.max_loans, max_reservations: s.max_reservations, loan_days: s.loan_days, extend_days: s.extend_days },
    };
  }

  history(studentId, limit = 100) {
    return this.db.prepare(`SELECT l.id, l.loan_date, l.final_due_date AS due_date, l.return_date, l.overdue_school_days, l.status, l.extension_count,
        b.id AS book_id, b.title, b.author, c.copy_code
      FROM loans l JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id
      WHERE l.student_id=? ORDER BY l.loaned_at DESC LIMIT ?`).all(studentId, limit);
  }

  // ───────────── 책 후기(별점·한줄평) ─────────────
  reviewSummary(bookId) {
    const row = this.db.prepare('SELECT COUNT(*) c, AVG(rating) a FROM reviews WHERE book_id=?').get(bookId);
    return { review_count: row.c, avg_rating: row.c ? Math.round(row.a * 10) / 10 : null };
  }

  canReview(studentId, bookId) {
    return !!this.db.prepare('SELECT 1 FROM loans l JOIN copies c ON c.id=l.copy_id WHERE l.student_id=? AND c.book_id=? LIMIT 1')
      .get(studentId, bookId);
  }

  bookDetail(bookId, studentId) {
    const book = this.db.prepare('SELECT id, title, author, publisher, category, cover_image FROM books WHERE id=? AND status=\'active\'').get(bookId);
    if (!book) throw new LibError('UNKNOWN_BOOK', '등록되지 않은 책이에요.');
    const available = this.availableCount(bookId);
    const held = this.db.prepare("SELECT COUNT(*) c FROM reservations WHERE book_id=? AND status='priority'").get(bookId).c;
    const reviews = this.db.prepare(`SELECT r.rating, r.comment, r.created_at, s.name AS student_name
      FROM reviews r JOIN students s ON s.id=r.student_id WHERE r.book_id=? ORDER BY r.created_at DESC LIMIT 50`).all(bookId);
    const my_review = studentId
      ? this.db.prepare('SELECT rating, comment FROM reviews WHERE book_id=? AND student_id=?').get(bookId, studentId) || null
      : null;
    return {
      ...book, on_shelf: available - held > 0,
      ...this.reviewSummary(bookId), reviews,
      can_review: studentId ? this.canReview(studentId, bookId) : false, my_review,
    };
  }

  rateBook(studentId, bookId, rating, comment, ctx) {
    rating = Number(rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new LibError('BAD_RATING', '별점은 1~5점으로 매겨 주세요.');
    comment = String(comment || '').trim().slice(0, 300);
    const book = this.db.prepare('SELECT id FROM books WHERE id=? AND status=\'active\'').get(bookId);
    if (!book) throw new LibError('UNKNOWN_BOOK', '등록되지 않은 책이에요.');
    if (!this.canReview(studentId, bookId)) throw new LibError('CANNOT_REVIEW', '빌려서 읽어 본 책에만 후기를 남길 수 있어요.');
    return tx(this.db, () => {
      const now = ctx?.now || nowISO();
      const existing = this.db.prepare('SELECT id FROM reviews WHERE book_id=? AND student_id=?').get(bookId, studentId);
      if (existing) {
        this.db.prepare('UPDATE reviews SET rating=?, comment=?, updated_at=? WHERE id=?').run(rating, comment, now, existing.id);
      } else {
        this.db.prepare('INSERT INTO reviews(book_id, student_id, rating, comment, created_at, updated_at) VALUES (?,?,?,?,?,?)')
          .run(bookId, studentId, rating, comment, now, now);
      }
      audit(this.db, ctx?.actor, 'rate_book', 'book', bookId, { rating, has_comment: !!comment });
      return { ok: true, rating, comment, ...this.reviewSummary(bookId) };
    });
  }

  // ───────────── 관리자 조치 ─────────────
  adminBorrow(studentId, copyId, ctx) {
    const copy = this.db.prepare('SELECT qr_token FROM copies WHERE id=?').get(copyId);
    if (!copy) throw new LibError('UNKNOWN_BOOK', '소장본을 찾을 수 없습니다.');
    return this.borrow(studentId, copy.qr_token, ctx);
  }

  adminReturn(loanId, ctx, { waive = false, reason = '' } = {}) {
    return tx(this.db, () => {
      const loan = this.db.prepare("SELECT * FROM loans WHERE id=? AND status='active'").get(loanId);
      if (!loan) throw new LibError('NO_LOAN', '진행 중인 대출이 아닙니다.');
      const copy = this.db.prepare('SELECT c.*, b.title FROM copies c JOIN books b ON b.id=c.book_id WHERE c.id=?').get(loan.copy_id);
      return this._closeLoan(loan, copy, ctx, { by: 'admin', waive, reason, status: 'returned' });
    });
  }

  adminSetDue(loanId, newDue, reason, ctx) {
    return tx(this.db, () => {
      const loan = this.db.prepare("SELECT * FROM loans WHERE id=? AND status='active'").get(loanId);
      if (!loan) throw new LibError('NO_LOAN', '진행 중인 대출이 아닙니다.');
      this.db.prepare('UPDATE loans SET final_due_date=? WHERE id=?').run(newDue, loanId);
      audit(this.db, ctx.actor, 'admin_edit_due', 'loan', loanId, { from: loan.final_due_date, to: newDue, reason });
      return { ok: true };
    });
  }

  adminWaiveSuspension(studentId, reason, ctx) {
    return tx(this.db, () => {
      const r = this.db.prepare('UPDATE loans SET suspension_waived=1 WHERE student_id=? AND suspension_until >= ? AND suspension_waived=0').run(studentId, ctx.today);
      audit(this.db, ctx.actor, 'admin_waive_suspension', 'student', studentId, { reason, loans: r.changes });
      return { ok: true, changed: r.changes };
    });
  }

  // 학사일정 변경 영향: 저장된 반납 예정일/우선권 만료일과 현재 일정으로 다시 계산한 값이 다른 건
  calendarImpact() {
    const loans = this.db.prepare(`SELECT l.id, l.loan_date, l.final_due_date, l.due_school_days, s.name, b.title
      FROM loans l JOIN students s ON s.id=l.student_id JOIN copies c ON c.id=l.copy_id JOIN books b ON b.id=c.book_id
      WHERE l.status='active'`).all()
      .map(l => ({ ...l, recalculated: this.cal.addSchoolDays(l.loan_date, l.due_school_days) }))
      .filter(l => l.recalculated !== l.final_due_date);
    const pd = this.settings.priority_days;
    const res = this.db.prepare(`SELECT r.id, r.priority_start_date, r.priority_expires_on, s.name, b.title
      FROM reservations r JOIN students s ON s.id=r.student_id JOIN books b ON b.id=r.book_id WHERE r.status='priority'`).all()
      .map(r => ({ ...r, recalculated: this.cal.addSchoolDays(r.priority_start_date, pd) }))
      .filter(r => r.recalculated !== r.priority_expires_on);
    return { loans, reservations: res };
  }

  applyCalendarImpact(ctx, { loanIds = [], reservationIds = [] }) {
    return tx(this.db, () => {
      const impact = this.calendarImpact();
      let n = 0;
      for (const l of impact.loans.filter(l => loanIds.includes(l.id))) {
        this.db.prepare('UPDATE loans SET final_due_date=? WHERE id=?').run(l.recalculated, l.id);
        audit(this.db, ctx.actor, 'admin_recalc_due', 'loan', l.id, { from: l.final_due_date, to: l.recalculated, reason: '학사일정 변경 반영' });
        n++;
      }
      for (const r of impact.reservations.filter(r => reservationIds.includes(r.id))) {
        this.db.prepare('UPDATE reservations SET priority_expires_on=? WHERE id=?').run(r.recalculated, r.id);
        audit(this.db, ctx.actor, 'admin_recalc_priority', 'reservation', r.id, { from: r.priority_expires_on, to: r.recalculated, reason: '학사일정 변경 반영' });
        n++;
      }
      return { applied: n };
    });
  }
}

export function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  const w = '일월화수목금토'[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${m}월 ${day}일(${w})`;
}
