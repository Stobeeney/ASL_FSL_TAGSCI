/* ═══════════════════════════════════════════════════════════
   SignStudio AI — Main JS
   ═══════════════════════════════════════════════════════════ */

'use strict';

/* ── Emotion meta ── */
const EMOTIONS = [
  { name: 'Happy', color: '#ffdb4d' },
  { name: 'Sad', color: '#4da6ff' },
  { name: 'Neutral', color: '#9ca3b0' },
  { name: 'Angry', color: '#ff5a5a' },
  { name: 'Questioning', color: '#b06aff' },
  { name: 'Skeptical', color: '#39ff85' },
  { name: 'Surprised', color: '#ff9f43' },
];

/* ── Vocabulary — empty until user trains their own signs ── */
const FSL_MAP = {};
const GESTURE_HINTS = {};

/* ── Capture state ── */
let captureType = 'gesture';   // 'gesture' | 'motion'
let isRecording = false;
let motionBuffer = [];
const MAX_MOTION_FRAMES = 80;      // ~4 s at 20 Hz

/* ── App state ── */
let emotionPcts = new Array(EMOTIONS.length).fill(0);
let activeEmotion = 2;
let currentMode = 'ASL';
let phraseBuffer = [];
let sampleCount = 0;
let lastSign = '';
let wsRetryDelay = 1000;
let lastLandmarks = [];
let datasetCache = [];
let currentSort = { key: 'id', asc: false };

/* ── Hold-to-confirm state ── */
let pendingSign = '—';
let pendingAccumMs = 0;
let pendingLastTime = 0;
const HOLD_DURATION_MS = 1200; // ms the gesture must be held before output is confirmed

/* ── TTS state ── */
let voiceOutputEnabled = false;

/* ── Air Button state ── */
const AIR_BTN = { nx: 0.82, ny: 0.25, radius: 38, dwellMs: 1500 };
let airState = 'idle';      // 'idle' | 'dwelling_start' | 'recording' | 'dwelling_stop'
let airDwellAccum = 0;
let airDwellLast = 0;
let airSentence = [];
let airLastConfirmed = '—';

/* ── DOM refs ── */
const $ = id => document.getElementById(id);
const el = {
  emotionList: $('emotionList'),
  woWord: $('woWord'),
  woConf: $('woConf'),
  woBar: $('woBar'),
  fslBadge: $('fslBadge'),
  faceBox: $('faceBox'),
  faceLabel: $('faceLabel'),
  faceConf: $('faceConf'),
  signPill: $('signPill'),
  signPillText: $('signPillText'),
  signPillSub: $('signPillSub'),
  confPct: $('confPct'),
  confArc: $('confArcFill'),
  statFPS: $('statFPS'),
  statLM: $('statLM'),
  statFaces: $('statFaces'),
  statHands: $('statHands'),
  statSamples: $('statSamples'),
  phraseBuffer: $('phraseBuffer'),
  modeChip: $('modeChip'),
  feedResText: $('feedResText'),
  landmarkChip: $('landmarkChip'),
  topLandmarks: $('topLandmarks'),
  camDot: $('camDot'),
  camStatusText: $('camStatusText'),
  trainLabel: $('trainLabel'),
  captureBtn: $('captureBtn'),
  recIndicator: $('recIndicator'),
  recFrames: $('recFrames'),
  datasetTableBody: $('datasetTableBody'),
  datasetEmpty: $('datasetEmpty'),
  datasetCount: $('datasetCount'),
};

const viewport = document.querySelector('.camera-viewport');


/* ═══════════════════════════════════════
   TAB SWITCHING
   ═══════════════════════════════════════ */
let _datasetAutoRefresh = null;

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
    const panel = $(`panel-${tab}`);
    if (panel) panel.style.display = '';
    if (tab === 'dataset') {
      loadDataset();
      if (_datasetAutoRefresh) clearInterval(_datasetAutoRefresh);
      _datasetAutoRefresh = setInterval(loadDataset, 10000);
    } else {
      if (_datasetAutoRefresh) { clearInterval(_datasetAutoRefresh); _datasetAutoRefresh = null; }
    }
    if (tab === 'model') {
      loadModelStats();
      loadModelList();
    }
  });
});

/* ═══════════════════════════════════════
   MODEL TRAINING
   ═══════════════════════════════════════ */
async function loadModelStats() {
  try {
    const res = await fetch('/api/dataset/stats');
    const stats = await res.json();
    $('modelClassCount').textContent = stats.by_label.length;
    $('modelSampleCount').textContent = stats.total;

    const list = $('modelBreakdownList');
    if (stats.by_label.length === 0) {
      list.innerHTML = '<li class="mb-item">No samples captured yet. Go to the Live tab to start!</li>';
    } else {
      list.innerHTML = stats.by_label.map(s => `
        <li class="mb-item">
          <span class="mb-name">${s.label}</span>
          <span class="mb-count">${s.count} samples</span>
          <div class="mb-progress-wrap">
            <div class="mb-progress" style="width: ${Math.min(100, (s.count / 20) * 100)}%; background: ${s.count >= 10 ? '#39ff85' : '#ffb700'}"></div>
          </div>
          <span class="mb-hint">${s.count >= 10 ? '✓ Ready' : 'Need more'}</span>
        </li>
      `).join('');
    }
  } catch (e) {
    console.warn('Failed to load model stats');
  }
}

async function loadModelList() {
  const list = $('savedModelsList');
  if (!list) return;
  list.innerHTML = '<li class="mb-item">Scanning...</li>';
  try {
    const res = await fetch('/api/models/list');
    const data = await res.json();
    if (data.models.length === 0) {
      list.innerHTML = '<li class="mb-item">No saved models found.</li>';
      return;
    }
    list.innerHTML = data.models.map(m => `
       <li class="mb-item ${m === data.current ? 'active-model' : ''}" style="border-left: 3px solid ${m === data.current ? '#39ff85' : 'transparent'}; padding-left: 10px;">
          <div style="display:flex; justify-content: space-between; align-items: center; width:100%;">
             <span class="mb-name">${m} ${m === data.current ? '<small>(Active)</small>' : ''}</span>
             <div style="display:flex; gap:5px;">
                <button class="dt-play" onclick="activateModel('${m}')" title="Load Model">⚡</button>
                ${m !== 'gesture_model.pkl' ? `<button class="dt-del" onclick="deleteModel('${m}')" title="Delete">✕</button>` : ''}
             </div>
          </div>
       </li>
    `).join('');
  } catch (e) {
    list.innerHTML = '<li class="mb-item">Failed to load models.</li>';
  }
}

async function activateModel(name) {
  try {
    const res = await fetch('/api/models/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.ok) {
      alert(`Model loaded: ${name}`);
      loadModelList();
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (e) {
    alert('Server error loading model');
  }
}

async function deleteModel(name) {
  if (!confirm(`Delete model "${name}"?`)) return;
  try {
    const res = await fetch('/api/models/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.ok) {
      loadModelList();
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (e) {
    alert('Server error deleting model');
  }
}

async function trainModel() {
  const btn = $('trainBtn');
  const text = $('trainBtnText');
  const log = $('modelLog');
  const progress = $('trainProgress');
  const modelName = $('modelNameInput').value.trim() || 'gesture_model.pkl';

  btn.disabled = true;
  text.textContent = 'Training...';
  progress.style.display = 'block';
  log.innerHTML = `<div class="ml-entry ml-entry--info">Preparing dataset for training "${modelName}"...</div>`;

  try {
    const res = await fetch('/api/train', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_name: modelName })
    });
    const json = await res.json();

    progress.style.display = 'none';
    if (json.ok) {
      log.innerHTML += `<div class="ml-entry ml-entry--success">Success: ${json.message}</div>`;
      log.innerHTML += `<div class="ml-entry">Model saved as ${json.model_name}</div>`;
      text.textContent = 'Retrain Model';
      $('modelStatus').textContent = 'Active';
      $('modelStatus').style.color = '#39ff85';
      loadModelList();
    } else {
      log.innerHTML += `<div class="ml-entry ml-entry--err">Error: ${json.message}</div>`;
      text.textContent = 'Try Again';
      $('modelStatus').textContent = 'Error';
      $('modelStatus').style.color = '#ff5a5a';
    }
  } catch (e) {
    log.innerHTML += `<div class="ml-entry ml-entry--err">Server connection failed.</div>`;
    text.textContent = 'Retry';
  } finally {
    btn.disabled = false;
  }
}


/* ═══════════════════════════════════════
   EMOTION LIST
   ═══════════════════════════════════════ */
function renderEmotions() {
  el.emotionList.innerHTML = EMOTIONS.map((e, i) => `
    <li class="emotion-item ${i === activeEmotion ? 'active' : ''}"
        onclick="selectEmotion(${i})">
      <div class="e-dot" style="background:${e.color};box-shadow:0 0 5px ${e.color}55;"></div>
      <span class="e-name">${e.name}</span>
      <span class="e-pct">${emotionPcts[i]}%</span>
      <div class="e-bar-wrap">
        <div class="e-bar" style="width:${emotionPcts[i]}%;background:${e.color};"></div>
      </div>
    </li>
  `).join('');
}

function selectEmotion(i) {
  activeEmotion = i;
  el.faceLabel.textContent = EMOTIONS[i].name;
  renderEmotions();
}


/* ═══════════════════════════════════════
   CONFIDENCE ARC
   ═══════════════════════════════════════ */
function setConfidence(pct) {
  el.confArc.setAttribute('stroke-dasharray', `${(pct / 100) * 100} 100`);
  el.confPct.textContent = `${Math.round(pct)}%`;
}


/* ═══════════════════════════════════════
   FACE BOX
   ═══════════════════════════════════════ */
function updateFaceBox(bbox, emotion, conf) {
  if (!bbox) { el.faceBox.style.display = 'none'; return; }
  const W = viewport.clientWidth;
  const H = viewport.clientHeight;
  el.faceBox.style.cssText = `
    display:block;
    left:${bbox.x * W}px; top:${bbox.y * H}px;
    width:${bbox.w * W}px; height:${bbox.h * H}px;
    transform:none;
  `;
  el.faceLabel.textContent = emotion;
  el.faceConf.textContent = `conf: ${conf.toFixed(2)}`;
}


/* ═══════════════════════════════════════
   WEBSOCKET PAYLOAD → UI
   ═══════════════════════════════════════ */
function applyPayload(data) {
  const hands = data.hands_detected || 0;
  const lmCount = 21 * hands;
  const fps = data.fps || 0;
  const camW = data.cam_w || 0;
  const camH = data.cam_h || 0;

  lastLandmarks = data.landmarks || [];

  /* buffer motion frames while recording */
  if (isRecording && lastLandmarks.length) {
    motionBuffer.push(lastLandmarks);
    el.recFrames.textContent = `${motionBuffer.length} / ${MAX_MOTION_FRAMES} frames`;
    if (motionBuffer.length >= MAX_MOTION_FRAMES) stopMotionRecording();
  }

  el.statFPS.textContent = fps;
  el.statLM.textContent = lmCount;
  el.statHands.textContent = `${hands} / 2`;
  el.statFaces.textContent = data.face_bbox ? '1' : '0';
  el.topLandmarks.textContent = `${lmCount} LANDMARKS`;
  el.landmarkChip.textContent = lmCount ? `${lmCount} landmarks · active` : '0 landmarks · waiting';
  el.feedResText.textContent = camW ? `${camW} × ${camH} · ${fps}fps` : '— · —fps';

  if (data.cam_ok) {
    el.camDot.className = 'dot dot--green';
    el.camStatusText.textContent = 'WEBCAM ACTIVE';
  } else {
    el.camDot.className = 'dot dot--red blink';
    el.camStatusText.textContent = 'NO CAMERA';
  }

  updateFaceBox(data.face_bbox, data.emotion, data.emotion_conf);

  const eIdx = EMOTIONS.findIndex(e => e.name === data.emotion);
  if (eIdx !== -1 && eIdx !== activeEmotion) {
    activeEmotion = eIdx;
    emotionPcts = EMOTIONS.map((_, i) =>
      i === eIdx ? Math.round(data.emotion_conf * 100) : Math.round(Math.random() * 4)
    );
    renderEmotions();
  }

  const sign = data.sign || '—';
  const confPct = Math.round((data.sign_conf || 0) * 100);
  if (sign !== lastSign) {
    lastSign = sign;
    el.woWord.textContent = sign;
    el.woWord.classList.remove('flash');
    void el.woWord.offsetWidth;
    el.woWord.classList.add('flash');

    const confPct = Math.round((data.sign_conf || 0) * 100);
    el.woConf.textContent = sign !== '—' ? `${confPct}% confidence` : 'waiting…';
    el.woBar.style.width = `${confPct}%`;
    el.fslBadge.textContent = sign !== '—' ? `FSL: ${FSL_MAP[sign] || sign}` : 'FSL: —';
    setConfidence(confPct);

    if (sign !== '—') {
      el.signPill.style.display = 'flex';
      el.signPillText.textContent = sign;
      el.signPillSub.textContent = GESTURE_HINTS[sign] || 'gesture detected';

      phraseBuffer.push(sign);
      if (phraseBuffer.length > 8) phraseBuffer.shift();
      el.phraseBuffer.textContent = phraseBuffer.join(' · ');

      runLLM();
      speakSign(sign);

      sampleCount++;
      el.statSamples.textContent = sampleCount;
    } else {
      el.signPill.style.display = 'none';
    }
  }

  // ── Hold-progress indicator ──
  const pending = data.pendingSign || '—';
  const holdPct = (data.holdProgress || 0) * 100;
  const woHold = $('woHold');
  if (pending !== '—' && pending !== sign) {
    woHold.style.display = 'flex';
    $('woHoldSign').textContent = pending;
    $('woHoldBar').style.width = `${holdPct.toFixed(1)}%`;
  } else {
    woHold.style.display = 'none';
  }
}


/* ═══════════════════════════════════════
   MEDIAPIPE CLIENT-SIDE TRACKING
   ═══════════════════════════════════════ */
const videoElement = $('inputVideo');
const canvasElement = $('outputCanvas');
const canvasCtx = canvasElement.getContext('2d');

let hands = null;
let faceMesh = null;
let camera = null;

let localState = {
  landmarks: [],
  hand_labels: [],
  face_bbox: null,
  emotion: "Neutral",
  emotion_conf: 0.90,
  sign: "—",
  sign_conf: 0.0,
  pendingSign: '—',
  holdProgress: 0,
  fps: 0,
  hands_detected: 0,
  cam_w: 640,
  cam_h: 480,
  cam_ok: false
};

let lastFrameTime = 0;
let frameCount = 0;

/* ═══════════════════════════════════════
   AIR BUTTON
   ═══════════════════════════════════════ */
function updateAirButton(handLandmarks) {
  const cw = canvasElement.width;
  const ch = canvasElement.height;
  const bx = AIR_BTN.nx * cw;
  const by = AIR_BTN.ny * ch;
  const now = performance.now();

  // Index finger tip = landmark 8
  let hovering = false;
  if (handLandmarks && handLandmarks[8]) {
    const fx = handLandmarks[8].x * cw;
    const fy = handLandmarks[8].y * ch;
    hovering = Math.hypot(fx - bx, fy - by) < AIR_BTN.radius;
  }

  // Dwell timer
  if (hovering) {
    if (airDwellLast > 0) airDwellAccum += now - airDwellLast;
    airDwellLast = now;
  } else {
    airDwellAccum = 0;
    airDwellLast = 0;
  }
  const dwellPct = Math.min(airDwellAccum / AIR_BTN.dwellMs, 1.0);

  // State transitions on full dwell
  if (dwellPct >= 1.0) {
    airDwellAccum = 0;
    if (airState === 'idle' || airState === 'dwelling_start') {
      airState = 'recording';
      airSentence = [];
      airLastConfirmed = '—';
      showAirOverlay('');
    } else if (airState === 'recording' || airState === 'dwelling_stop') {
      const sentence = airSentence.join(' ');
      airState = 'idle';
      speakAirSentence(sentence);
      showAirOverlay(sentence, true);
    }
  } else {
    if (hovering) {
      if (airState === 'idle') airState = 'dwelling_start';
      else if (airState === 'recording') airState = 'dwelling_stop';
    } else {
      if (airState === 'dwelling_start') airState = 'idle';
      else if (airState === 'dwelling_stop') airState = 'recording';
    }
  }

  // Collect confirmed signs while recording
  if (airState === 'recording' || airState === 'dwelling_stop') {
    const s = localState.sign;
    if (s !== '—' && s !== airLastConfirmed) {
      airSentence.push(s);
      airLastConfirmed = s;
      showAirOverlay(airSentence.join(' '));
    }
  }

  drawAirButton(bx, by, dwellPct, hovering);
}

function drawAirButton(bx, by, dwellPct, hovering) {
  const ctx = canvasCtx;
  const r = AIR_BTN.radius;
  const isRec = airState === 'recording' || airState === 'dwelling_stop';

  ctx.save();

  // Outer glow
  if (hovering) {
    const glow = ctx.createRadialGradient(bx, by, r, bx, by, r + 20);
    glow.addColorStop(0, isRec ? 'rgba(255,60,60,0.4)' : 'rgba(0,245,212,0.3)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(bx, by, r + 20, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
  }

  // Button fill
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.fillStyle = isRec ? 'rgba(220,40,40,0.85)' : 'rgba(0,20,18,0.75)';
  ctx.fill();
  ctx.strokeStyle = isRec ? '#ff4444' : '#00f5d4';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Dwell arc
  if (dwellPct > 0 && dwellPct < 1) {
    ctx.beginPath();
    ctx.arc(bx, by, r + 7, -Math.PI / 2, -Math.PI / 2 + dwellPct * Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Icon
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(r * 0.55)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isRec ? '■' : '▶', bx, by);

  // Label below button
  ctx.font = `bold 11px sans-serif`;
  ctx.fillStyle = isRec ? '#ff9999' : '#00f5d4';
  ctx.fillText(isRec ? 'HOVER TO STOP' : 'HOVER TO START', bx, by + r + 14);

  // Sentence preview above button
  if ((airState === 'recording' || airState === 'dwelling_stop') && airSentence.length > 0) {
    const text = airSentence.join(' · ');
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#00f5d4';
    const maxW = 200;
    ctx.fillText(text.length > 22 ? '…' + text.slice(-20) : text, bx, by - r - 14);
  }

  ctx.restore();
}

function showAirOverlay(text, isFinal = false) {
  let el = $('airSentenceOverlay');
  if (!el) return;
  el.textContent = text ? (isFinal ? `"${text}"` : text) : '';
  el.style.display = text ? 'block' : 'none';
  el.style.color = isFinal ? '#ffdb4d' : '#00f5d4';
  if (isFinal) setTimeout(() => { if (el) el.style.display = 'none'; }, 5000);
}

function speakAirSentence(sentence) {
  if (!sentence) return;
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(sentence.toLowerCase());
    utt.rate = 0.85;
    utt.pitch = 1.0;
    window.speechSynthesis.speak(utt);
  }
}

function onResults(results) {
  frameCount++;
  const now = performance.now();
  if (now - lastFrameTime >= 1000) {
    localState.fps = frameCount;
    frameCount = 0;
    lastFrameTime = now;
  }

  localState.cam_w = canvasElement.width = videoElement.videoWidth;
  localState.cam_h = canvasElement.height = videoElement.videoHeight;

  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  
  // Draw video frame
  canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

  // Draw Grid Overlay
  canvasCtx.strokeStyle = 'rgba(10, 35, 15, 0.35)';
  canvasCtx.lineWidth = 1;
  for (let x = 0; x < canvasElement.width; x += 60) {
    canvasCtx.beginPath(); canvasCtx.moveTo(x, 0); canvasCtx.lineTo(x, canvasElement.height); canvasCtx.stroke();
  }
  for (let y = 0; y < canvasElement.height; y += 60) {
    canvasCtx.beginPath(); canvasCtx.moveTo(0, y); canvasCtx.lineTo(canvasElement.width, y); canvasCtx.stroke();
  }

  localState.landmarks = [];
  localState.hand_labels = [];
  localState.hands_detected = 0;

  if (results.multiHandLandmarks) {
    localState.hands_detected = results.multiHandLandmarks.length;
    for (let i = 0; i < results.multiHandLandmarks.length; i++) {
      const landmarks = results.multiHandLandmarks[i];
      localState.landmarks.push(landmarks);
      const label = results.multiHandedness[i].label;
      localState.hand_labels.push(label);

      drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {color: '#00f5d4', lineWidth: 2});
      drawLandmarks(canvasCtx, landmarks, {color: '#ffffff', lineWidth: 1, radius: 3});
    }
    
    // Send to backend for classification if we have landmarks
    if (localState.landmarks.length > 0) {
        classifyLandmarks(localState.landmarks[0]);
    } else {
        updateSign("—", 0);
    }
  } else {
      updateSign("—", 0);
  }

  applyPayload(localState);
  updateAirButton(localState.landmarks.length > 0 ? localState.landmarks[0] : null);
  canvasCtx.restore();
}

function onFaceResults(results) {
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        
        // Face BBox calculation
        const xs = landmarks.map(l => l.x);
        const ys = landmarks.map(l => l.y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const padX = (maxX - minX) * 0.06;
        const padY = (maxY - minY) * 0.06;
        
        localState.face_bbox = {
            x: Math.max(0, minX - padX),
            y: Math.max(0, minY - padY),
            w: Math.min(1 - minX, maxX - minX + 2 * padX),
            h: Math.min(1 - minY, maxY - minY + 2 * padY)
        };

        // Emotion detection
        const {emotion, conf} = detectEmotion(landmarks);
        localState.emotion = emotion;
        localState.emotion_conf = conf;

        // Draw face mesh (optional, low opacity)
        canvasCtx.globalAlpha = 0.18;
        drawConnectors(canvasCtx, landmarks, FACEMESH_CONTOURS, {color: '#00f5d4', lineWidth: 1});
        canvasCtx.globalAlpha = 1.0;
    } else {
        localState.face_bbox = null;
        localState.emotion = "Neutral";
        localState.emotion_conf = 0.90;
    }
}

function detectEmotion(lm) {
    const lip_center_y = (lm[13].y + lm[14].y) / 2;
    const corners_avg_y = (lm[61].y + lm[291].y) / 2;
    const mouth_curve = lip_center_y - corners_avg_y;
    const mouth_open = Math.abs(lm[14].y - lm[13].y);

    const l_open = Math.abs(lm[145].y - lm[159].y);
    const r_open = Math.abs(lm[374].y - lm[386].y);
    const eye_open = (l_open + r_open) / 2;

    const l_brow_h = lm[159].y - lm[105].y;
    const r_brow_h = lm[386].y - lm[334].y;
    const brow_raise = (l_brow_h + r_brow_h) / 2;
    const brow_asym = Math.abs(l_brow_h - r_brow_h);

    if (mouth_curve > 0.018 && mouth_open < 0.07) return {emotion: "Happy", conf: Math.min(0.70 + mouth_curve * 12, 0.96)};
    if (mouth_open > 0.08 && brow_raise > 0.07) return {emotion: "Surprised", conf: 0.83};
    if (mouth_curve < -0.012 && brow_raise < 0.055) return {emotion: "Angry", conf: Math.min(0.65 + Math.abs(mouth_curve) * 10, 0.90)};
    if (mouth_curve < -0.010) return {emotion: "Sad", conf: Math.min(0.62 + Math.abs(mouth_curve) * 10, 0.88)};
    if (brow_asym > 0.013) return {emotion: "Questioning", conf: Math.min(0.62 + brow_asym * 12, 0.85)};
    if (brow_raise < 0.042) return {emotion: "Skeptical", conf: 0.74};
    return {emotion: "Neutral", conf: 0.90};
}

let lastClassifyTime = 0;
async function classifyLandmarks(landmarks) {
    const now = performance.now();
    if (now - lastClassifyTime < 100) return; // Limit to 10Hz
    lastClassifyTime = now;

    try {
        const res = await fetch('/api/classify', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({landmarks})
        });
        const data = await res.json();
        if (data.ok) {
            updateSign(data.sign, data.conf);
        }
    } catch (e) {
        console.warn("Classification failed", e);
    }
}

function updateSign(sign, conf) {
    const now = performance.now();
    localState.sign_conf = conf;

    if (sign === '—') {
        // Hand not visible — pause accumulation without resetting pendingSign
        pendingLastTime = 0;
        localState.pendingSign = pendingSign;
        localState.holdProgress = pendingSign !== '—'
            ? Math.min(pendingAccumMs / HOLD_DURATION_MS, 1.0) : 0;
        return;
    }

    if (sign !== pendingSign) {
        // Different sign — restart the hold timer
        pendingSign = sign;
        pendingAccumMs = 0;
    }

    if (pendingLastTime > 0) {
        pendingAccumMs += now - pendingLastTime;
    }
    pendingLastTime = now;

    localState.pendingSign = sign;
    localState.holdProgress = Math.min(pendingAccumMs / HOLD_DURATION_MS, 1.0);

    // Confirm once the gesture has been held long enough
    if (pendingAccumMs >= HOLD_DURATION_MS && localState.sign !== sign) {
        localState.sign = sign;
        pendingAccumMs = 0; // Reset bar so it's ready for the next gesture
    }
}

function initMediaPipe() {
  hands = new Hands({locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
  hands.onResults(onResults);

  faceMesh = new FaceMesh({locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`});
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
  faceMesh.onResults(onFaceResults);

  camera = new Camera(videoElement, {
    onFrame: async () => {
      await hands.send({image: videoElement});
      await faceMesh.send({image: videoElement});
    },
    width: 640,
    height: 480
  });
  camera.start().then(() => {
      localState.cam_ok = true;
      el.camStatusText.textContent = 'WEBCAM ACTIVE';
      el.camDot.className = 'dot dot--green';
  }).catch(err => {
      console.error('[Camera] Failed to start:', err);
      el.camStatusText.textContent = 'CAM ERROR';
      el.camDot.className = 'dot dot--red blink';
  });
}

/* ═══════════════════════════════════════
   WEBSOCKET (REPLACED BY LOCAL TRACKING)
   ═══════════════════════════════════════ */
function connectWS() {
  // Websocket logic removed in favor of client-side MediaPipe
  initMediaPipe();
}


/* ═══════════════════════════════════════
   PANEL TOGGLES
   ═══════════════════════════════════════ */
function togglePanel(id, checkbox) {
  const isOn = checkbox.checked;
  $(id).classList.toggle('on', isOn);
  if (id === 'panelLLM') {
    $('llmBox').style.display = isOn ? 'block' : 'none';
    if (isOn) runLLM();
  }
  if (id === 'panelVoice') {
    voiceOutputEnabled = isOn;
    if (isOn && !window.speechSynthesis) {
      alert('Text-to-speech is not supported in this browser.');
      checkbox.checked = false;
      voiceOutputEnabled = false;
      $(id).classList.remove('on');
    }
  }
}

function speakSign(sign) {
  if (!voiceOutputEnabled || !window.speechSynthesis || !sign || sign === '—') return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(sign.toLowerCase());
  utt.rate = 0.9;
  utt.pitch = 1.0;
  window.speechSynthesis.speak(utt);
}

async function runLLM() {
  const panel = $('panelLLM');
  if (!panel || !panel.classList.contains('on')) return;

  if (!phraseBuffer.length) {
    $('llmText').textContent = 'Waiting for signs...';
    return;
  }

  // Don't re-run if already thinking
  if ($('llmText').textContent === 'Thinking...') return;

  const apiKey = ($('llmApiKey') ? $('llmApiKey').value.trim() : '');
  if (!apiKey) {
    $('llmText').textContent = '⚠ Enter your Anthropic API key above to enable AI interpretation.';
    return;
  }

  $('llmText').textContent = 'Thinking...';

  try {
    const res = await fetch('/api/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signs: phraseBuffer, api_key: apiKey })
    });
    const data = await res.json();
    if (data.ok) {
      $('llmText').textContent = '💬 ' + data.interpretation;
    } else {
      $('llmText').textContent = '⚠ Error: ' + data.error;
    }
  } catch (e) {
    $('llmText').textContent = '⚠ Could not reach server.';
  }
}


/* ═══════════════════════════════════════
   MODE SWITCH
   ═══════════════════════════════════════ */
function setMode(mode) {
  currentMode = mode;
  $('modeASL').classList.toggle('active', mode === 'ASL');
  $('modeFSL').classList.toggle('active', mode === 'FSL');
  el.modeChip.textContent = `${mode} Mode · Live`;
}


/* ═══════════════════════════════════════
   CAPTURE TYPE (gesture / motion)
   ═══════════════════════════════════════ */
function setCaptureType(type) {
  captureType = type;
  $('typeGesture').classList.toggle('active', type === 'gesture');
  $('typeMotion').classList.toggle('active', type === 'motion');
  el.captureBtn.textContent = type === 'motion' ? 'Start Recording' : 'Capture Gesture';
  el.captureBtn.className = type === 'motion'
    ? 'pb-btn pb-btn--motion'
    : 'pb-btn pb-btn--capture';
  if (type === 'gesture') {
    el.recIndicator.style.display = 'none';
    isRecording = false;
    motionBuffer = [];
  }
}


/* ═══════════════════════════════════════
   GESTURE CAPTURE
   ═══════════════════════════════════════ */
async function handleCapture() {
  if (captureType === 'motion') {
    isRecording ? stopMotionRecording() : startMotionRecording();
  } else {
    await captureGesture();
  }
}

function startMotionRecording() {
  const label = el.trainLabel.value.trim().toUpperCase();
  if (!label) {
    flashInput('Enter a label first!');
    return;
  }
  isRecording = true;
  motionBuffer = [];
  el.captureBtn.textContent = 'Stop & Save';
  el.captureBtn.className = 'pb-btn pb-btn--stop';
  el.recIndicator.style.display = 'flex';
  el.recFrames.textContent = `0 / ${MAX_MOTION_FRAMES} frames`;
}

async function stopMotionRecording() {
  isRecording = false;
  el.captureBtn.textContent = 'Start Recording';
  el.captureBtn.className = 'pb-btn pb-btn--motion';
  el.recIndicator.style.display = 'none';

  if (!motionBuffer.length) return;
  const label = el.trainLabel.value.trim().toUpperCase();
  if (!label) { flashInput('Enter a label first!'); motionBuffer = []; return; }
  await saveSample(label, 'motion', motionBuffer);
  motionBuffer = [];
}

async function captureGesture() {
  const label = el.trainLabel.value.trim().toUpperCase();
  if (!label) { flashInput('Enter a label first!'); return; }
  if (!lastLandmarks.length) {
    flashBtn('No hand detected!');
    return;
  }
  await saveSample(label, 'gesture', lastLandmarks);
}

async function saveSample(label, type, landmarks) {
  try {
    const res = await fetch('/api/dataset/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, mode: currentMode, capture_type: type, landmarks }),
    });
    const json = await res.json();
    if (json.ok) {
      sampleCount++;
      el.statSamples.textContent = sampleCount;
      flashBtn(`✓ Saved "${label}"`, '#39ff85');

      // Update UI feedback for the captured gesture
      el.woWord.textContent = label;
      el.woWord.classList.remove('flash');
      void el.woWord.offsetWidth;
      el.woWord.classList.add('flash');
      el.woConf.textContent = 'Captured & Saved';
      el.woBar.style.width = '100%';
      el.fslBadge.textContent = `FSL: ${FSL_MAP[label] || label}`;

      el.signPill.style.display = 'flex';
      el.signPillText.textContent = label;
      el.signPillSub.textContent = 'sample captured';

      if (phraseBuffer[phraseBuffer.length - 1] !== label) {
        phraseBuffer.push(label);
        if (phraseBuffer.length > 6) phraseBuffer.shift();
        el.phraseBuffer.textContent = phraseBuffer.join(' · ');
      }
    }
  } catch {
    flashBtn('Server unavailable');
  }
}

function flashInput(msg) {
  const orig = el.trainLabel.placeholder;
  el.trainLabel.placeholder = msg;
  el.trainLabel.focus();
  setTimeout(() => { el.trainLabel.placeholder = orig; }, 2000);
}

function flashBtn(msg, color = '') {
  const orig = el.captureBtn.textContent;
  const origC = el.captureBtn.style.color;
  el.captureBtn.textContent = msg;
  el.captureBtn.style.color = color;
  setTimeout(() => {
    el.captureBtn.textContent = orig;
    el.captureBtn.style.color = origC;
  }, 2000);
}


/* ═══════════════════════════════════════
   PHRASE BUILDER
   ═══════════════════════════════════════ */
function clearPhrase() {
  phraseBuffer = [];
  el.phraseBuffer.textContent = '—';
}

async function savePhrase() {
  if (!phraseBuffer.length) return;
  const phrase = phraseBuffer.join(' · ');
  try {
    const res = await fetch('/api/dataset/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: phrase, mode: currentMode, capture_type: 'gesture', landmarks: [] }),
    });
    const json = await res.json();
    if (json.ok) alert(`Saved to dataset:\n"${phrase}"`);
  } catch {
    alert(`Saved locally (server unavailable):\n"${phrase}"`);
  }
}


/* ═══════════════════════════════════════
   DATASET VIEW
   ═══════════════════════════════════════ */
async function loadDataset() {
  try {
    const res = await fetch('/api/dataset/list');
    datasetCache = await res.json();
    renderDataset();
  } catch (e) {
    el.datasetTableBody.innerHTML = '<tr><td colspan="7" class="dt-err">Could not load dataset.</td></tr>';
  }
}

function renderDataset(data = null) {
  const rows = data || datasetCache;
  el.datasetCount.textContent = `${rows.length} sample${rows.length !== 1 ? 's' : ''}`;
  if (!rows.length) {
    el.datasetEmpty.style.display = '';
    el.datasetTableBody.innerHTML = '';
    return;
  }
  el.datasetEmpty.style.display = 'none';
  el.datasetTableBody.innerHTML = rows.map(r => `
    <tr>
      <td class="dt-id">#${r.id}</td>
      <td class="dt-label">${r.label}</td>
      <td><span class="dt-badge dt-badge--${r.mode.toLowerCase()}">${r.mode}</span></td>
      <td><span class="dt-badge dt-badge--${r.type}">${r.type}</span></td>
      <td class="dt-num">${r.frames}</td>
      <td class="dt-time">${r.created_at}</td>
      <td style="display:flex;gap:4px;">
        <button class="dt-play" onclick="openPlayback(${r.id}, '${r.label}', '${r.type}', ${r.frames})" title="Play">▶</button>
        <button class="dt-del" onclick="deleteSample(${r.id}, this)" title="Delete">✕</button>
      </td>
    </tr>
  `).join('');
}

function filterDataset() {
  const query = $('datasetSearch').value.toLowerCase();
  const filtered = datasetCache.filter(r => r.label.toLowerCase().includes(query));
  renderDataset(filtered);
}

function sortDataset(key) {
  if (currentSort.key === key) {
    currentSort.asc = !currentSort.asc;
  } else {
    currentSort.key = key;
    currentSort.asc = true;
  }

  datasetCache.sort((a, b) => {
    let valA = a[key];
    let valB = b[key];
    if (typeof valA === 'string') {
      valA = valA.toLowerCase();
      valB = valB.toLowerCase();
    }
    if (valA < valB) return currentSort.asc ? -1 : 1;
    if (valA > valB) return currentSort.asc ? 1 : -1;
    return 0;
  });

  renderDataset();
}

async function deleteAllSamples() {
  if (!confirm('Are you sure you want to delete ALL samples? This cannot be undone.')) return;
  try {
    const res = await fetch('/api/dataset/delete_all', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      datasetCache = [];
      renderDataset();
    }
  } catch (e) {
    alert('Failed to delete samples');
  }
}

async function deleteSample(id, btn) {
  btn.disabled = true;
  try {
    await fetch(`/api/dataset/delete/${id}`, { method: 'DELETE' });
    btn.closest('tr').remove();
    const count = el.datasetTableBody.querySelectorAll('tr').length;
    el.datasetCount.textContent = `${count} sample${count !== 1 ? 's' : ''}`;
    if (!count) el.datasetEmpty.style.display = '';
  } catch {
    btn.disabled = false;
  }
}

async function exportDataset() {
  try {
    const res = await fetch('/api/dataset/export');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `signstudy_dataset_${Date.now()}.json`;
    a.click();
  } catch {
    alert('Export failed — server unavailable.');
  }
}

async function importDataset(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  try {
    const text = await file.text();
    const records = JSON.parse(text);
    if (!Array.isArray(records) || records.length === 0) {
      alert('Invalid dataset file — expected a JSON array of records.');
      return;
    }

    const CHUNK_SIZE = 20;
    let totalImported = 0;
    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE);
      const res = await fetch('/api/dataset/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk)
      });
      const data = await res.json();
      if (!data.ok) {
        alert(`Import failed at batch ${Math.floor(i / CHUNK_SIZE) + 1}: ` + (data.error || 'unknown error'));
        return;
      }
      totalImported += data.imported;
    }

    alert(`Imported ${totalImported} record${totalImported !== 1 ? 's' : ''} successfully.`);
    loadDataset();
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
}


/* ═══════════════════════════════════════
   DATASET PLAYBACK ENGINE
   ═══════════════════════════════════════ */

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];
const TIP_IDS = new Set([4, 8, 12, 16, 20]);
const CYAN_COLOR = 'rgba(0,245,212,0.90)';
const WHITE_COLOR = '#ffffff';
const DIM_COLOR = 'rgba(0,245,212,0.45)';

let pbSample = null;   // full sample object from API
let pbFrameIdx = 0;
let pbPlaying = false;
let pbTimer = null;
const PB_FPS = 20;     // replay frame rate (ms)

const pbCanvas = document.getElementById('pbCanvas');
const pbCtx = pbCanvas ? pbCanvas.getContext('2d') : null;
const pbPlayBtn = document.getElementById('pbPlayBtn');
const pbFrameCounter = document.getElementById('pbFrameCounter');
const pbScrub = document.getElementById('pbScrub');
const pbLabel = document.getElementById('pbLabel');
const pbMeta = document.getElementById('pbMeta');
const dvPlayback = document.getElementById('dvPlayback');

function resizePbCanvas() {
  if (!pbCanvas) return;
  const wrap = pbCanvas.parentElement;
  pbCanvas.width = wrap.clientWidth || 480;
  pbCanvas.height = wrap.clientHeight || 300;
}

function drawHandOnCanvas(ctx, landmarks, w, h) {
  if (!landmarks || !landmarks.length) return;
  // landmarks is one hand: array of 21 {x,y,z}
  const pts = landmarks.map(lm => [lm.x * w, lm.y * h]);

  // bones
  ctx.strokeStyle = CYAN_COLOR;
  ctx.lineWidth = 1.5;
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(pts[a][0], pts[a][1]);
    ctx.lineTo(pts[b][0], pts[b][1]);
    ctx.stroke();
  }

  // joints
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i];
    ctx.beginPath();
    if (TIP_IDS.has(i)) {
      ctx.arc(px, py, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = WHITE_COLOR;
      ctx.fill();
      ctx.strokeStyle = CYAN_COLOR;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (i === 0) {
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = CYAN_COLOR;
      ctx.fill();
    } else {
      ctx.arc(px, py, 2.8, 0, Math.PI * 2);
      ctx.fillStyle = CYAN_COLOR;
      ctx.fill();
    }
  }
}

function renderPbFrame(idx) {
  if (!pbSample || !pbCtx) return;
  const w = pbCanvas.width;
  const h = pbCanvas.height;

  // background
  pbCtx.fillStyle = '#080a0f';
  pbCtx.fillRect(0, 0, w, h);

  // subtle grid
  pbCtx.strokeStyle = 'rgba(0,245,212,0.04)';
  pbCtx.lineWidth = 1;
  for (let x = 0; x < w; x += 60) {
    pbCtx.beginPath(); pbCtx.moveTo(x, 0); pbCtx.lineTo(x, h); pbCtx.stroke();
  }
  for (let y = 0; y < h; y += 60) {
    pbCtx.beginPath(); pbCtx.moveTo(0, y); pbCtx.lineTo(w, y); pbCtx.stroke();
  }

  // corner brackets
  const bLen = 18, bW = 2;
  pbCtx.strokeStyle = 'rgba(0,245,212,0.55)';
  pbCtx.lineWidth = bW;
  [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]].forEach(([cx, cy, dx, dy]) => {
    pbCtx.beginPath(); pbCtx.moveTo(cx + dx * bLen, cy); pbCtx.lineTo(cx, cy); pbCtx.lineTo(cx, cy + dy * bLen); pbCtx.stroke();
  });

  const frames = pbSample.type === 'motion' ? pbSample.landmarks : [pbSample.landmarks];
  const frame = frames[idx] || [];

  // for gesture, frame is array of hands; for motion, each frame is array of hands
  const hands = Array.isArray(frame[0]) ? frame : [frame];
  hands.forEach(hand => { if (hand && hand.length) drawHandOnCanvas(pbCtx, hand, w, h); });

  // frame counter HUD
  const total = frames.length;
  pbCtx.fillStyle = 'rgba(0,245,212,0.75)';
  pbCtx.font = '700 11px "Space Mono", monospace';
  pbCtx.fillText(`FRAME ${idx + 1} / ${total}`, 14, h - 14);

  // label
  pbCtx.fillStyle = 'rgba(0,245,212,0.9)';
  pbCtx.font = '800 18px "Syne", sans-serif';
  pbCtx.fillText(pbSample.label, 14, 30);

  // update UI
  if (pbFrameCounter) pbFrameCounter.textContent = `${idx + 1} / ${total}`;
  if (pbScrub) pbScrub.value = idx;
}

async function openPlayback(id, label, type, frames) {
  if (pbTimer) { clearInterval(pbTimer); pbTimer = null; }
  pbPlaying = false;
  pbFrameIdx = 0;
  if (pbPlayBtn) pbPlayBtn.textContent = '▶ Play';
  if (dvPlayback) dvPlayback.style.display = '';

  if (pbLabel) pbLabel.textContent = label;
  if (pbMeta) pbMeta.textContent = `${type} · ${frames} frame${frames !== 1 ? 's' : ''}`;
  if (pbScrub) { pbScrub.max = Math.max(0, frames - 1); pbScrub.value = 0; }
  if (pbFrameCounter) pbFrameCounter.textContent = `0 / ${frames}`;

  // fetch full landmarks
  try {
    const res = await fetch(`/api/dataset/playback/${id}`);
    pbSample = await res.json();
  } catch (e) {
    console.error('[Playback] fetch error', e);
    return;
  }

  resizePbCanvas();
  renderPbFrame(0);
  dvPlayback.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closePlayback() {
  if (pbTimer) { clearInterval(pbTimer); pbTimer = null; }
  pbPlaying = false;
  pbSample = null;
  if (dvPlayback) dvPlayback.style.display = 'none';
  if (pbPlayBtn) pbPlayBtn.textContent = '▶ Play';
}

function togglePlayback() {
  if (!pbSample) return;
  pbPlaying = !pbPlaying;
  if (pbPlayBtn) pbPlayBtn.textContent = pbPlaying ? '⏸ Pause' : '▶ Play';
  if (pbPlaying) {
    const frames = pbSample.type === 'motion' ? pbSample.landmarks : [pbSample.landmarks];
    pbTimer = setInterval(() => {
      pbFrameIdx = (pbFrameIdx + 1) % frames.length;
      renderPbFrame(pbFrameIdx);
    }, 1000 / PB_FPS);
  } else {
    clearInterval(pbTimer);
    pbTimer = null;
  }
}

function scrubPlayback(val) {
  pbFrameIdx = parseInt(val, 10);
  if (pbPlaying) {
    clearInterval(pbTimer);
    pbTimer = null;
    pbPlaying = false;
    if (pbPlayBtn) pbPlayBtn.textContent = '▶ Play';
  }
  renderPbFrame(pbFrameIdx);
}


/* ═══════════════════════════════════════
   INIT
   ═══════════════════════════════════════ */
renderEmotions();
setConfidence(0);
connectWS();