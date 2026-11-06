// 학생용 키오스크 화면
import { api, esc, fmtDate, ApiError } from './common.js';
import { Scanner, listenKeyboardScanner, cameraPref, setCameraPref, feedback } from './scanner.js';

const app = document.getElementById('app');
const who = document.getElementById('who');
const whoName = document.getElementById('who-name');

const I = {
  borrow: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M10 14h18a6 6 0 0 1 6 6v32a5 5 0 0 0-5-5H10z M54 14H36a6 6 0 0 0-6 6v32a5 5 0 0 1 5-5h19z" fill="#fff" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/><path d="M32 4v12m-6-6 6 6 6-6" stroke="currentColor" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  return: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="12" y="10" width="12" height="44" rx="2" fill="#fff" stroke="currentColor" stroke-width="3.5"/><rect x="27" y="16" width="12" height="38" rx="2" fill="#fff" stroke="currentColor" stroke-width="3.5"/><path d="M46 16l8 36" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/><path d="M6 56h52" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>',
  reserve: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 8h28v48L32 46 18 56z" fill="#fff" stroke="currentColor" stroke-width="3.5" stroke-linejoin="round"/><circle cx="32" cy="24" r="7" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="M32 20v4l3 2" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
  mine: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="10" y="12" width="44" height="40" rx="5" fill="#fff" stroke="currentColor" stroke-width="3.5"/><circle cx="24" cy="28" r="6" fill="none" stroke="currentColor" stroke-width="3.5"/><path d="M15 44c2-6 6-8 9-8s7 2 9 8M38 26h10M38 34h10" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" fill="none"/></svg>',
  ok: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 34l12 12 24-26" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  no: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M18 18l28 28M46 18L18 46" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round"/></svg>',
  warn: '<svg viewBox="0 0 34 34" aria-hidden="true"><path d="M17 3l15 27H2z" fill="currentColor" opacity=".15" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/><path d="M17 13v8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="17" cy="25.5" r="1.8" fill="currentColor"/></svg>',
  star: '<svg viewBox="0 0 34 34" aria-hidden="true"><path d="M17 3l4.2 8.6 9.4 1.4-6.8 6.6 1.6 9.4L17 24.6 8.6 29l1.6-9.4L3.4 13l9.4-1.4z" fill="currentColor" opacity=".2" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>',
  clock: '<svg viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="13" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="M17 9v8l5 4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>',
  shelf: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6l4 4 8-8" transform="translate(0 4)" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>',
  out: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 6v4l3 2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
  qr: '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="3"/><rect x="8" y="8" width="4" height="4" fill="currentColor"/><rect x="24" y="4" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="3"/><rect x="28" y="8" width="4" height="4" fill="currentColor"/><rect x="4" y="24" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="3"/><rect x="8" y="28" width="4" height="4" fill="currentColor"/><rect x="24" y="24" width="7" height="7" fill="currentColor"/><rect x="33" y="24" width="3" height="3" fill="currentColor"/><rect x="24" y="33" width="3" height="3" fill="currentColor"/><rect x="29" y="29" width="7" height="7" fill="currentColor"/></svg>',
};

let me = null;          // 현재 학생 상태
let view = 'login';
let scanner = null;
let onScan = null;      // 현재 화면의 스캔 처리기
let idleSeconds = 90;
let lastActive = Date.now();
let busy = false;

// ───────────── 공통 ─────────────
function toast(text) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

async function stopCamera() {
  if (scanner) { const s = scanner; scanner = null; await s.stop(); }
}

async function startCamera(handler) {
  onScan = handler;
  const box = document.querySelector('.cam');
  if (!box) return;
  const inner = box.querySelector('.cam-inner');
  scanner = new Scanner(inner, (code) => handle(code));
  try {
    await scanner.start();
  } catch (e) {
    inner.innerHTML = `<div class="cam-msg">${esc(e.message)}</div>`;
  }
}

async function handle(code) {
  if (busy || !onScan) return;
  busy = true;
  try { await onScan(code); } finally { busy = false; }
}

function camBlock(label) {
  return `
    <div class="cam-wrap">
      <div class="cam"><div class="cam-inner" style="width:100%;height:100%"></div></div>
      <div class="cam-tools">
        <button class="chip" data-act="flip">카메라 바꾸기 (지금: ${cameraPref() === 'user' ? '앞' : '뒤'})</button>
      </div>
      <form class="manual" data-act="manual">
        <input name="code" autocomplete="off" placeholder="${esc(label)}" aria-label="${esc(label)}">
        <button type="submit">확인</button>
      </form>
    </div>`;
}

function bindCamTools(handler) {
  app.querySelector('[data-act="flip"]')?.addEventListener('click', async (e) => {
    setCameraPref(cameraPref() === 'user' ? 'environment' : 'user');
    e.currentTarget.textContent = `카메라 바꾸기 (지금: ${cameraPref() === 'user' ? '앞' : '뒤'})`;
    await stopCamera();
    startCamera(handler);
  });
  app.querySelector('form[data-act="manual"]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.target.code.value.trim();
    e.target.code.value = '';
    if (v) handle(v);
  });
}

async function go(next, arg) {
  await stopCamera();
  onScan = null;
  view = next;
  lastActive = Date.now();
  window.scrollTo(0, 0);
  await VIEWS[next](arg);
}

async function refreshMe() {
  me = await api('GET', '/api/student/me');
  idleSeconds = me.idle_seconds || 90;
  whoName.textContent = me.student.name;
  who.classList.remove('hidden');
  return me;
}

function onApiError(e) {
  if (e instanceof ApiError && e.status === 401) { logout(true); return true; }
  return false;
}

async function logout(expired) {
  try { await api('POST', '/api/student/logout'); } catch {}
  me = null;
  who.classList.add('hidden');
  hideIdle();
  await go('landing');
  if (expired === true) toast('오랫동안 사용하지 않아서 로그아웃했어요.');
}
document.getElementById('logout').addEventListener('click', () => logout());

function cover(b) {
  const letter = esc((b.title || '?').trim()[0] || '?');
  if (b.cover_image) return `<img class="cover" src="${esc(b.cover_image)}" alt="" referrerpolicy="no-referrer" data-fallback="${letter}">`;
  return `<div class="cover" aria-hidden="true">${letter}</div>`;
}

function cover2(b) {
  const letter = esc((b.title || '?').trim()[0] || '?');
  if (b.cover_image) return `<img class="cover2" src="${esc(b.cover_image)}" alt="" referrerpolicy="no-referrer" data-fallback="${letter}">`;
  return `<div class="cover2" aria-hidden="true">${letter}</div>`;
}

// 표지 이미지가 깨지면 브라우저 기본 아이콘 대신 글자 플레이스홀더로 바꾼다 (img는 error가 버블링되지 않아 capture 사용)
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.dataset.fallback) return;
  const div = document.createElement('div');
  div.className = img.className;
  div.setAttribute('aria-hidden', 'true');
  div.textContent = img.dataset.fallback;
  img.replaceWith(div);
}, true);

// ───────────── 화면들 ─────────────
const VIEWS = {
  async landing() {
    who.classList.add('hidden');
    app.innerHTML = `
      <section class="screen landing">
        <div class="landing-hero">
          <div>
            <div class="hero-badge">📚 양배추 책방</div>
            <h1>오늘은 어떤 책을<br>만나볼까요?</h1>
            <p>내 이름이 적힌 QR 카드만 있으면<br>혼자서도 책을 빌리고 반납할 수 있어요.</p>
            <button class="btn primary big" data-act="login">${I.qr}QR 카드로 로그인하기</button>
          </div>
          <img class="hero-pic" src="/img/mascot.webp" alt="양배추 책방 마스코트" data-fallback="🥬">
        </div>
        <div class="bestseller">
          <h2>우리 반 책꽂이</h2>
          <p class="sub">지금 우리 반에 있는 책들이에요. 로그인하면 빌리거나 예약할 수 있어요.</p>
          <div class="table" id="landing-books"><p class="empty">책을 불러오는 중이에요…</p></div>
        </div>
      </section>`;
    app.querySelector('[data-act="login"]').addEventListener('click', () => go('login'));
    loadPublicBooks();
  },

  async login() {
    who.classList.add('hidden');
    app.innerHTML = `
      <section class="screen login">
        <div>
          <button class="btn small back" data-act="landing">← 처음으로</button>
          <h1>책 읽을 준비 됐나요?</h1>
          <p>내 이름이 적힌 QR 카드를 카메라에 보여 주세요.</p>
          <ol class="steps">
            <li><b>1</b>QR 카드를 네모 칸 안에 맞춰요</li>
            <li><b>2</b>"삑" 소리가 나면 로그인돼요</li>
            <li><b>3</b>다 쓰면 「다 했어요」를 눌러요</li>
          </ol>
        </div>
        ${camBlock('QR 카드가 안 찍히면 선생님께 말씀해 주세요')}
      </section>`;
    app.querySelector('[data-act="landing"]').addEventListener('click', () => go('landing'));
    const handler = async (code) => {
      try {
        await api('POST', '/api/student/login', { code });
        await refreshMe();
        go('home');
      } catch (e) {
        feedback(false);
        toast(e.hint ? `${e.message} ${e.hint}` : e.message);
      }
    };
    bindCamTools(handler);
    startCamera(handler);
  },

  async home() {
    try { await refreshMe(); } catch (e) { if (!onApiError(e)) toast(e.message); return; }
    const loan = me.loans[0];
    const res = me.reservations;
    let status = '';
    if (me.suspension_until) {
      status += `<div class="notice bad">${I.warn}<div><b>${fmtDate(me.suspension_until)}까지 쉬는 기간이에요</b>반납이 늦어서 그때까지는 새로 빌리거나 예약할 수 없어요. 빌린 책 반납과 예약 취소는 할 수 있어요.</div></div>`;
    }
    for (const r of res) {
      if (r.status === 'priority') {
        status += `<div class="notice good">${I.star}<div><b>기다리던 「${esc(r.title)}」이(가) 돌아왔어요!</b>${fmtDate(r.priority_expires_on)}까지 「책 빌리기」로 빌릴 수 있어요. 지나면 다음 친구 차례가 돼요.</div></div>`;
      } else {
        status += `<div class="notice wait">${I.clock}<div><b>「${esc(r.title)}」 예약 중</b>내 차례는 ${r.position}번째예요.</div></div>`;
      }
    }
    const loanHtml = loan ? `
      <div class="mybook">
        ${cover(loan)}
        <div>
          <h3>${esc(loan.title)}</h3>
          ${loan.author ? `<div class="by">${esc(loan.author)}</div>` : ''}
          <div class="stamp${loan.overdue_days ? ' late' : ''}"><small>${loan.overdue_days ? '반납일 지남' : '반납일'}</small><span>${fmtDate(loan.due_date)}</span></div>
          <p class="left-days">${loan.overdue_days
            ? `<strong style="color:var(--stamp)">${loan.overdue_days}일 늦었어요.</strong> 오늘 바로 반납해 주세요.`
            : loan.school_days_left === 0 ? '<strong>오늘까지 반납해요.</strong>' : `반납까지 학교 오는 날로 <strong>${loan.school_days_left}일</strong> 남았어요.`}</p>
          ${loan.can_extend ? `<button class="btn small" data-act="extend" data-id="${loan.id}">반납일 미루기 (연장)</button>`
            : loan.extend_block && !loan.overdue_days ? `<p class="empty" style="font-size:18px">${esc(loan.extend_block.message)}</p>` : ''}
        </div>
      </div>` : `<p class="empty">지금 빌린 책이 없어요. 「책 빌리기」를 눌러 읽고 싶은 책을 빌려 보세요.</p>`;

    const canBorrow = me.can_borrow;
    app.innerHTML = `
      <section class="screen home">
        <div>
          <div class="panel">
            <h2>내가 빌린 책</h2>
            ${loanHtml}
          </div>
          ${status}
        </div>
        <nav class="shelf" aria-label="할 일 고르기">
          <button class="spine borrow" data-go="borrow" ${canBorrow ? '' : 'aria-describedby="why-borrow"'}>${I.borrow}책<br>빌리기${!canBorrow ? `<span class="sub" id="why-borrow">${loan && !me.overdue && !me.suspension_until ? '한 권씩 빌려요' : '지금은 못 빌려요'}</span>` : ''}</button>
          <button class="spine return" data-go="return" ${me.loans.length ? '' : 'disabled'}>${I.return}책<br>반납하기</button>
          <button class="spine reserve" data-go="reserve">${I.reserve}도서<br>예약하기</button>
          <button class="spine mine" data-go="mine">${I.mine}나의<br>도서관</button>
        </nav>
      </section>`;
    app.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
    app.querySelector('[data-act="extend"]')?.addEventListener('click', (e) => go('extend', Number(e.currentTarget.dataset.id)));
    onScan = async () => toast('먼저 할 일을 골라 주세요. (책 빌리기 / 책 반납하기)');
  },

  async borrow() {
    if (!me.can_borrow) {
      const loan = me.loans[0];
      if (me.suspension_until) return result(false, '지금은 빌릴 수 없어요', `${fmtDate(me.suspension_until)}까지 쉬는 기간이에요.`, '기간이 끝나면 다시 빌릴 수 있어요.', null, 'BLOCKED');
      if (me.overdue) return result(false, '먼저 반납해 주세요', `「${loan.title}」의 반납일이 지났어요.`, '책을 반납한 뒤에 새 책을 빌릴 수 있어요.', null, 'BLOCKED');
      return result(false, '한 권씩 빌려요', `지금 「${loan.title}」을(를) 빌리고 있어요.`, '다 읽은 책을 반납하면 새 책을 빌릴 수 있어요.', null, 'BLOCKED');
    }
    taskScreen('책 빌리기', '빌릴 책 뒤에 붙은 QR코드를 카메라에 보여 주세요.', '책 코드 직접 입력', async (code) => {
      try {
        const r = await api('POST', '/api/student/borrow', { code });
        result(true, '빌렸어요!', `「${r.title}」`, null, r.due_date);
      } catch (e) {
        if (onApiError(e)) return;
        result(false, '빌리지 못했어요', e.message, e.hint, null, e.code);
      }
    });
  },

  async return() {
    taskScreen('책 반납하기', '반납할 책의 QR코드를 카메라에 보여 주세요.', '책 코드 직접 입력', async (code) => {
      try {
        const r = await api('POST', '/api/student/return', { code });
        let msg = `「${r.title}」`;
        let hint = '책꽂이 제자리에 꽂아 주세요.';
        if (r.reserved_by_other) hint = '이 책을 기다리는 친구가 있어요. 「예약 도서」 자리에 놓아 주세요.';
        if (r.overdue_school_days > 0) {
          hint += r.suspension_until ? ` 반납이 ${r.overdue_school_days}일 늦어서 ${fmtDate(r.suspension_until)}까지는 새로 빌릴 수 없어요.` : '';
        }
        result(true, '반납했어요!', msg, hint);
      } catch (e) {
        if (onApiError(e)) return;
        result(false, '반납하지 못했어요', e.message, e.hint);
      }
    });
  },

  async extend(loanId) {
    try {
      const r = await api('POST', '/api/student/extend', { loan_id: loanId });
      result(true, '반납일을 미뤘어요!', `새 반납일까지 천천히 읽어요.`, null, r.due_date);
    } catch (e) {
      if (onApiError(e)) return;
      result(false, '연장하지 못했어요', e.message, e.hint);
    }
  },

  async reserve(q = '') {
    app.innerHTML = `
      <section class="screen">
        <button class="btn small back" data-act="home">처음으로</button>
        <div class="panel">
          <h2>어떤 책을 기다릴까요?</h2>
          <form class="search" data-act="search">
            <input name="q" value="${esc(q)}" placeholder="책 제목이나 지은이" autocomplete="off" aria-label="책 찾기">
            <button class="btn primary" type="submit">찾기</button>
          </form>
          ${me.suspension_until ? `<div class="notice bad">${I.warn}<div><b>${fmtDate(me.suspension_until)}까지는 예약할 수 없어요</b>쉬는 기간이 끝나면 다시 예약할 수 있어요.</div></div>` : ''}
          <div class="booklist" id="books"><p class="empty">책을 불러오는 중이에요…</p></div>
        </div>
      </section>`;
    app.querySelector('[data-act="home"]').addEventListener('click', () => go('home'));
    app.querySelector('form[data-act="search"]').addEventListener('submit', (e) => { e.preventDefault(); loadBooks(e.target.q.value.trim()); });
    loadBooks(q);
    onScan = async (code) => {
      try {
        const r = await api('POST', '/api/student/reserve', { code });
        result(true, '예약했어요!', `「${r.title}」`, `내 차례는 ${r.position}번째예요. 책이 돌아오면 첫 화면에서 알려 줄게요.`);
      } catch (e) {
        if (onApiError(e)) return;
        result(false, '예약하지 못했어요', e.message, e.hint);
      }
    };
  },

  async mine() {
    try { await refreshMe(); } catch (e) { if (!onApiError(e)) toast(e.message); return; }
    let hist = [];
    try { hist = await api('GET', '/api/student/history'); } catch (e) { if (onApiError(e)) return; }
    const loans = me.loans.map(l => `<li><span class="t">${esc(l.title)}${l.overdue_days ? `<span class="tag late">${l.overdue_days}일 늦음</span>` : '<span class="tag now">읽는 중</span>'}</span><span class="d">반납일 ${fmtDate(l.due_date)}</span></li>`).join('');
    const resv = me.reservations.map(r => `<li><span class="t">${esc(r.title)}<span class="tag now">${r.status === 'priority' ? `${fmtDate(r.priority_expires_on)}까지 빌리기` : `${r.position}번째`}</span></span>
      <button class="btn small" data-cancel="${r.id}">예약 취소</button></li>`).join('');
    const past = hist.filter(h => h.status !== 'active');
    app.innerHTML = `
      <section class="screen">
        <button class="btn small back" data-act="home">처음으로</button>
        <div class="mine-grid">
          <div style="display:grid;gap:24px">
            <div class="panel"><h2>지금 빌린 책</h2>${loans ? `<ul class="hist">${loans}</ul>` : '<p class="empty">빌린 책이 없어요.</p>'}</div>
            <div class="panel"><h2>예약한 책</h2>${resv ? `<ul class="hist">${resv}</ul>` : '<p class="empty">예약한 책이 없어요.</p>'}</div>
            ${me.suspension_until ? `<div class="notice bad">${I.warn}<div><b>${fmtDate(me.suspension_until)}까지 쉬는 기간</b>그다음 학교 오는 날부터 다시 빌릴 수 있어요.</div></div>` : ''}
          </div>
          <div class="panel"><h2>지금까지 읽은 책 ${past.length}권</h2>
            ${past.length ? `<ul class="hist">${past.map(h => `<li><span class="t">${esc(h.title)}${h.overdue_school_days ? `<span class="tag late">${h.overdue_school_days}일 늦음</span>` : ''}</span><span class="d">${fmtDate(h.loan_date)} ~ ${fmtDate(h.return_date)}</span></li>`).join('')}</ul>` : '<p class="empty">아직 반납한 책이 없어요. 첫 책을 빌려 볼까요?</p>'}
          </div>
        </div>
      </section>`;
    app.querySelector('[data-act="home"]').addEventListener('click', () => go('home'));
    app.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
      if (!confirmInline(b)) return;
      try {
        await api('POST', `/api/student/reservations/${b.dataset.cancel}/cancel`);
        toast('예약을 취소했어요.');
        go('mine');
      } catch (e) { if (!onApiError(e)) toast(e.message); }
    }));
  },
};

// 버튼을 한 번 더 눌러야 실행 (브라우저 대화상자 대신)
function confirmInline(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1';
  const old = btn.textContent;
  btn.textContent = '한 번 더 누르면 취소돼요';
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 4000);
  return false;
}

async function loadBooks(q) {
  const box = document.getElementById('books');
  if (!box) return;
  try {
    const list = await api('GET', `/api/student/books?q=${encodeURIComponent(q)}`);
    if (!list.length) { box.innerHTML = `<p class="empty">${q ? `"${esc(q)}"(으)로 찾은 책이 없어요. 다른 말로 찾아보세요.` : '아직 등록된 책이 없어요.'}</p>`; return; }
    box.innerHTML = list.map(b => {
      let state, action = '';
      if (b.my_loan) state = `<span class="state na">${I.shelf}내가 읽고 있어요</span>`;
      else if (b.my_reservation) state = `<span class="state off">${I.out}예약했어요</span>`;
      else if (b.on_shelf) state = `<span class="state on">${I.shelf}책꽂이에 있어요 · 바로 빌릴 수 있어요</span>`;
      else if (!b.usable) state = '<span class="state na">지금은 볼 수 없어요</span>';
      else {
        state = `<span class="state off">${I.out}다른 친구가 읽는 중${b.queue ? ` · ${b.queue}명 기다려요` : ''}</span>`;
        action = `<button class="btn small" data-reserve="${b.id}" ${me.can_reserve ? '' : 'disabled'}>예약하기</button>`;
      }
      return `<article class="bookrow">${cover(b)}<div><h3>${esc(b.title)}</h3>${b.author ? `<div class="by">${esc(b.author)}</div>` : ''}<div>${state}</div>${action}</div></article>`;
    }).join('');
    box.querySelectorAll('[data-reserve]').forEach(btn => btn.addEventListener('click', async () => {
      try {
        const r = await api('POST', '/api/student/reserve', { book_id: Number(btn.dataset.reserve) });
        result(true, '예약했어요!', `「${r.title}」`, `내 차례는 ${r.position}번째예요. 책이 돌아오면 첫 화면에서 알려 줄게요.`);
      } catch (e) {
        if (onApiError(e)) return;
        result(false, '예약하지 못했어요', e.message, e.hint);
      }
    }));
  } catch (e) {
    if (!onApiError(e)) box.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

async function loadPublicBooks() {
  const box = document.getElementById('landing-books');
  if (!box) return;
  try {
    const list = await api('GET', '/api/public/books');
    if (!list.length) { box.innerHTML = '<p class="empty">아직 등록된 책이 없어요. 선생님께서 곧 채워 주실 거예요.</p>'; return; }
    box.innerHTML = list.map(b => `
      <div class="stall">
        ${cover2(b)}
        <span class="badge-pill ${b.on_shelf ? 'avail' : 'out'}">${b.on_shelf ? '대출 가능' : '대출 중'}</span>
        <div class="ttl">${esc(b.title)}</div>
        ${b.author ? `<div class="by2">${esc(b.author)}</div>` : ''}
      </div>`).join('');
  } catch {
    box.innerHTML = '<p class="empty">책 목록을 불러오지 못했어요.</p>';
  }
}

function taskScreen(title, desc, manualLabel, handler) {
  app.innerHTML = `
    <section class="screen task">
      <div>
        <button class="btn small back" data-act="home">처음으로</button>
        <h1>${esc(title)}</h1>
        <p>${esc(desc)}</p>
      </div>
      ${camBlock(manualLabel)}
    </section>`;
  app.querySelector('[data-act="home"]').addEventListener('click', () => go('home'));
  bindCamTools(handler);
  startCamera(handler);
}

async function result(ok, title, msg, hint, dueDate, code) {
  await stopCamera();
  feedback(ok);
  onScan = null;
  const reserveBtn = code === 'LOANED_BY_OTHER' || code === 'RESERVED_FOR_OTHER';
  app.innerHTML = `
    <section class="screen">
      <div class="result ${ok ? 'ok' : 'no'}" role="status">
        <div class="mark">${ok ? I.ok : I.no}</div>
        <h2>${esc(title)}</h2>
        ${msg ? `<p class="msg">${esc(msg)}</p>` : ''}
        ${dueDate ? `<div class="stamp"><small>반납일</small><span>${fmtDate(dueDate)}</span></div>` : ''}
        ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
        <div class="actions">
          ${!ok && code !== 'BLOCKED' && (view === 'borrow' || view === 'return') ? '<button class="btn" data-act="again">다시 찍기</button>' : ''}
          ${reserveBtn ? '<button class="btn" data-act="reserve">예약하러 가기</button>' : ''}
          <button class="btn primary" data-act="home">처음으로</button>
          ${ok ? '<button class="btn" data-act="logout">다 했어요</button>' : ''}
        </div>
      </div>
    </section>`;
  app.querySelector('[data-act="home"]').addEventListener('click', () => go('home'));
  app.querySelector('[data-act="again"]')?.addEventListener('click', () => go(view));
  app.querySelector('[data-act="reserve"]')?.addEventListener('click', () => go('reserve'));
  app.querySelector('[data-act="logout"]')?.addEventListener('click', () => logout());
  app.querySelector('[data-act="home"]').focus();
}

// ───────────── 자동 로그아웃 ─────────────
let idleBox = null;
function hideIdle() { idleBox?.remove(); idleBox = null; }
['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, () => {
  lastActive = Date.now();
  if (idleBox) hideIdle();
}, { passive: true }));

let lastPing = 0;
setInterval(() => {
  if (!me) return;
  const idle = (Date.now() - lastActive) / 1000;
  const left = Math.ceil(idleSeconds - idle);
  if (left <= 0) { logout(true); return; }
  if (left <= 15) {
    if (!idleBox) {
      idleBox = document.createElement('div');
      idleBox.className = 'idle';
      idleBox.innerHTML = `<div class="box" role="alertdialog" aria-live="assertive"><h2>아직 쓰고 있나요?</h2><div class="count"></div><p>화면을 누르면 계속 쓸 수 있어요.</p><button class="btn primary">계속 쓸래요</button></div>`;
      document.body.appendChild(idleBox);
    }
    idleBox.querySelector('.count').textContent = left;
  }
  // 화면을 쓰는 동안 서버 세션도 살아 있게 유지
  if (idle < 5 && Date.now() - lastPing > 30_000) {
    lastPing = Date.now();
    api('GET', '/api/student/me').then(d => { me = d; }).catch(e => onApiError(e));
  }
}, 1000);

// USB 바코드 스캐너(키보드 입력) 지원
listenKeyboardScanner((code) => handle(code));

// 시작: 이미 로그인된 세션이 있으면 메인으로
(async () => {
  try {
    await refreshMe();
    go('home');
  } catch {
    go('landing');
  }
})();
