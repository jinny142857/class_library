// 교사용 관리자 화면 (해시 라우팅 SPA)
import { api, esc, fmtDate, fmtShort, fmtDateTime, ApiError } from './common.js';
import { Scanner, listenKeyboardScanner } from './scanner.js';
import { qrSvg } from './qr.js';

const root = document.getElementById('root');
let me = null;
let main = null;
let today = '';

// ───────────── 공통 UI ─────────────
function toast(msg, err = false) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 3500);
}
function fail(e) {
  if (e instanceof ApiError && e.status === 401) { showLogin(); return; }
  toast(e.hint ? `${e.message} ${e.hint}` : e.message, true);
}

// 대화상자: buttons = [{label, value, primary, danger}], onOpen(dlg)
function dialog(title, body, buttons = [{ label: '닫기', value: null }], onOpen) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<div class="dh"><h3>${esc(title)}</h3><button class="x" value="" aria-label="닫기">×</button></div>
      <form method="dialog"><div class="db">${body}</div><div class="df">${buttons.map((b, i) =>
        `<button class="btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}" data-i="${i}" ${b.value === null ? 'formnovalidate' : ''}>${esc(b.label)}</button>`).join('')}</div></form>`;
    document.body.appendChild(d);
    let result = null;
    d.querySelector('.x').addEventListener('click', () => d.close());
    d.querySelectorAll('.df button').forEach(btn => btn.addEventListener('click', (e) => {
      const b = buttons[Number(btn.dataset.i)];
      const form = d.querySelector('form');
      if (b.value !== null && b.validate !== false && !form.reportValidity()) { e.preventDefault(); return; }
      result = b.value === null ? null : { value: b.value, data: Object.fromEntries(new FormData(form)), form };
    }));
    d.addEventListener('close', () => { d.remove(); d._cleanup?.(); resolve(result); });
    d.showModal();
    onOpen?.(d);
  });
}

async function confirmReason(title, text, { needReason = true, extra = '' } = {}) {
  const r = await dialog(title, `<p style="margin-top:0">${text}</p>${extra}
    ${needReason ? '<label class="f">변경 사유 (기록에 남아요)<input type="text" name="reason" required maxlength="300" placeholder="예: 결석으로 반납이 늦음"></label>' : ''}`,
    [{ label: '취소', value: null }, { label: '확인', value: 'ok', primary: true }]);
  return r?.data || null;
}

// 카메라/USB 스캐너로 코드 하나 읽기
function scanDialog(title, hint) {
  return new Promise((resolve) => {
    let scanner;
    let done = false;
    dialog(title, `<div class="scanbox"><div class="inner" style="width:100%;height:100%"></div></div>
      <p class="muted" style="margin:0 0 8px;text-align:center">${esc(hint || 'QR코드나 바코드를 카메라에 보여 주세요.')}</p>
      <label class="f">또는 직접 입력 / USB 스캐너<input type="text" name="code" autocomplete="off"></label>`,
      [{ label: '취소', value: null }, { label: '확인', value: 'ok', primary: true }],
      async (d) => {
        const input = d.querySelector('input[name=code]');
        input.focus();
        scanner = new Scanner(d.querySelector('.inner'), (code) => { if (done) return; done = true; input.value = code; d.querySelector('.df .primary').click(); });
        d._cleanup = () => scanner.stop();
        try { await scanner.start(); } catch (e) { d.querySelector('.inner').innerHTML = `<div class="cam-msg">${esc(e.message)}</div>`; }
      }).then(r => resolve(r?.data?.code?.trim() || null));
  });
}

const STATUS = {
  copy: { available: ['대출 가능', 'b-ok'], loaned: ['대출 중', 'b-loan'], lost: ['분실', 'b-late'], repair: ['수리 중', 'b-wait'], discarded: ['폐기', 'b-off'] },
  loan: { active: ['대출 중', 'b-loan'], returned: ['반납 완료', 'b-ok'], admin_closed: ['관리자 종료', 'b-off'] },
  res: { waiting: ['대기', 'b-wait'], priority: ['우선권', 'b-pri'], completed: ['대출 완료', 'b-ok'], cancelled: ['취소', 'b-off'], expired: ['만료', 'b-late'] },
};
const badge = (kind, s) => { const [t, c] = STATUS[kind][s] || [s, 'b-off']; return `<span class="badge ${c}">${t}</span>`; };

const ACTIONS = {
  loan: '대출', return: '반납', extend: '연장', reserve: '예약', cancel_reservation: '예약 취소(학생)',
  reservation_priority: '우선권 부여', reservation_expired: '우선권 만료', student_login: '학생 로그인',
  admin_return: '관리자 반납', admin_edit_due: '반납 예정일 수정', admin_waive_suspension: '이용 정지 해제',
  admin_cancel_reservation: '예약 취소(관리자)', admin_create_student: '학생 등록', admin_update_student: '학생 정보 수정',
  admin_reissue_student_qr: '학생 QR 재발급', admin_create_book: '도서 등록', admin_update_book: '도서 수정',
  admin_delete_book: '도서 삭제', admin_deactivate_book: '도서 비활성', admin_add_copy: '소장본 추가',
  admin_update_copy: '소장본 수정', admin_delete_copy: '소장본 삭제', admin_reissue_copy_qr: '소장본 QR 재발급',
  admin_calendar_set: '학사일정 지정', admin_calendar_clear: '학사일정 지정 해제', admin_holiday_set: '공휴일 추가',
  admin_holiday_delete: '공휴일 삭제', admin_holiday_sync: '공휴일 동기화', admin_recalc_due: '반납일 재계산 반영',
  admin_recalc_priority: '우선권 재계산 반영', admin_settings: '운영 설정 변경', admin_login: '관리자 로그인',
  admin_backup_download: '백업 다운로드', admin_restore_uploaded: '복원 파일 업로드', admin_account_created: '관리자 계정 생성',
  admin_create_admin: '관리자 추가', admin_change_password: '비밀번호 변경',
};
const SETTING_LABELS = {
  loan_days: ['기본 대출 기간', '수업일'], extend_days: ['연장 기간', '수업일'], max_loans: ['1인당 최대 대출', '권'],
  max_extensions: ['대출 1건당 연장 횟수', '회'], max_reservations: ['학생별 최대 활성 예약', '권'],
  priority_days: ['예약 우선권 기간', '수업일'], suspension_multiplier: ['이용 정지 = 연체 수업일 ×', '배 (0이면 정지 없음)'],
  student_idle_seconds: ['학생 자동 로그아웃', '초 동안 사용하지 않으면'],
};

// ───────────── 레이아웃 ─────────────
const NAV = [
  ['dashboard', '대시보드'], ['loans', '대출·반납'], ['reservations', '예약 대기열'],
  null, ['books', '도서'], ['students', '학생'], ['calendar', '학사일정'],
  null, ['stats', '통계'], ['audit', '변경 이력'], ['settings', '설정·백업'],
];
let overdueCount = 0;

function shell(active) {
  if (!root.querySelector('.layout')) {
    root.innerHTML = `<div class="layout"><aside class="side">
      <div class="logo"><svg viewBox="0 0 40 40" aria-hidden="true"><rect x="4" y="8" width="8" height="26" rx="1.5" fill="#f5b942"/><rect x="13" y="5" width="8" height="29" rx="1.5" fill="#8bab5c"/><rect x="22" y="10" width="8" height="24" rx="1.5" transform="rotate(-12 26 22)" fill="#dd8fa6"/><path d="M2 35h36" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>양배추 책방</div>
      <nav></nav>
      <div class="foot"><span id="me-name"></span><span id="today"></span><a href="/" target="_blank" style="color:#e3cfb0">학생 화면 열기</a><button id="logout">로그아웃</button></div>
    </aside><main class="main" id="main"></main></div>`;
    root.querySelector('#logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout').catch(() => {}); showLogin(); });
  }
  root.querySelector('#me-name').textContent = `${me.name} 선생님`;
  root.querySelector('#today').textContent = `오늘 ${fmtDate(today)}`;
  root.querySelector('nav').innerHTML = NAV.map(n => n ? `<a href="#/${n[0]}" class="${n[0] === active ? 'on' : ''}">${n[1]}${n[0] === 'loans' && overdueCount ? `<span class="count" title="연체">${overdueCount}</span>` : ''}</a>` : '<div class="group"></div>').join('');
  main = root.querySelector('#main');
  return main;
}

function head(title, sub = '', tools = '') {
  return `<div class="head"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="toolbar">${tools}</div></div>`;
}

function cover(url) {
  return url ? `<img class="cover-sm" src="${esc(url)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : '<div class="cover-sm"></div>';
}

function bars(rows, labelKey, valueKey) {
  const max = Math.max(1, ...rows.map(r => r[valueKey]));
  return `<div class="bars">${rows.map(r => `<div class="bar"><span class="lbl" title="${esc(r[labelKey])}">${esc(r[labelKey])}</span><span class="track"><span class="fill" style="display:block;width:${(r[valueKey] / max) * 100}%"></span></span><span class="num">${r[valueKey]}</span></div>`).join('')}</div>`;
}

// ───────────── 페이지 ─────────────
const PAGES = {
  async dashboard() {
    const d = await api('GET', '/api/admin/dashboard');
    overdueCount = d.overdue.length;
    shell('dashboard');
    main.innerHTML = head('대시보드', `${fmtDate(d.today, { year: true })} · ${d.is_school_day ? '수업일' : '수업일 아님'}`,
      '<button class="btn primary" data-act="counter">대신 대출·반납</button>') + `
      <div class="figures">
        <div><b>${d.books_titles}</b><span>도서 (제목)</span></div>
        <div><b>${d.books_copies}</b><span>소장본 (권)</span></div>
        <div><b>${d.copies_available}</b><span>대출 가능</span></div>
        <div><b>${d.copies_loaned}</b><span>대출 중</span></div>
        <div class="${d.overdue.length ? 'alert' : ''}"><b>${d.overdue.length}</b><span>연체</span></div>
        <div><b>${d.students}</b><span>학생</span></div>
      </div>
      <div class="grid2">
        <div class="card"><h2>연체 도서 <a href="#/loans?status=overdue" style="font-size:13px">전체 보기</a></h2>
          ${d.overdue.length ? `<table><tr><th>학생</th><th>도서</th><th>반납 예정</th><th class="num">연체</th></tr>${d.overdue.map(l => `<tr><td><a href="#/students/${l.student_id}">${esc(l.student_name)}</a></td><td>${esc(l.title)}</td><td>${fmtDate(l.final_due_date)}</td><td class="num"><span class="badge b-late">${l.overdue_days}일</span></td></tr>`).join('')}</table>` : '<p class="empty">연체된 책이 없어요.</p>'}
          ${d.suspended_students.length ? `<h2 style="margin-top:18px">이용 정지 중</h2><table>${d.suspended_students.map(s => `<tr><td><a href="#/students/${s.id}">${esc(s.name)}</a></td><td class="num">${fmtDate(s.until)}까지</td></tr>`).join('')}</table>` : ''}
        </div>
        <div class="card"><h2>최근 대출·반납</h2>
          ${d.recent.length ? `<table>${d.recent.map(r => `<tr><td class="muted" style="white-space:nowrap">${fmtDateTime(r.created_at)}</td><td>${esc(ACTIONS[r.action] || r.action)}</td><td>${esc(r.student_name || '')}</td><td>${esc(r.title || '')}</td></tr>`).join('')}</table>` : '<p class="empty">아직 기록이 없어요.</p>'}
        </div>
      </div>
      <div class="card" style="margin-top:18px"><h2>인기 도서 <a href="#/stats" style="font-size:13px">통계 보기</a></h2>
        ${d.popular.length ? bars(d.popular, 'title', 'loans') : '<p class="empty">대출 기록이 쌓이면 여기에 보여요.</p>'}
      </div>
      ${d.books_titles === 0 || d.students === 0 ? `<div class="note warn">처음이신가요? ① <a href="#/students">학생</a>을 등록하고 QR 카드를 인쇄 ② <a href="#/books">도서</a>를 등록하고 QR 라벨을 인쇄해 책에 붙이세요 ③ <a href="#/calendar">학사일정</a>에 학교 재량휴업일을 넣어 두세요.</div>` : ''}`;
    main.querySelector('[data-act="counter"]').addEventListener('click', counterDialog);
  },

  async loans(_, params) {
    const status = params.get('status') || 'active';
    const q = params.get('q') || '';
    const rows = await api('GET', `/api/admin/loans?status=${status}&q=${encodeURIComponent(q)}`);
    if (status === 'overdue') overdueCount = rows.length;
    shell('loans');
    const tabs = [['active', '대출 중'], ['overdue', '연체'], ['returned', '반납 완료'], ['late_returned', '늦게 반납'], ['all', '전체']];
    main.innerHTML = head('대출·반납', '예외 상황은 여기서 직접 처리하세요. 모든 변경은 사유와 함께 기록돼요.',
      `<form data-act="search" class="row-field"><input type="search" name="q" value="${esc(q)}" placeholder="학생·도서·코드 검색"><button class="btn">검색</button></form>
       <button class="btn primary" data-act="counter">대신 대출·반납</button>`) + `
      <div class="tabs">${tabs.map(([k, t]) => `<button data-tab="${k}" class="${k === status ? 'on' : ''}">${t}</button>`).join('')}</div>
      <div class="card scroll">${rows.length ? `<table><tr><th>학생</th><th>도서</th><th>소장본</th><th>대출일</th><th>반납 예정</th><th>반납일</th><th class="num">연체</th><th>상태</th><th></th></tr>
        ${rows.map(l => `<tr>
          <td><a href="#/students/${l.student_id}">${esc(l.student_name)}</a></td>
          <td><a href="#/books/${l.book_id}">${esc(l.title)}</a></td><td class="muted">${esc(l.copy_code)}</td>
          <td>${fmtShort(l.loan_date)}</td><td>${fmtShort(l.final_due_date)}${l.extension_count ? ' <span class="badge b-pri">연장</span>' : ''}</td>
          <td>${l.return_date ? fmtShort(l.return_date) : ''}</td>
          <td class="num">${l.overdue_days ? `<span class="badge b-late">${l.overdue_days}일</span>` : ''}</td>
          <td>${badge('loan', l.status)}${l.suspension_until && !l.suspension_waived ? `<div class="muted" style="font-size:12px">정지 ~${fmtShort(l.suspension_until)}</div>` : ''}${l.suspension_waived ? '<div class="muted" style="font-size:12px">정지 면제</div>' : ''}</td>
          <td style="white-space:nowrap">${l.status === 'active' ? `<button class="btn small" data-ret="${l.id}">반납 처리</button> <button class="btn small" data-due="${l.id}" data-cur="${l.final_due_date}">기한 수정</button>` : ''}</td>
        </tr>`).join('')}</table>` : '<p class="empty">해당하는 기록이 없어요.</p>'}</div>`;
    main.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { location.hash = `#/loans?status=${b.dataset.tab}`; }));
    main.querySelector('form[data-act="search"]').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/loans?status=${status}&q=${encodeURIComponent(e.target.q.value)}`; });
    main.querySelector('[data-act="counter"]').addEventListener('click', counterDialog);
    bindLoanActions(main, () => route());
  },

  async reservations(_, params) {
    const scope = params.get('scope') || 'open';
    const rows = await api('GET', `/api/admin/reservations?scope=${scope}`);
    shell('reservations');
    main.innerHTML = head('예약 대기열', '예약은 도서(제목) 단위예요. 책이 반납되면 첫 예약자에게 다음 수업일까지 우선권이 생기고, 지나면 다음 사람에게 넘어가요.') + `
      <div class="tabs"><button data-s="open" class="${scope !== 'closed' ? 'on' : ''}">진행 중</button><button data-s="closed" class="${scope === 'closed' ? 'on' : ''}">종료된 예약</button><button data-s="events">우선권 승계 내역</button></div>
      <div class="card scroll" id="resbox">${rows.length ? `<table><tr><th>도서</th>${scope !== 'closed' ? '<th class="num">순서</th>' : ''}<th>학생</th><th>상태</th><th>신청</th><th>우선권 기간</th>${scope === 'closed' ? '<th>종료</th>' : '<th></th>'}</tr>
        ${rows.map(r => `<tr><td><a href="#/books/${r.book_id}">${esc(r.title)}</a></td>${scope !== 'closed' ? `<td class="num">${r.position}</td>` : ''}
          <td><a href="#/students/${r.student_id}">${esc(r.student_name)}</a></td><td>${badge('res', r.status)}</td>
          <td>${fmtDateTime(r.reserved_at)}</td><td>${r.priority_expires_on ? `${fmtShort(r.priority_start_date)} 반납 → <b>${fmtDate(r.priority_expires_on)}</b>까지` : ''}</td>
          ${scope === 'closed' ? `<td>${fmtDateTime(r.closed_at)}</td>` : `<td><button class="btn small danger" data-cancel="${r.id}">취소</button></td>`}</tr>`).join('')}</table>` : '<p class="empty">예약이 없어요.</p>'}</div>`;
    main.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.s !== 'events') { location.hash = `#/reservations?scope=${b.dataset.s}`; return; }
      main.querySelectorAll('[data-s]').forEach(x => x.classList.toggle('on', x === b));
      const ev = await api('GET', '/api/admin/reservation-events');
      main.querySelector('#resbox').innerHTML = ev.length ? `<table><tr><th>시각</th><th>내용</th><th>상세</th></tr>${ev.map(e => `<tr><td>${fmtDateTime(e.created_at)}</td><td>${esc(ACTIONS[e.action] || e.action)}</td><td class="muted">${esc(describe(e))}</td></tr>`).join('')}</table>` : '<p class="empty">내역이 없어요.</p>';
    }));
    main.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
      const d = await confirmReason('예약 취소', '이 예약을 취소할까요? 우선권 중이었다면 다음 예약자에게 넘어가요.');
      if (!d) return;
      try { await api('POST', `/api/admin/reservations/${b.dataset.cancel}/cancel`, d); toast('예약을 취소했어요.'); route(); } catch (e) { fail(e); }
    }));
  },

  async books(_, params) {
    const q = params.get('q') || '';
    const inactive = params.get('inactive') === '1';
    const rows = await api('GET', `/api/admin/books?q=${encodeURIComponent(q)}${inactive ? '&inactive=1' : ''}`);
    shell('books');
    main.innerHTML = head('도서', `${rows.length}종`,
      `<form data-act="search" class="row-field"><input type="search" name="q" value="${esc(q)}" placeholder="제목·저자·ISBN·분야"><button class="btn">검색</button></form>
       <label class="checkbox"><input type="checkbox" data-act="inactive" ${inactive ? 'checked' : ''}>비활성 포함</label>
       <button class="btn" data-act="print-sel">선택 QR 인쇄</button>
       <button class="btn primary" data-act="new">도서 등록</button>`) + `
      <div class="card scroll">${rows.length ? `<table><tr><th><input type="checkbox" data-act="all" aria-label="전체 선택"></th><th></th><th>도서</th><th>분야</th><th class="num">소장</th><th class="num">대출 가능</th><th class="num">예약</th><th class="num">누적 대출</th></tr>
        ${rows.map(b => `<tr class="click" data-id="${b.id}"><td><input type="checkbox" class="sel" value="${b.id}" aria-label="선택"></td><td>${cover(b.cover_image)}</td>
          <td><b>${esc(b.title)}</b>${b.status === 'inactive' ? ' <span class="badge b-off">비활성</span>' : ''}<div class="muted">${esc([b.author, b.publisher].filter(Boolean).join(' / '))}</div></td>
          <td>${esc(b.category || '')}</td><td class="num">${b.copies}</td><td class="num">${b.available}</td><td class="num">${b.reservations || ''}</td><td class="num">${b.total_loans}</td></tr>`).join('')}</table>`
        : `<p class="empty">${q ? '검색 결과가 없어요.' : '아직 등록된 도서가 없어요. 「도서 등록」으로 시작하세요.'}</p>`}</div>`;
    main.querySelector('form[data-act="search"]').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/books?q=${encodeURIComponent(e.target.q.value)}${inactive ? '&inactive=1' : ''}`; });
    main.querySelector('[data-act="inactive"]').addEventListener('change', (e) => { location.hash = `#/books?q=${encodeURIComponent(q)}${e.target.checked ? '&inactive=1' : ''}`; });
    main.querySelector('[data-act="new"]').addEventListener('click', () => bookDialog());
    main.querySelector('[data-act="all"]')?.addEventListener('change', (e) => main.querySelectorAll('.sel').forEach(c => { c.checked = e.target.checked; }));
    main.querySelector('[data-act="print-sel"]').addEventListener('click', () => {
      const ids = main.querySelectorAll('.sel:checked');
      const books = [...ids].map(c => c.value).join(',');
      window.open(`/print?type=copies${books ? `&books=${books}` : ''}`, '_blank');
    });
    main.querySelectorAll('tr.click').forEach(tr => tr.addEventListener('click', (e) => { if (e.target.closest('input')) return; location.hash = `#/books/${tr.dataset.id}`; }));
  },

  async book(id) {
    const [d, cats] = await Promise.all([api('GET', `/api/admin/books/${id}`), api('GET', '/api/admin/categories')]);
    const b = d.book;
    shell('books');
    main.innerHTML = head(b.title, `${b.status === 'inactive' ? '비활성 도서 · ' : ''}등록 ${fmtDateTime(b.created_at)}`,
      `<a class="btn" href="#/books">목록</a><button class="btn" data-act="print">QR 라벨 인쇄</button><button class="btn danger" data-act="del">${b.status === 'inactive' ? '다시 활성화' : '삭제'}</button>`) + `
      <div class="card"><h2>도서 정보</h2>
        <form class="form" data-act="edit">
          ${bookFields(b, cats)}
          <div class="wide"><button class="btn primary">저장</button></div>
        </form>
      </div>
      <div class="card"><h2>소장본 ${d.copies.length}권 <span class="toolbar"><input type="number" min="1" max="50" value="1" style="width:70px" data-act="addn" aria-label="추가할 권수"><button class="btn small" data-act="add">소장본 추가</button></span></h2>
        <div class="scroll"><table><tr><th>QR</th><th>소장본 코드</th><th>상태</th><th>대출자</th><th>반납 예정</th><th></th></tr>
        ${d.copies.map(c => `<tr><td><div class="qr-mini">${qrSvg(c.qr_token, { margin: 1 })}</div></td>
          <td><b>${esc(c.copy_code)}</b></td>
          <td>${c.status === 'loaned' ? badge('copy', 'loaned') : `<select data-copy="${c.id}" aria-label="상태">${['available', 'repair', 'lost', 'discarded'].map(s => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${STATUS.copy[s][0]}</option>`).join('')}</select>`}</td>
          <td>${c.borrower ? esc(c.borrower) : ''}</td><td>${c.final_due_date ? fmtDate(c.final_due_date) : ''}</td>
          <td style="white-space:nowrap"><button class="btn small" data-code="${c.id}" data-val="${esc(c.copy_code)}">코드 변경</button> <button class="btn small" data-reissue="${c.id}">QR 재발급</button> <button class="btn small danger" data-delcopy="${c.id}" ${c.status === 'loaned' ? 'disabled' : ''}>삭제</button></td></tr>`).join('')}
        </table></div>
        <p class="note" style="margin-bottom:0">책에 이미 바코드(등록번호) 라벨이 있다면 「코드 변경」에 그 번호를 넣으세요. 그 바코드를 찍어도 이 소장본으로 인식돼요.</p>
      </div>
      <div class="card"><h2>예약 대기열</h2>
        ${d.queue.length ? `<table><tr><th class="num">순서</th><th>학생</th><th>상태</th><th>신청</th><th>우선권</th><th></th></tr>${d.queue.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${esc(r.student_name)}</td><td>${badge('res', r.status)}</td><td>${fmtDateTime(r.reserved_at)}</td><td>${r.priority_expires_on ? `${fmtDate(r.priority_expires_on)}까지` : ''}</td><td><button class="btn small danger" data-cancel="${r.id}">취소</button></td></tr>`).join('')}</table>` : '<p class="empty">예약한 학생이 없어요.</p>'}
      </div>`;
    const reload = () => PAGES.book(id).catch(fail);
    main.querySelector('form[data-act="edit"]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('PUT', `/api/admin/books/${id}`, Object.fromEntries(new FormData(e.target))); toast('저장했어요.'); reload(); } catch (err) { fail(err); }
    });
    bindIsbnLookup(main);
    main.querySelector('[data-act="print"]').addEventListener('click', () => window.open(`/print?type=copies&books=${id}`, '_blank'));
    main.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (b.status === 'inactive') {
        try { await api('PUT', `/api/admin/books/${id}`, { status: 'active' }); toast('다시 활성화했어요.'); reload(); } catch (e) { fail(e); }
        return;
      }
      const ok = await dialog('도서 삭제', '<p>대출·예약 기록이 있는 도서는 기록 보존을 위해 <b>비활성</b> 처리되고, 기록이 없으면 완전히 삭제돼요. 계속할까요?</p>', [{ label: '취소', value: null }, { label: '삭제', value: 'ok', danger: true }]);
      if (!ok) return;
      try { const r = await api('DELETE', `/api/admin/books/${id}`); toast(r.deleted ? '삭제했어요.' : '비활성 처리했어요.'); location.hash = '#/books'; } catch (e) { fail(e); }
    });
    main.querySelector('[data-act="add"]').addEventListener('click', async () => {
      try { await api('POST', `/api/admin/books/${id}/copies`, { count: Number(main.querySelector('[data-act="addn"]').value) }); toast('소장본을 추가했어요.'); reload(); } catch (e) { fail(e); }
    });
    main.querySelectorAll('[data-copy]').forEach(sel => sel.addEventListener('change', async () => {
      try { await api('PUT', `/api/admin/copies/${sel.dataset.copy}`, { status: sel.value }); toast('상태를 바꿨어요.'); reload(); } catch (e) { fail(e); reload(); }
    }));
    main.querySelectorAll('[data-code]').forEach(btn => btn.addEventListener('click', async () => {
      const r = await dialog('소장본 코드 변경', `<label class="f">소장본 코드 (기존 바코드 번호 등)<input type="text" name="copy_code" required maxlength="40" value="${esc(btn.dataset.val)}"></label>
        <p class="note">USB 바코드 스캐너가 있다면 입력칸을 누르고 책의 바코드를 찍으면 돼요.</p>`, [{ label: '취소', value: null }, { label: '저장', value: 'ok', primary: true }]);
      if (!r) return;
      try { await api('PUT', `/api/admin/copies/${btn.dataset.code}`, { copy_code: r.data.copy_code }); toast('코드를 바꿨어요.'); reload(); } catch (e) { fail(e); }
    }));
    main.querySelectorAll('[data-reissue]').forEach(btn => btn.addEventListener('click', async () => {
      const ok = await dialog('QR 재발급', '<p>새 QR을 만들면 지금 책에 붙어 있는 QR 라벨은 더 이상 인식되지 않아요. 새 라벨을 인쇄해 붙여 주세요.</p>', [{ label: '취소', value: null }, { label: '재발급', value: 'ok', primary: true }]);
      if (!ok) return;
      try { await api('POST', `/api/admin/copies/${btn.dataset.reissue}/reissue`); toast('QR을 새로 만들었어요.'); reload(); } catch (e) { fail(e); }
    }));
    main.querySelectorAll('[data-delcopy]').forEach(btn => btn.addEventListener('click', async () => {
      const ok = await dialog('소장본 삭제', '<p>대출 기록이 있는 소장본은 「폐기」 상태로 바뀌고, 기록이 없으면 삭제돼요.</p>', [{ label: '취소', value: null }, { label: '삭제', value: 'ok', danger: true }]);
      if (!ok) return;
      try { await api('DELETE', `/api/admin/copies/${btn.dataset.delcopy}`); toast('처리했어요.'); reload(); } catch (e) { fail(e); }
    }));
    main.querySelectorAll('[data-cancel]').forEach(btn => btn.addEventListener('click', async () => {
      const d2 = await confirmReason('예약 취소', '이 예약을 취소할까요?');
      if (!d2) return;
      try { await api('POST', `/api/admin/reservations/${btn.dataset.cancel}/cancel`, d2); toast('취소했어요.'); reload(); } catch (e) { fail(e); }
    }));
  },

  async students() {
    const rows = await api('GET', '/api/admin/students');
    shell('students');
    const active = rows.filter(s => s.status === 'active').length;
    main.innerHTML = head('학생', `활성 ${active}명${rows.length > active ? ` · 비활성 ${rows.length - active}명` : ''}`,
      `<button class="btn" data-act="print-sel">선택 QR 카드 인쇄</button><button class="btn" data-act="print-all">전체 QR 카드 인쇄</button>
       <button class="btn" data-act="import">명단 한 번에 등록</button><button class="btn primary" data-act="new">학생 등록</button>`) + `
      <div class="card scroll">${rows.length ? `<table><tr><th><input type="checkbox" data-act="all" aria-label="전체 선택"></th><th class="num">번호</th><th>이름</th><th>지금 빌린 책</th><th>상태</th><th class="num">예약</th><th class="num">누적 대출</th></tr>
        ${rows.map(s => `<tr class="click" data-id="${s.id}"><td><input type="checkbox" class="sel" value="${s.id}" aria-label="선택"></td><td class="num">${s.number ?? ''}</td>
          <td><b>${esc(s.name)}</b>${s.status === 'inactive' ? ' <span class="badge b-off">비활성</span>' : ''}</td>
          <td>${s.loans.map(l => `${esc(l.title)} <span class="muted">~${fmtShort(l.due_date)}</span>`).join('<br>')}</td>
          <td>${s.overdue ? '<span class="badge b-late">연체</span> ' : ''}${s.suspension_until ? `<span class="badge b-late">정지 ~${fmtShort(s.suspension_until)}</span>` : ''}</td>
          <td class="num">${s.active_reservations || ''}</td><td class="num">${s.total_loans}</td></tr>`).join('')}</table>`
        : '<p class="empty">학생을 등록하세요. 엑셀 명단을 복사해 「명단 한 번에 등록」에 붙여 넣으면 빨라요.</p>'}</div>`;
    main.querySelector('[data-act="new"]').addEventListener('click', async () => {
      const r = await dialog('학생 등록', `<div class="form"><label class="f">번호<input type="number" name="number" min="1" max="99"></label><label class="f">이름<input type="text" name="name" required maxlength="50"></label></div>`,
        [{ label: '취소', value: null }, { label: '등록', value: 'ok', primary: true }]);
      if (!r) return;
      try { await api('POST', '/api/admin/students', r.data); toast('등록했어요.'); route(); } catch (e) { fail(e); }
    });
    main.querySelector('[data-act="import"]').addEventListener('click', importDialog);
    main.querySelector('[data-act="all"]')?.addEventListener('change', (e) => main.querySelectorAll('.sel').forEach(c => { c.checked = e.target.checked; }));
    main.querySelector('[data-act="print-all"]').addEventListener('click', () => window.open('/print?type=students', '_blank'));
    main.querySelector('[data-act="print-sel"]').addEventListener('click', () => {
      const ids = [...main.querySelectorAll('.sel:checked')].map(c => c.value).join(',');
      if (!ids) { toast('인쇄할 학생을 먼저 선택하세요.'); return; }
      window.open(`/print?type=students&ids=${ids}`, '_blank');
    });
    main.querySelectorAll('tr.click').forEach(tr => tr.addEventListener('click', (e) => { if (e.target.closest('input')) return; location.hash = `#/students/${tr.dataset.id}`; }));
  },

  async student(id) {
    const d = await api('GET', `/api/admin/students/${id}`);
    const s = d.student;
    const st = d.state;
    shell('students');
    main.innerHTML = head(`${s.number ? s.number + '번 ' : ''}${s.name}`, s.status === 'inactive' ? '비활성 계정 (로그인 불가)' : '',
      `<a class="btn" href="#/students">목록</a><button class="btn" data-act="print">QR 카드 인쇄</button><button class="btn" data-act="reissue">QR 재발급</button>
       <button class="btn ${s.status === 'active' ? 'danger' : ''}" data-act="toggle">${s.status === 'active' ? '비활성화' : '다시 활성화'}</button>`) + `
      <div class="grid2">
        <div class="card"><h2>기본 정보</h2>
          <form class="form" data-act="edit">
            <label class="f">번호<input type="number" name="number" min="1" max="99" value="${s.number ?? ''}"></label>
            <label class="f">이름<input type="text" name="name" required maxlength="50" value="${esc(s.name)}"></label>
            <label class="f wide">메모<input type="text" name="memo" maxlength="500" value="${esc(s.memo || '')}"></label>
            <div class="wide"><button class="btn primary">저장</button></div>
          </form>
        </div>
        <div class="card"><h2>현재 상태</h2>
          ${st.suspension_until ? `<div class="note warn" style="margin-bottom:10px">${fmtDate(st.suspension_until)}까지 이용 정지 <button class="btn small" data-act="waive" style="margin-left:8px">정지 해제</button></div>` : ''}
          ${st.loans.length ? `<table><tr><th>대출 중</th><th>반납 예정</th><th></th></tr>${st.loans.map(l => `<tr><td>${esc(l.title)} ${l.overdue_days ? `<span class="badge b-late">${l.overdue_days}일 연체</span>` : ''}</td><td>${fmtDate(l.due_date)}</td>
            <td style="white-space:nowrap"><button class="btn small" data-ret="${l.id}">반납 처리</button> <button class="btn small" data-due="${l.id}" data-cur="${l.due_date}">기한 수정</button></td></tr>`).join('')}</table>` : '<p class="muted" style="margin:0 0 8px">빌린 책 없음</p>'}
          ${st.reservations.length ? `<table style="margin-top:10px"><tr><th>예약</th><th>상태</th><th></th></tr>${st.reservations.map(r => `<tr><td>${esc(r.title)}</td><td>${badge('res', r.status)} ${r.status === 'priority' ? `${fmtShort(r.priority_expires_on)}까지` : `${r.position}번째`}</td><td><button class="btn small danger" data-cancel="${r.id}">취소</button></td></tr>`).join('')}</table>` : ''}
        </div>
      </div>
      <div class="card" style="margin-top:18px"><h2>대출 이력 ${d.history.length}건</h2>
        ${d.history.length ? `<div class="scroll"><table><tr><th>도서</th><th>소장본</th><th>대출일</th><th>반납 예정</th><th>반납일</th><th class="num">연체</th><th>상태</th></tr>${d.history.map(h => `<tr><td>${esc(h.title)}</td><td class="muted">${esc(h.copy_code)}</td><td>${fmtShort(h.loan_date)}</td><td>${fmtShort(h.due_date)}${h.extension_count ? ' (연장)' : ''}</td><td>${h.return_date ? fmtShort(h.return_date) : ''}</td><td class="num">${h.overdue_school_days || ''}</td><td>${badge('loan', h.status)}</td></tr>`).join('')}</table></div>` : '<p class="empty">아직 빌린 적이 없어요.</p>'}
      </div>
      <div class="card"><h2>예약 이력</h2>
        ${d.reservations.length ? `<table><tr><th>도서</th><th>신청</th><th>상태</th><th>종료</th></tr>${d.reservations.map(r => `<tr><td>${esc(r.title)}</td><td>${fmtDateTime(r.reserved_at)}</td><td>${badge('res', r.status)}</td><td>${fmtDateTime(r.closed_at)}</td></tr>`).join('')}</table>` : '<p class="empty">예약 기록이 없어요.</p>'}
      </div>`;
    const reload = () => PAGES.student(id).catch(fail);
    main.querySelector('form[data-act="edit"]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('PUT', `/api/admin/students/${id}`, Object.fromEntries(new FormData(e.target))); toast('저장했어요.'); reload(); } catch (err) { fail(err); }
    });
    main.querySelector('[data-act="print"]').addEventListener('click', () => window.open(`/print?type=students&ids=${id}`, '_blank'));
    main.querySelector('[data-act="reissue"]').addEventListener('click', async () => {
      const ok = await dialog('QR 카드 재발급', '<p>분실하거나 다른 사람에게 보였을 때 사용하세요. 기존 QR 카드는 바로 사용할 수 없게 되고, 새 카드를 인쇄해야 해요.</p>', [{ label: '취소', value: null }, { label: '재발급', value: 'ok', primary: true }]);
      if (!ok) return;
      try { await api('POST', `/api/admin/students/${id}/reissue`); toast('새 QR을 만들었어요. 카드를 다시 인쇄하세요.'); reload(); } catch (e) { fail(e); }
    });
    main.querySelector('[data-act="toggle"]').addEventListener('click', async () => {
      try { await api('PUT', `/api/admin/students/${id}`, { status: s.status === 'active' ? 'inactive' : 'active' }); toast('변경했어요.'); reload(); } catch (e) { fail(e); }
    });
    main.querySelector('[data-act="waive"]')?.addEventListener('click', async () => {
      const r = await confirmReason('이용 정지 해제', `${esc(s.name)} 학생의 이용 정지를 지금 해제할까요?`);
      if (!r) return;
      try { await api('POST', `/api/admin/students/${id}/waive`, r); toast('정지를 해제했어요.'); reload(); } catch (e) { fail(e); }
    });
    main.querySelectorAll('[data-cancel]').forEach(btn => btn.addEventListener('click', async () => {
      const r = await confirmReason('예약 취소', '이 예약을 취소할까요?');
      if (!r) return;
      try { await api('POST', `/api/admin/reservations/${btn.dataset.cancel}/cancel`, r); toast('취소했어요.'); reload(); } catch (e) { fail(e); }
    }));
    bindLoanActions(main, reload);
  },

  async calendar(_, params) {
    const month = params.get('m') || today.slice(0, 7);
    const [days, impact, settings] = await Promise.all([
      api('GET', `/api/admin/calendar?month=${month}`), api('GET', '/api/admin/calendar-impact'), api('GET', '/api/admin/settings'),
    ]);
    shell('calendar');
    const [y, m] = month.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
    const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
    const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const schoolDays = days.filter(d => d.is_school_day).length;
    main.innerHTML = head('학사일정', '대출 기한·연장·우선권·연체·이용 정지는 모두 여기의 수업일을 기준으로 계산해요. 학교 지정이 공휴일보다 우선해요.',
      `<a class="btn" href="#/calendar?m=${prev}">‹ 이전</a><b style="min-width:110px;text-align:center">${y}년 ${m}월</b><a class="btn" href="#/calendar?m=${next}">다음 ›</a>
       <a class="btn" href="#/calendar">이번 달</a>${settings.integrations.holiday ? `<button class="btn" data-act="sync">${y}년 공휴일 동기화</button>` : ''}`) + `
      ${impact.loans.length || impact.reservations.length ? impactCard(impact) : ''}
      <div class="card">
        <h2>${y}년 ${m}월 · 수업일 ${schoolDays}일 <span class="muted" style="font-size:13px;font-weight:400">날짜를 눌러 휴업일·수업일을 지정하세요</span></h2>
        <div class="cal">${'일월화수목금토'.split('').map(w => `<div class="dow">${w}</div>`).join('')}
          ${'<div class="pad"></div>'.repeat(firstDow)}
          ${days.map(d => {
            const dow = new Date(d.date + 'T00:00:00Z').getUTCDay();
            const cls = ['day', !d.is_school_day ? (d.teacher || d.holiday ? 'off' : 'weekend') : '', d.teacher ? 'teacher' : '', d.date === today ? 'today' : ''].join(' ');
            const why = d.teacher ? (d.teacher.reason || (d.teacher.is_school_day ? '수업일 지정' : '휴업일')) : d.holiday || '';
            return `<button class="${cls}" data-date="${d.date}" aria-label="${fmtDate(d.date)} ${d.is_school_day ? '수업일' : '쉬는 날'} ${esc(why)}"><span class="n">${Number(d.date.slice(8))}</span><span class="why">${esc(why)}</span>${d.teacher && d.holiday ? `<span class="why muted">(${esc(d.holiday)})</span>` : ''}${dow === 0 || dow === 6 ? '' : ''}</button>`;
          }).join('')}
        </div>
        <div class="legend"><span><i style="background:#fff"></i>수업일</span><span><i style="background:#f7eeee"></i>공휴일·휴업일</span><span><i style="background:#f3ecdd"></i>주말</span><span><i style="background:#fff;box-shadow:inset 0 0 0 2px #dd8fa6"></i>선생님이 지정</span></div>
      </div>
      <p class="note">공휴일은 2026~2027년 법정 공휴일·대체공휴일(노동절·제헌절 포함)이 미리 들어 있어요. ${settings.integrations.holiday ? '공공데이터포털 키가 설정되어 있어 「공휴일 동기화」로 최신 정보를 받을 수 있어요.' : '이후 연도는 날짜를 눌러 공휴일을 추가하거나, 서버에 HOLIDAY_API_KEY를 설정하면 자동으로 받을 수 있어요.'}</p>`;
    main.querySelectorAll('[data-date]').forEach(b => b.addEventListener('click', () => calendarDayDialog(days.find(d => d.date === b.dataset.date))));
    main.querySelector('[data-act="sync"]')?.addEventListener('click', async () => {
      try { const r = await api('POST', '/api/admin/holidays/sync', { year: y }); toast(`공휴일 ${r.imported}개를 반영했어요.`); route(); } catch (e) { fail(e); }
    });
    bindImpact(main);
  },

  async settings() {
    const [s, admins, backups] = await Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/admin/admins'), api('GET', '/api/admin/backups')]);
    shell('settings');
    const meta = Object.fromEntries(s.meta.map(m => [m.key, m]));
    main.innerHTML = head('설정·백업') + `
      <div class="card"><h2>운영 규칙</h2>
        <p class="note">바꾼 값은 <b>이후 새로 생기는 대출·연장·예약부터</b> 적용돼요. 이미 정해진 반납 예정일과 우선권 기간은 그대로 유지돼요.</p>
        <form class="form" data-act="settings" style="margin-top:12px">
          ${Object.entries(SETTING_LABELS).map(([k, [label, unit]]) => `<label class="f">${label}<span style="display:flex;gap:8px;align-items:center"><input type="number" name="${k}" value="${s.settings[k]}" min="0" max="${k === 'student_idle_seconds' ? 3600 : 30}" style="width:90px" required><span class="muted" style="font-weight:400">${unit}</span></span>
            <span class="muted" style="font-weight:400;font-size:12px">${meta[k]?.updated_by && meta[k].updated_by !== 'system' ? `${fmtDateTime(meta[k].updated_at)} ${esc(meta[k].updated_by)} 변경` : '기본값'}</span></label>`).join('')}
          <div class="wide"><button class="btn primary">저장</button></div>
        </form>
      </div>
      <div class="grid2">
        <div class="card"><h2>백업·복원</h2>
          <p style="margin-top:0">모든 데이터는 서버의 <code>data/library.db</code> 파일 하나에 저장돼요. 매일 자동 백업(최근 30개 보관)이 <code>data/backups</code>에 만들어져요.</p>
          <div class="toolbar"><a class="btn primary" href="/api/admin/backup">지금 백업 파일 내려받기</a></div>
          <details style="margin-top:14px"><summary>백업 파일로 복원하기</summary>
            <p class="note warn">복원하면 지금 데이터가 백업 시점으로 돌아가요(현재 파일은 자동으로 따로 보관). 파일을 올린 뒤 서버를 다시 시작해야 적용돼요.</p>
            <input type="file" accept=".db" data-act="restore"></details>
          ${backups.length ? `<details style="margin-top:10px"><summary>서버에 있는 백업 ${backups.length}개</summary><ul style="font-size:13px">${backups.slice(0, 40).map(b => `<li>${esc(b.file)} <span class="muted">(${Math.round(b.size / 1024)}KB)</span></li>`).join('')}</ul></details>` : ''}
        </div>
        <div class="card"><h2>관리자 계정</h2>
          <table>${admins.map(a => `<tr><td><b>${esc(a.display_name || a.username)}</b> <span class="muted">${esc(a.username)}</span></td><td class="muted">${fmtDateTime(a.created_at)}</td></tr>`).join('')}</table>
          <div class="toolbar" style="margin-top:12px"><button class="btn" data-act="add-admin">관리자 추가</button><button class="btn" data-act="pw">내 비밀번호 변경</button></div>
          <h2 style="margin-top:20px">외부 연동</h2>
          <table>
            <tr><td>ISBN 조회 · 국립중앙도서관</td><td>${s.integrations.nl ? '<span class="badge b-ok">사용</span>' : '<span class="badge b-off">키 없음</span>'}</td></tr>
            <tr><td>ISBN 조회 · 카카오</td><td>${s.integrations.kakao ? '<span class="badge b-ok">사용</span>' : '<span class="badge b-off">키 없음</span>'}</td></tr>
            <tr><td>ISBN 조회 · Google Books</td><td><span class="badge b-ok">사용</span></td></tr>
            <tr><td>공휴일 · 공공데이터포털</td><td>${s.integrations.holiday ? '<span class="badge b-ok">사용</span>' : '<span class="badge b-off">내장 데이터</span>'}</td></tr>
          </table>
          <p class="muted" style="font-size:13px">키는 서버 환경변수(NL_API_KEY, KAKAO_REST_API_KEY, HOLIDAY_API_KEY)로 설정해요.</p>
        </div>
      </div>`;
    main.querySelector('form[data-act="settings"]').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('PUT', '/api/admin/settings', Object.fromEntries(new FormData(e.target)));
        toast(Object.keys(r.changed).length ? '저장했어요. 새 대출부터 적용돼요.' : '바뀐 값이 없어요.');
        route();
      } catch (err) { fail(err); }
    });
    main.querySelector('[data-act="restore"]').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const ok = await dialog('복원 확인', `<p><b>${esc(f.name)}</b> 파일로 복원할까요? 서버를 다시 시작하면 적용돼요.</p>`, [{ label: '취소', value: null }, { label: '복원 파일 올리기', value: 'ok', danger: true }]);
      if (!ok) { e.target.value = ''; return; }
      try {
        const res = await fetch('/api/admin/restore', { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream' } });
        const d = await res.json();
        if (!res.ok) throw new ApiError(res.status, d.error);
        toast(d.message);
      } catch (err) { fail(err); }
    });
    main.querySelector('[data-act="add-admin"]').addEventListener('click', async () => {
      const r = await dialog('관리자 추가', `<div class="form"><label class="f">이름<input type="text" name="display_name" maxlength="30"></label><label class="f">아이디 (영문·숫자)<input type="text" name="username" required pattern="[A-Za-z0-9_.\\-]{3,30}"></label><label class="f">비밀번호 (8자 이상)<input type="password" name="password" required minlength="8"></label></div>`,
        [{ label: '취소', value: null }, { label: '추가', value: 'ok', primary: true }]);
      if (!r) return;
      try { await api('POST', '/api/admin/admins', r.data); toast('추가했어요.'); route(); } catch (e) { fail(e); }
    });
    main.querySelector('[data-act="pw"]').addEventListener('click', async () => {
      const r = await dialog('비밀번호 변경', `<div class="form"><label class="f">현재 비밀번호<input type="password" name="current" required></label><label class="f">새 비밀번호 (8자 이상)<input type="password" name="next" required minlength="8"></label></div>`,
        [{ label: '취소', value: null }, { label: '변경', value: 'ok', primary: true }]);
      if (!r) return;
      try { await api('PUT', '/api/admin/password', r.data); toast('비밀번호를 바꿨어요.'); } catch (e) { fail(e); }
    });
  },

  async stats(_, params) {
    const from = params.get('from') || '';
    const to = params.get('to') || '';
    const s = await api('GET', `/api/admin/stats?from=${from}&to=${to}`);
    shell('stats');
    const maxM = Math.max(1, ...s.monthly.map(m => m.loans));
    const totalCat = s.by_category.reduce((a, c) => a + c.loans, 0) || 1;
    main.innerHTML = head('통계', `학급 누적 대출 <b>${s.all_time}</b>건${from || to ? ` · 선택 기간 ${s.total}건` : ''}`,
      `<form data-act="range" class="row-field"><input type="date" name="from" value="${from}" aria-label="시작일"> ~ <input type="date" name="to" value="${to}" aria-label="종료일"><button class="btn">조회</button>${from || to ? '<a class="btn" href="#/stats">전체 기간</a>' : ''}</form>`) + `
      <div class="card"><h2>월별 대출 건수</h2>
        ${s.monthly.length ? `<div class="cols">${s.monthly.map(m => `<div class="c"><span class="v">${m.loans}</span><span class="col" style="height:${(m.loans / maxM) * 140}px"></span></div>`).join('')}</div>
        <div class="cols-x">${s.monthly.map(m => `<span>${Number(m.month.slice(5))}월${m.month.slice(5) === '01' || m === s.monthly[0] ? `<br>${m.month.slice(0, 4)}` : ''}</span>`).join('')}</div>` : '<p class="empty">기록이 없어요.</p>'}
      </div>
      <div class="grid2">
        <div class="card"><h2>인기 도서 TOP 10</h2>${s.top_books.length ? bars(s.top_books, 'title', 'loans') : '<p class="empty">기록이 없어요.</p>'}</div>
        <div class="card"><h2>분야별 대출 비율</h2>${s.by_category.length ? bars(s.by_category.map(c => ({ ...c, label: `${c.category} (${Math.round(c.loans * 100 / totalCat)}%)` })), 'label', 'loans') : '<p class="empty">기록이 없어요.</p>'}</div>
      </div>
      <div class="card" style="margin-top:18px"><h2>학생별 대출 건수</h2>
        ${s.by_student.length ? `<table><tr><th class="num">번호</th><th>이름</th><th class="num">대출</th><th style="width:50%"></th></tr>${s.by_student.map(st => `<tr><td class="num">${st.number ?? ''}</td><td><a href="#/students/${st.id}">${esc(st.name)}</a></td><td class="num">${st.loans}</td><td><div class="bar" style="grid-template-columns:1fr"><span class="track"><span class="fill" style="display:block;width:${(st.loans / Math.max(1, s.by_student[0].loans)) * 100}%"></span></span></div></td></tr>`).join('')}</table>` : '<p class="empty">학생이 없어요.</p>'}
      </div>`;
    main.querySelector('form[data-act="range"]').addEventListener('submit', (e) => {
      e.preventDefault();
      location.hash = `#/stats?from=${e.target.from.value}&to=${e.target.to.value}`;
    });
  },

  async audit(_, params) {
    const action = params.get('a') || '';
    const rows = await api('GET', `/api/admin/audit?limit=500${action ? `&action=${action}` : ''}`);
    shell('audit');
    const filters = [['', '전체'], ['admin_', '관리자 변경'], ['loan', '대출'], ['return', '반납'], ['extend', '연장'], ['reserv', '예약'], ['calendar', '학사일정'], ['settings', '설정']];
    main.innerHTML = head('변경 이력', '대출·반납·예약과 관리자 변경을 누가, 언제, 왜 했는지 보존해요. (최근 500건)') + `
      <div class="tabs">${filters.map(([k, t]) => `<button data-a="${k}" class="${k === action ? 'on' : ''}">${t}</button>`).join('')}</div>
      <div class="card scroll">${rows.length ? `<table><tr><th>시각</th><th>누가</th><th>무엇을</th><th>내용</th></tr>${rows.map(r => `<tr><td style="white-space:nowrap">${fmtDateTime(r.created_at)}</td><td>${r.actor_type === 'admin' ? '관리자' : r.actor_type === 'student' ? '학생' : '자동'} <span class="muted">#${r.actor_id ?? ''}</span></td><td>${esc(ACTIONS[r.action] || r.action)}</td><td class="muted" style="font-size:13px">${esc(describe(r))}</td></tr>`).join('')}</table>` : '<p class="empty">기록이 없어요.</p>'}</div>`;
    main.querySelectorAll('[data-a]').forEach(b => b.addEventListener('click', () => { location.hash = `#/audit?a=${b.dataset.a}`; }));
  },
};

function describe(r) {
  const d = r.details;
  if (!d) return '';
  const parts = [];
  if (d.reason) parts.push(`사유: ${d.reason}`);
  if (d.from && d.to) parts.push(`${d.from} → ${d.to}`);
  if (d.due) parts.push(`반납 예정 ${d.due}`);
  if (d.priority_expires_on) parts.push(`우선권 ~${d.priority_expires_on}`);
  if (d.overdue_school_days) parts.push(`연체 ${d.overdue_school_days}일`);
  if (d.suspension_until) parts.push(`정지 ~${d.suspension_until}`);
  if (d.waived) parts.push('정지 면제');
  if (d.date) parts.push(d.date);
  if (d.name && !d.title) parts.push(d.name);
  if (d.title) parts.push(d.title);
  if (d.copy_code) parts.push(d.copy_code);
  if (r.action === 'admin_settings') parts.push(Object.entries(d).map(([k, v]) => `${SETTING_LABELS[k]?.[0] || k}: ${v.from}→${v.to}`).join(', '));
  if (d.after && d.before) parts.push(Object.keys(d.after).filter(k => d.after[k] !== d.before[k]).map(k => `${k}: ${d.before[k] ?? ''}→${d.after[k] ?? ''}`).join(', '));
  if (d.student_id && !parts.length) parts.push(`학생 #${d.student_id}`);
  return parts.join(' · ');
}

// ───────────── 대화상자들 ─────────────
function bookFields(b = {}, cats = []) {
  return `
    <label class="f">ISBN<span class="row-field"><input type="text" name="isbn" value="${esc(b.isbn || '')}" inputmode="numeric"><button type="button" class="btn small" data-act="isbn-scan">스캔</button><button type="button" class="btn small" data-act="isbn-lookup">조회</button></span></label>
    <label class="f">도서명<input type="text" name="title" required maxlength="200" value="${esc(b.title || '')}"></label>
    <label class="f">저자<input type="text" name="author" maxlength="200" value="${esc(b.author || '')}"></label>
    <label class="f">출판사<input type="text" name="publisher" maxlength="100" value="${esc(b.publisher || '')}"></label>
    <label class="f">분야<input type="text" name="category" maxlength="50" list="cats" value="${esc(b.category || '')}" placeholder="예: 문학, 과학, 역사"><datalist id="cats">${[...new Set(['그림책', '문학', '과학', '역사', '사회', '예술', '학습만화', ...cats])].map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
    <label class="f">표지 이미지 주소<input type="text" name="cover_image" maxlength="500" value="${esc(b.cover_image || '')}" placeholder="https://..."></label>
    <div class="wide isbn-msg muted" style="font-size:13px"></div>`;
}

function bindIsbnLookup(scope) {
  const form = scope.querySelector('input[name=isbn]')?.form || scope;
  const msg = scope.querySelector('.isbn-msg');
  const lookup = async () => {
    const isbn = form.querySelector('input[name=isbn]').value.trim();
    if (!isbn) { msg.textContent = 'ISBN을 입력하거나 스캔하세요.'; return; }
    msg.textContent = '조회 중…';
    try {
      const r = await api('GET', `/api/admin/isbn/${encodeURIComponent(isbn)}`);
      if (!r.ok) { msg.textContent = r.message; return; }
      for (const k of ['title', 'author', 'publisher', 'cover_image']) if (r[k]) form.querySelector(`[name=${k}]`).value = r[k];
      form.querySelector('[name=isbn]').value = r.isbn;
      msg.innerHTML = `${esc(r.source)}에서 정보를 가져왔어요. 확인 후 고쳐 쓰세요.${r.existing?.length ? ` <b style="color:var(--stamp)">이미 등록된 책이 있어요: ${r.existing.map(e => `<a href="#/books/${e.id}">${esc(e.title)}</a>`).join(', ')} — 같은 책이면 그 책에 소장본을 추가하세요.</b>` : ''}`;
    } catch (e) { msg.textContent = e.message; }
  };
  scope.querySelector('[data-act="isbn-lookup"]')?.addEventListener('click', lookup);
  scope.querySelector('[data-act="isbn-scan"]')?.addEventListener('click', async () => {
    const code = await scanDialog('ISBN 바코드 스캔', '책 뒤표지의 ISBN 바코드(978 또는 979로 시작)를 보여 주세요.');
    if (!code) return;
    form.querySelector('input[name=isbn]').value = code;
    lookup();
  });
}

async function bookDialog() {
  const cats = await api('GET', '/api/admin/categories').catch(() => []);
  const r = await dialog('도서 등록', `<div class="form">${bookFields({}, cats)}
      <label class="f">소장 권수<input type="number" name="copies" min="1" max="50" value="1" required></label></div>
      <p class="note" style="margin-bottom:0">권마다 QR 라벨이 자동으로 만들어져요. 같은 책이 여러 권이면 권수를 늘리세요.</p>`,
    [{ label: '취소', value: null }, { label: '등록', value: 'ok', primary: true }], (d) => bindIsbnLookup(d));
  if (!r) return;
  try {
    const b = await api('POST', '/api/admin/books', r.data);
    toast(`「${b.book.title}」을(를) 등록했어요.`);
    location.hash = `#/books/${b.book.id}`;
  } catch (e) { fail(e); }
}

function parseRoster(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(/\t|,/).map(c => c.trim().replace(/^"|"$/g, ''));
    if (cells.some(c => /^(번호|이름|성명|학생명|학생 이름|name|no\.?)$/i.test(c))) continue; // 머리글 줄
    let number = null, name = null;
    if (cells.length >= 2 && /^\d+$/.test(cells[0])) { number = Number(cells[0]); name = cells[1]; }
    else if (cells.length >= 2 && /^\d+$/.test(cells[1])) { name = cells[0]; number = Number(cells[1]); }
    else name = cells[0];
    if (!name || /^(이름|성명|name)$/i.test(name)) continue;
    rows.push({ number, name });
  }
  return rows;
}

async function importDialog() {
  const r = await dialog('명단 한 번에 등록', `
    <p style="margin-top:0">엑셀·구글 시트에서 <b>번호, 이름</b> 두 칸을 복사해 붙여 넣거나 CSV 파일을 고르세요. 이름만 있어도 돼요.</p>
    <label class="f">CSV 파일<input type="file" accept=".csv,.txt,.tsv" data-act="file"></label>
    <label class="f" style="margin-top:10px">붙여 넣기<textarea name="text" placeholder="1&#9;김가람&#10;2&#9;이나래&#10;3&#9;박다온"></textarea></label>
    <p class="muted preview" style="font-size:13px;margin-bottom:0"></p>`,
    [{ label: '취소', value: null }, { label: '등록', value: 'ok', primary: true }], (d) => {
      const ta = d.querySelector('textarea');
      const pv = d.querySelector('.preview');
      const upd = () => { const rows = parseRoster(ta.value); pv.textContent = rows.length ? `${rows.length}명: ${rows.slice(0, 6).map(r => `${r.number ?? ''} ${r.name}`.trim()).join(', ')}${rows.length > 6 ? ' …' : ''}` : ''; };
      ta.addEventListener('input', upd);
      d.querySelector('[data-act="file"]').addEventListener('change', async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const buf = await f.arrayBuffer();
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.includes('�')) text = new TextDecoder('euc-kr').decode(buf); // 엑셀 CSV(한글 윈도우)
        ta.value = text;
        upd();
      });
    });
  if (!r) return;
  const rows = parseRoster(r.data.text || '');
  if (!rows.length) { toast('등록할 학생을 찾지 못했어요.', true); return; }
  try { const res = await api('POST', '/api/admin/students/import', { rows }); toast(`${res.created}명을 등록했어요.`); route(); } catch (e) { fail(e); }
}

// 카메라가 안 되거나 예외 상황에서 선생님이 대신 처리
async function counterDialog() {
  const students = (await api('GET', '/api/admin/students')).filter(s => s.status === 'active');
  const r = await dialog('대신 대출·반납', `
    <div class="form">
      <label class="f wide">학생<select name="student_id" required><option value="">학생 선택</option>${students.map(s => `<option value="${s.id}">${s.number ? s.number + '번 ' : ''}${esc(s.name)}${s.loans.length ? ` (대출 중: ${esc(s.loans[0].title)})` : ''}</option>`).join('')}</select></label>
      <label class="f wide">책 (QR·바코드·소장본 코드)<span class="row-field"><input type="text" name="code" required placeholder="예: B0001-1"><button type="button" class="btn small" data-act="scan">스캔</button></span></label>
    </div>
    <p class="note" style="margin-bottom:0">대출은 학생 화면과 똑같은 규칙(1인 1권, 예약 우선권, 이용 정지)으로 검사해요. 반납은 그 책을 빌린 학생으로 처리돼요.</p>`,
    [{ label: '닫기', value: null }, { label: '반납 처리', value: 'return' }, { label: '대출 처리', value: 'borrow', primary: true }], (d) => {
      d.querySelector('[data-act="scan"]').addEventListener('click', async () => {
        const code = await scanDialog('책 스캔');
        if (!code) return;
        const info = await api('GET', `/api/admin/lookup-code?code=${encodeURIComponent(code)}`).catch(() => ({}));
        if (info.type === 'student') { d.querySelector('[name=student_id]').value = info.student_id; toast(`${info.name} 학생을 선택했어요. 이제 책을 스캔하세요.`); return; }
        d.querySelector('[name=code]').value = code;
      });
    });
  if (!r) return;
  try {
    if (r.value === 'borrow') {
      const res = await api('POST', '/api/admin/loans', { student_id: Number(r.data.student_id), code: r.data.code });
      toast(`「${res.title}」 대출 완료 · 반납 예정 ${fmtDate(res.due_date)}`);
    } else {
      const info = await api('GET', `/api/admin/lookup-code?code=${encodeURIComponent(r.data.code)}`);
      if (info.type !== 'copy') { toast('등록되지 않은 책 코드예요.', true); return; }
      const loans = await api('GET', `/api/admin/loans?status=active&q=${encodeURIComponent(info.copy_code)}`);
      const loan = loans.find(l => l.copy_code === info.copy_code);
      if (!loan) { toast('대출 중인 책이 아니에요.', true); return; }
      await returnLoanDialog(loan.id, `${loan.student_name} · ${loan.title}`, loan.overdue_days);
    }
    route();
  } catch (e) { fail(e); }
}

async function returnLoanDialog(loanId, label, overdueDays) {
  const r = await confirmReason('반납 처리', `<b>${esc(label)}</b>을(를) 반납 처리할까요?${overdueDays ? ` 지금 ${overdueDays}수업일 연체 중이에요.` : ''}`,
    { extra: overdueDays ? '<label class="checkbox" style="margin-bottom:10px"><input type="checkbox" name="waive" value="1">이용 정지 면제 (결석·학교 행사 등)</label>' : '' });
  if (!r) return false;
  try {
    const res = await api('POST', `/api/admin/loans/${loanId}/return`, { reason: r.reason, waive: !!r.waive });
    toast(`반납 처리했어요.${res.suspension_until ? ` ${fmtDate(res.suspension_until)}까지 이용 정지.` : ''}${res.reserved_by_other ? ' 다음 예약자에게 우선권이 생겼어요.' : ''}`);
    return true;
  } catch (e) { fail(e); return false; }
}

function bindLoanActions(scope, reload) {
  scope.querySelectorAll('[data-ret]').forEach(b => b.addEventListener('click', async () => {
    const row = b.closest('tr');
    const label = row ? [...row.querySelectorAll('td')].slice(0, 2).map(td => td.textContent.trim()).join(' · ') : '';
    const late = row?.querySelector('.b-late')?.textContent.match(/\d+/)?.[0];
    if (await returnLoanDialog(Number(b.dataset.ret), label, late ? Number(late) : 0)) reload();
  }));
  scope.querySelectorAll('[data-due]').forEach(b => b.addEventListener('click', async () => {
    const r = await dialog('반납 예정일 수정', `<div class="form"><label class="f">새 반납 예정일<input type="date" name="due_date" required value="${b.dataset.cur}"></label>
      <label class="f">변경 사유<input type="text" name="reason" required maxlength="300" placeholder="예: 현장체험학습"></label></div>`,
      [{ label: '취소', value: null }, { label: '저장', value: 'ok', primary: true }]);
    if (!r) return;
    try { await api('PUT', `/api/admin/loans/${b.dataset.due}/due`, r.data); toast('반납 예정일을 바꿨어요.'); reload(); } catch (e) { fail(e); }
  }));
}

async function calendarDayDialog(d) {
  const base = d.holiday ? `법정 공휴일 (${d.holiday})` : ['0', '6'].includes(String(new Date(d.date + 'T00:00:00Z').getUTCDay())) ? '주말' : '평일 수업일';
  const r = await dialog(fmtDate(d.date, { year: true }), `
    <p style="margin-top:0">기본: <b>${esc(base)}</b>${d.teacher ? ` → 선생님 지정: <b>${d.teacher.is_school_day ? '수업일' : '휴업일'}</b>${d.teacher.reason ? ` (${esc(d.teacher.reason)})` : ''}` : ''}<br>지금: <b>${d.is_school_day ? '수업일' : '쉬는 날'}</b></p>
    <label class="f">사유 / 일정 이름<input type="text" name="reason" maxlength="100" value="${esc(d.teacher?.reason || '')}" placeholder="예: 학교 재량휴업일, 개교기념일, 토요 수업"></label>
    <details style="margin-top:12px"><summary>법정 공휴일 정보 고치기</summary>
      <label class="f" style="margin-top:8px">공휴일 이름<input type="text" name="holiday" maxlength="50" value="${esc(d.holiday || '')}" placeholder="예: 대체공휴일"></label>
      <div class="toolbar" style="margin-top:8px"><button class="btn small" value="holiday-save">공휴일로 저장</button>${d.holiday ? '<button class="btn small danger" value="holiday-del">공휴일 삭제</button>' : ''}</div>
    </details>`,
    [{ label: '닫기', value: null }, ...(d.teacher ? [{ label: '선생님 지정 해제', value: 'clear' }] : []),
      { label: '수업일로 지정', value: 'school' }, { label: '휴업일로 지정', value: 'off', primary: true }],
    (dlg) => dlg.querySelectorAll('details button').forEach(b => b.addEventListener('click', async (e) => {
      e.preventDefault();
      const name = dlg.querySelector('[name=holiday]').value;
      try {
        if (b.value === 'holiday-save') await api('PUT', `/api/admin/holidays/${d.date}`, { name });
        else await api('DELETE', `/api/admin/holidays/${d.date}`);
        toast('공휴일 정보를 바꿨어요.');
        dlg.close();
        route();
      } catch (err) { fail(err); }
    })));
  if (!r) return;
  try {
    let res;
    if (r.value === 'clear') res = await api('DELETE', `/api/admin/calendar/${d.date}`);
    else res = await api('PUT', `/api/admin/calendar/${d.date}`, { is_school_day: r.value === 'school', reason: r.data.reason || (r.value === 'off' ? '휴업일' : '수업일') });
    toast('학사일정을 바꿨어요.');
    if (res.impact.loans.length || res.impact.reservations.length) toast('이 변경으로 계산이 달라지는 대출·예약이 있어요. 위의 확인 목록을 보세요.');
    route();
  } catch (e) { fail(e); }
}

function impactCard(impact) {
  return `<div class="card" style="border-color:#f1d98f;background:#fffbef"><h2>학사일정 변경 영향 확인</h2>
    <p style="margin-top:0">아래 대출·예약은 이미 정해진 날짜가 지금 학사일정으로 다시 계산한 날짜와 달라요. 이미 안내된 날짜는 자동으로 바꾸지 않아요. 바꿀 항목만 골라 반영하세요.</p>
    <form data-act="impact"><table><tr><th></th><th>구분</th><th>학생</th><th>도서</th><th>지금 날짜</th><th>다시 계산</th></tr>
    ${impact.loans.map(l => `<tr><td><input type="checkbox" name="loan" value="${l.id}" checked></td><td>반납 예정일</td><td>${esc(l.name)}</td><td>${esc(l.title)}</td><td>${fmtDate(l.final_due_date)}</td><td><b>${fmtDate(l.recalculated)}</b></td></tr>`).join('')}
    ${impact.reservations.map(r => `<tr><td><input type="checkbox" name="res" value="${r.id}" checked></td><td>우선권 만료일</td><td>${esc(r.name)}</td><td>${esc(r.title)}</td><td>${fmtDate(r.priority_expires_on)}</td><td><b>${fmtDate(r.recalculated)}</b></td></tr>`).join('')}
    </table><div class="toolbar" style="margin-top:10px"><button class="btn primary">선택한 항목 반영</button></div></form></div>`;
}

function bindImpact(scope) {
  scope.querySelector('form[data-act="impact"]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api('POST', '/api/admin/calendar-impact/apply', { loan_ids: fd.getAll('loan'), reservation_ids: fd.getAll('res') });
      toast(`${r.applied}건을 반영했어요.`);
      route();
    } catch (err) { fail(err); }
  });
}

// ───────────── 로그인·초기 설정 ─────────────
function showLogin(setup = false) {
  me = null;
  root.innerHTML = `<div class="auth"><form class="box" data-act="auth">
    <h1>${setup ? '처음 오셨네요' : '선생님 로그인'}</h1>
    ${setup ? '<p class="muted" style="margin:0">관리자 계정을 만들어 주세요. 이 계정으로 도서·학생·대출을 관리해요.</p><label class="f">이름<input type="text" name="display_name" maxlength="30" placeholder="예: 김선생"></label>' : ''}
    <label class="f">아이디<input type="text" name="username" required autocomplete="username" ${setup ? 'pattern="[A-Za-z0-9_.\\-]{3,30}" title="영문·숫자 3~30자"' : ''}></label>
    <label class="f">비밀번호${setup ? ' (8자 이상)' : ''}<input type="password" name="password" required ${setup ? 'minlength="8" autocomplete="new-password"' : 'autocomplete="current-password"'}></label>
    <div class="err" role="alert"></div>
    <button class="btn primary">${setup ? '계정 만들기' : '로그인'}</button>
    <a href="/" style="font-size:14px">학생 화면으로</a>
  </form></div>`;
  root.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      if (setup) await api('POST', '/api/setup', data);
      await api('POST', '/api/admin/login', data);
      await start();
    } catch (err) { root.querySelector('.err').textContent = err.message; }
  });
  root.querySelector('input[name=username]').focus();
}

// ───────────── 라우터 ─────────────
async function route() {
  if (!me) return;
  const [path, qs] = (location.hash.slice(2) || 'dashboard').split('?');
  const [page, id] = path.split('/');
  const params = new URLSearchParams(qs || '');
  const key = id && page === 'books' ? 'book' : id && page === 'students' ? 'student' : page;
  const fn = PAGES[key] || PAGES.dashboard;
  try {
    await fn(id ? Number(id) : null, params);
    main?.scrollTo?.(0, 0);
  } catch (e) { fail(e); }
}
window.addEventListener('hashchange', route);

async function start() {
  const cfg = await api('GET', '/api/config');
  today = cfg.today;
  if (cfg.setup_needed) return showLogin(true);
  try { me = await api('GET', '/api/admin/me'); } catch { return showLogin(); }
  root.innerHTML = '';
  route();
}

// 관리자 화면에서도 USB 스캐너로 책을 찍으면 그 책 페이지로 이동
listenKeyboardScanner(async (code) => {
  if (!me || document.querySelector('dialog[open]')) return;
  try {
    const info = await api('GET', `/api/admin/lookup-code?code=${encodeURIComponent(code)}`);
    if (info.type === 'copy') location.hash = `#/books/${info.book_id}`;
    else if (info.type === 'student') location.hash = `#/students/${info.student_id}`;
  } catch {}
});

start();
