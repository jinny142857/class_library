// 카메라 QR/바코드 스캐너.
// 1순위: 브라우저 내장 BarcodeDetector (Android Chrome, ChromeOS, macOS Chrome 등)
// 2순위: html5-qrcode 라이브러리 (BarcodeDetector 미지원 브라우저, 예: Windows Chrome) — 필요할 때만 CDN에서 불러옴
// 3순위: USB/블루투스 바코드 스캐너(키보드처럼 입력) — listenKeyboardScanner()
// 4순위: 화면의 직접 입력칸

const FALLBACK_SRC = '/vendor/html5-qrcode.min.js'; // html5-qrcode v2.3.8 (Apache-2.0), 서버에 포함
const FORMATS = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a'];

// 화면 전환으로 카메라를 빨리 끌 때 대체 라이브러리 안에서 생기는 무해한 오류는 무시
window.addEventListener('unhandledrejection', (e) => {
  if (/play\(\) request was interrupted|media was removed/i.test(e.reason?.message || '')) e.preventDefault();
});

export class ScanError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new ScanError('fallback', '대체 스캐너를 불러오지 못했어요. 새로고침해 주세요.'));
    document.head.appendChild(s);
  });
}

export function cameraPref() {
  try { return localStorage.getItem('cl_camera') || 'user'; } catch { return 'user'; }
}
export function setCameraPref(v) {
  try { localStorage.setItem('cl_camera', v); } catch {}
}

export class Scanner {
  // container: 영상이 들어갈 요소, onCode: (text) => void
  constructor(container, onCode) {
    this.container = container;
    this.onCode = onCode;
    this.running = false;
    this.last = { text: '', at: 0 };
  }

  emit(text) {
    const t = String(text || '').trim();
    if (!t) return;
    const now = Date.now();
    if (t === this.last.text && now - this.last.at < 2500) return; // 같은 코드 연속 인식 방지
    this.last = { text: t, at: now };
    feedback();
    this.onCode(t);
  }

  async start() {
    await this.stop();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new ScanError('insecure', '카메라는 보안 연결(https)에서만 쓸 수 있어요. 선생님께 주소를 확인해 달라고 해 주세요.');
    }
    this.running = true;
    const facing = cameraPref();
    let native = false;
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        native = supported.includes('qr_code');
      } catch { native = false; }
    }
    if (native) return this._startNative(facing);
    return this._startFallback(facing);
  }

  async _startNative(facing) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) { throw cameraError(e); }
    if (!this.running) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream;
    const video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.srcObject = stream;
    video.className = 'scan-video' + (facing === 'user' ? ' mirrored' : '');
    this.container.replaceChildren(video, frameOverlay());
    await video.play().catch(() => {});
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const detector = new window.BarcodeDetector({ formats: FORMATS.filter(f => supported.includes(f)) });
    const loop = async () => {
      if (!this.running) return;
      try {
        if (video.readyState >= 2) {
          const codes = await detector.detect(video);
          if (codes.length) this.emit(codes[0].rawValue);
        }
      } catch {}
      this.timer = setTimeout(loop, 180);
    };
    loop();
  }

  async _startFallback(facing) {
    await loadScript(FALLBACK_SRC);
    if (!this.running) return;
    const id = 'scan-' + Math.random().toString(36).slice(2);
    const box = document.createElement('div');
    box.id = id;
    box.className = 'scan-fallback' + (facing === 'user' ? ' mirrored' : '');
    this.container.replaceChildren(box, frameOverlay());
    this.h5 = new window.Html5Qrcode(id, { verbose: false });
    try {
      await this.h5.start({ facingMode: facing }, { fps: 8, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
        (text) => this.emit(text), () => {});
    } catch (e) {
      throw cameraError(e);
    }
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.h5) { try { await this.h5.stop(); } catch {} try { this.h5.clear(); } catch {} this.h5 = null; }
    this.container?.replaceChildren();
  }
}

function frameOverlay() {
  const d = document.createElement('div');
  d.className = 'scan-frame';
  d.setAttribute('aria-hidden', 'true');
  return d;
}

function cameraError(e) {
  const name = e?.name || String(e);
  if (/NotAllowed|Permission/i.test(name) || /permission/i.test(String(e))) {
    return new ScanError('denied', '카메라 사용이 막혀 있어요. 주소창 왼쪽의 자물쇠(사이트 설정) 버튼 → 카메라 → 허용을 누른 뒤 새로고침해 주세요.');
  }
  if (/NotFound|Overconstrained/i.test(name)) return new ScanError('nocamera', '카메라를 찾을 수 없어요. 카메라 연결을 확인하거나 아래 입력칸을 사용해 주세요.');
  if (/NotReadable/i.test(name)) return new ScanError('busy', '다른 프로그램이 카메라를 쓰고 있어요. 다른 창을 닫고 다시 해 주세요.');
  return new ScanError('unknown', '카메라를 켤 수 없어요. 새로고침해 보거나 아래 입력칸을 사용해 주세요.');
}

// 키보드처럼 입력하는 바코드 스캐너: 빠르게 입력된 문자열 + Enter 를 코드로 인식
export function listenKeyboardScanner(onCode) {
  let buf = '';
  let lastAt = 0;
  const handler = (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const now = Date.now();
    if (now - lastAt > 80) buf = '';
    lastAt = now;
    if (e.key === 'Enter') {
      if (buf.length >= 4) { feedback(); onCode(buf); }
      buf = '';
      return;
    }
    if (e.key.length === 1) buf += e.key;
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}

let audioCtx;
export function feedback(ok = true) {
  try { navigator.vibrate?.(ok ? 80 : [60, 60, 60]); } catch {}
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.setValueAtTime(0.12, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.2);
  } catch {}
}
