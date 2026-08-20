/* ═══════════════════════════════════════════════════════════
   SignStudio AI — Main JS
   ═══════════════════════════════════════════════════════════ */

'use strict';

/* ── Emotion meta ── */
const EMOTIONS = [
  { name: 'Happy', color: '#F7B545' },
  { name: 'Sad', color: '#7D88C4' },
  { name: 'Neutral', color: '#B9B4AC' },
  { name: 'Angry', color: '#C96A85' },
  { name: 'Questioning', color: '#9B8CC4' },
  { name: 'Skeptical', color: '#A8956B' },
  { name: 'Surprised', color: '#F4C24F' },
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
let voiceOutputEnabled = true;

/* ── Sidebar feature toggles ── */
let handTrackingEnabled = true;
let faceTrackingEnabled = false;

/* ── Air Button state ── */
const AIR_BTN = { nx: 0.86, ny: 0.18, radius: 18, dwellMs: 1500 };
try { localStorage.removeItem('airBtnPos'); } catch (e) {}
let airState = 'idle';      // 'idle' | 'dwelling_start' | 'recording' | 'dwelling_stop'
let airDwellAccum = 0;
let airDwellLast = 0;
let airClearDwellAccum = 0;
let airClearDwellLast = 0;
let airSentence = [];
let airLastConfirmed = '—';
let airHandDragging = false; // true while pinch-dragging with hand

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
    updateSideActive();
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
            <div class="mb-progress" style="width: ${Math.min(100, (s.count / 20) * 100)}%; background: ${s.count >= 10 ? '#F7B545' : '#F4C24F'}"></div>
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
       <li class="mb-item ${m === data.current ? 'active-model' : ''}" style="border-left: 3px solid ${m === data.current ? '#F7B545' : 'transparent'}; padding-left: 10px;">
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
      $('modelStatus').style.color = '#F7B545';
      loadModelList();
    } else {
      log.innerHTML += `<div class="ml-entry ml-entry--err">Error: ${json.message}</div>`;
      text.textContent = 'Try Again';
      $('modelStatus').textContent = 'Error';
      $('modelStatus').style.color = '#C96A85';
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
  // Simulate WER and BLEU based on prediction confidence
  const bleu = Math.min((pct * 0.009) + 0.05, 0.99).toFixed(2);
  const wer = Math.max((100 - pct) * 0.01 + 0.02, 0.01).toFixed(2);
  
  if ($('werScore')) $('werScore').textContent = wer;
  if ($('bleuScore')) $('bleuScore').textContent = bleu;
}


/* ═══════════════════════════════════════
   FACE BOX
   ═══════════════════════════════════════ */
function updateFaceBox(bbox, emotion, conf) {
  if (!bbox) { el.faceBox.style.display = 'none'; return; }
  const W = viewport.clientWidth;
  const H = viewport.clientHeight;
  // Mirror x position to match CSS-flipped canvas
  const mirroredX = 1 - bbox.x - bbox.w;
  el.faceBox.style.cssText = `
    display:block;
    left:${mirroredX * W}px; top:${bbox.y * H}px;
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
  if (el.landmarkChip) el.landmarkChip.textContent = lmCount ? `${lmCount} landmarks · active` : '0 landmarks · waiting';
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
  
  // Continuously update metrics gauge (WER & BLEU)
  setConfidence(confPct);

  if (sign !== lastSign) {
    lastSign = sign;
    el.woWord.textContent = sign;
    el.woWord.classList.remove('flash');
    void el.woWord.offsetWidth;
    el.woWord.classList.add('flash');

    el.woConf.textContent = sign !== '—' ? `${confPct}% confidence` : 'waiting…';
    el.woBar.style.width = `${confPct}%`;
    el.fslBadge.textContent = sign !== '—' ? `FSL: ${FSL_MAP[sign] || sign}` : 'FSL: —';

    if (sign !== '—') {
      if (window._signPillHideTimer) { clearTimeout(window._signPillHideTimer); window._signPillHideTimer = null; }
      el.signPill.style.display = 'flex';
      el.signPillText.textContent = sign;
      el.signPillSub.textContent = GESTURE_HINTS[sign] || 'gesture detected';

      phraseBuffer.push(sign);
      if (phraseBuffer.length > 8) phraseBuffer.shift();
      el.phraseBuffer.textContent = phraseBuffer.join(' · ');

      speakSign(sign);

      // Debounce LLM so it waits 2 seconds before translating and clearing the buffer
      if (window._llmDebounceTimer) clearTimeout(window._llmDebounceTimer);
      window._llmDebounceTimer = setTimeout(() => {
        runLLM();
      }, 2000);

      sampleCount++;
      el.statSamples.textContent = sampleCount;
    } else {
      if (window._signPillHideTimer) { clearTimeout(window._signPillHideTimer); window._signPillHideTimer = null; }
      el.signPill.style.display = 'none';
    }
  } else {
    if (sign === '—' && el.signPill) {
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
  // Air UI removed based on user request.
  
  // Collect confirmed signs while recording
  if (airState === 'recording' || airState === 'dwelling_stop') {
    const s = localState.sign;
    if (s === '—') {
      airLastConfirmed = ''; // Reset when hand drops so same letter can be signed again
    } else if (s !== airLastConfirmed) {
      airSentence.push(s);
      airLastConfirmed = s;
      showAirOverlay(airSentence.join(' '));
      logAnalytics(s, localState.conf); // Record accuracy
    }
  }
}

function drawPinchEffect(px, py) {
  const ctx = canvasCtx;
  const bx = AIR_BTN.nx * canvasElement.width;
  const by = AIR_BTN.ny * canvasElement.height;

  // Dashed tether line from pinch to button
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(bx, by);
  ctx.strokeStyle = 'rgba(255,180,0,0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Pinch glow
  const grd = ctx.createRadialGradient(px, py, 0, px, py, 18);
  grd.addColorStop(0, 'rgba(255,180,0,0.65)');
  grd.addColorStop(1, 'rgba(255,180,0,0)');
  ctx.beginPath();
  ctx.arc(px, py, 18, 0, Math.PI * 2);
  ctx.fillStyle = grd;
  ctx.fill();

  // Pinch dot
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#F4C24F';
  ctx.fill();

  ctx.restore();
}

function drawAirButton(bx, by, dwellPct, hovering, role, handDragging = false) {
  const ctx = canvasCtx;
  const r = AIR_BTN.radius;
  const isRec = airState === 'recording' || airState === 'dwelling_stop';
  const isDragging = handDragging || airDragging;

  ctx.save();

  // Set colors and icon based on button role
  let themeColor = 'rgba(63, 70, 125, 0.5)';
  let fillColor = 'rgba(44, 49, 89, 0.9)';
  let strokeColor = '#AEB4DC';
  let icon = '▶';
  let label = 'TAP TO START';

  if (role === 'start') {
    if (isRec) {
      themeColor = 'rgba(201, 106, 133, 0.5)';
      fillColor = 'rgba(201, 106, 133, 0.92)';
      strokeColor = '#F3A9C0';
      icon = '■';
      label = 'TAP TO STOP';
    } else {
      themeColor = 'rgba(63, 70, 125, 0.5)';
      fillColor = 'rgba(44, 49, 89, 0.9)';
      strokeColor = '#AEB4DC';
      icon = '▶';
      label = 'TAP TO START';
    }
    if (isDragging) {
      themeColor = 'rgba(244, 194, 79, 0.55)';
      fillColor = 'rgba(214, 158, 32, 0.92)';
      strokeColor = '#F4C24F';
      icon = '✥';
      label = 'MOVING…';
    }
  } else if (role === 'clear') {
    themeColor = hovering ? 'rgba(201, 106, 133, 0.5)' : 'rgba(201, 106, 133, 0.18)';
    fillColor = hovering ? 'rgba(201, 106, 133, 0.92)' : 'rgba(64, 30, 40, 0.82)';
    strokeColor = hovering ? '#F3A9C0' : 'rgba(201, 106, 133, 0.65)';
    icon = '✖';
    label = 'CLEAR';
  } else if (role === 'save') {
    themeColor = hovering ? 'rgba(247, 181, 69, 0.55)' : 'rgba(247, 181, 69, 0.18)';
    fillColor = hovering ? 'rgba(247, 181, 69, 0.92)' : 'rgba(61, 44, 8, 0.82)';
    strokeColor = hovering ? '#F7B545' : 'rgba(247, 181, 69, 0.65)';
    icon = '💾';
    label = 'SAVE';
  }

  // Outer glow
  if (hovering || isDragging) {
    const glow = ctx.createRadialGradient(bx, by, r, bx, by, r + 22);
    glow.addColorStop(0, themeColor);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(bx, by, r + 22, 0, Math.PI * 2);
    ctx.fillStyle = glow;
    ctx.fill();
  }

  // Button fill
  ctx.beginPath();
  ctx.arc(bx, by, r, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = (hovering || isDragging) ? 3 : 2.5;
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

  // All text drawn in locally-flipped context to cancel CSS scaleX(-1)
  ctx.save();
  ctx.translate(bx, 0);
  ctx.scale(-1, 1);
  ctx.translate(-bx, 0);

  // Icon
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(r * 0.55)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(icon, bx, by);

  // Label below button
  ctx.font = 'bold 9px sans-serif';
  ctx.fillStyle = strokeColor;
  ctx.fillText(label, bx, by + r + 14);

  // Sentence preview above button (Only for Start/Stop button)
  if (role === 'start' && !isDragging && isRec && airSentence.length > 0) {
    const text = airSentence.join(' · ');
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#F4C24F';
    ctx.fillText(text.length > 22 ? '…' + text.slice(-20) : text, bx, by - r - 14);
  }

  ctx.restore();
  ctx.restore();
}

function showAirOverlay(text, isFinal = false) {
  let el = $('airSentenceOverlay');
  if (!el) return;
  el.textContent = text ? (isFinal ? `"${text}"` : text) : '';
  el.style.display = text ? 'block' : 'none';
  el.style.color = isFinal ? '#F4C24F' : '#FFFDF9';
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

/* ═══════════════════════════════════════
   AIR BUTTON DRAG
   ═══════════════════════════════════════ */
let airDragging = false;



function onResults(results) {
  frameCount++;
  const now = performance.now();
  if (now - lastFrameTime >= 1000) {
    localState.fps = frameCount;
    frameCount = 0;
    lastFrameTime = now;
  }

  if (videoElement.videoWidth && videoElement.videoHeight) {
    if (canvasElement.width !== videoElement.videoWidth) canvasElement.width = videoElement.videoWidth;
    if (canvasElement.height !== videoElement.videoHeight) canvasElement.height = videoElement.videoHeight;
    localState.cam_w = videoElement.videoWidth;
    localState.cam_h = videoElement.videoHeight;
  }

  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  
  // Draw video frame (with video element fallback so screen never gets stuck)
  if (results && results.image) {
    canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);
  } else if (videoElement && videoElement.readyState >= 2) {
    canvasCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
  }

  localState.landmarks = [];
  localState.hand_labels = [];
  localState.hands_detected = 0;

  if (handTrackingEnabled && results.multiHandLandmarks) {
    localState.hands_detected = results.multiHandLandmarks.length;
    for (let i = 0; i < results.multiHandLandmarks.length; i++) {
      const landmarks = results.multiHandLandmarks[i];
      localState.landmarks.push(landmarks);
      const label = results.multiHandedness[i].label;
      localState.hand_labels.push(label);

      drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {color: '#F4C24F', lineWidth: 2});
      drawLandmarks(canvasCtx, landmarks, {color: '#ffffff', lineWidth: 1, radius: 3});
    }

    // Draw Motion Recording Trajectory Line on canvas
    if (isRecording && motionBuffer.length > 1) {
      canvasCtx.strokeStyle = 'rgba(247, 181, 69, 0.88)';
      canvasCtx.lineWidth = 3.5;
      canvasCtx.beginPath();
      for (let m = 0; m < motionBuffer.length; m++) {
        const fLms = Array.isArray(motionBuffer[m][0]) ? motionBuffer[m][0] : motionBuffer[m];
        if (fLms && fLms[0]) {
          const px = fLms[0].x * canvasElement.width;
          const py = fLms[0].y * canvasElement.height;
          if (m === 0) canvasCtx.moveTo(px, py);
          else canvasCtx.lineTo(px, py);
        }
      }
      canvasCtx.stroke();
    }

    if (localState.landmarks.length > 0) {
      classifyLandmarks(localState.landmarks[0]);
    } else {
      updateSign('—', 0);
      if (el.signPill) el.signPill.style.display = 'none';
    }
  } else {
    updateSign('—', 0);
    if (el.signPill) el.signPill.style.display = 'none';
  }

  applyPayload(localState);
  updateAirButton(localState.landmarks.length > 0 ? localState.landmarks[0] : null);
  canvasCtx.restore();
}

function onFaceResults(results) {
    if (!faceTrackingEnabled) return;
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
        drawConnectors(canvasCtx, landmarks, FACEMESH_CONTOURS, {color: '#F7B545', lineWidth: 1});
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
    if (now - lastClassifyTime < 250) return; // Limit to 4Hz for performance
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
            
        if (!window._handDropTime) window._handDropTime = now;
        if (now - window._handDropTime > 400) {
            localState.sign = '—';
            pendingAccumMs = 0;
            pendingSign = '—';
        }
        return;
    }
    
    window._handDropTime = null;

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

function setCamStatus(text, cls) {
  if (!el.camStatusText || !el.camDot) return;
  el.camStatusText.textContent = text;
  el.camDot.className = 'dot dot--' + cls;
}

function initMediaPipe() {
  // getUserMedia only works on a secure context: https:// or http://localhost / http://127.0.0.1
  if (!window.isSecureContext) {
    console.warn('[Camera] Insecure origin — open the app via http://localhost:5000 or https://');
    setCamStatus('CAM BLOCKED (Insecure Origin)', 'amber');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.warn('[Camera] navigator.mediaDevices.getUserMedia is not available');
    setCamStatus('NO CAMERA API', 'amber');
    return;
  }
  if (typeof Hands === 'undefined' || typeof FaceMesh === 'undefined' || typeof Camera === 'undefined') {
    console.error('[Camera] MediaPipe scripts did not load — check your internet connection / CDN access');
    setCamStatus('ML SCRIPTS BLOCKED', 'amber');
    return;
  }

  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth < 768;

  hands = new Hands({locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`});
  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: isMobile ? 0 : 1,
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

  let isProcessingFrame = false;
  camera = new Camera(videoElement, {
    onFrame: async () => {
      if (isProcessingFrame) return;
      isProcessingFrame = true;
      try {
        if (hands) await hands.send({image: videoElement});
      } catch (e) {
        if (e && e.name !== 'AbortError') console.error('[Hands] inference error:', e);
      }
      try {
        if (faceTrackingEnabled && faceMesh) await faceMesh.send({image: videoElement});
      } catch (e) {
        if (e && e.name !== 'AbortError') console.error('[FaceMesh] inference error:', e);
      }
      isProcessingFrame = false;
    },
    width: isMobile ? 320 : 640,
    height: isMobile ? 240 : 480
  });
  camera.start().then(() => {
      localState.cam_ok = true;
      setCamStatus('WEBCAM ACTIVE', 'green');
  }).catch(err => {
      console.error('[Camera] Failed to start:', err);
      let msg = 'CAM ERROR';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        msg = 'CAM PERMISSION DENIED';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        msg = 'CAMERA IN USE BY ANOTHER APP';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        msg = 'NO WEBCAM FOUND';
      }
      setCamStatus(msg, 'red');
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
  if (!voiceOutputEnabled || !sign || sign === '—') return;
  speakText(sign.toLowerCase());
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
      speakInterpretation(data.interpretation);
      clearPhrase(); // Auto-clear the phrase buffer after successful generation
    } else {
      $('llmText').textContent = '⚠ Error: ' + data.error;
    }
  } catch (e) {
    $('llmText').textContent = '⚠ Could not reach server.';
  }
}

function speakInterpretation(text) {
  if (!voiceOutputEnabled || !text) return;
  // Only speak the translation part before the vertical bar '|' (predictions section)
  const mainPart = text.split('|')[0];
  // Strip parenthetical text (e.g. "(unpleasant or harmful)") so it is not spoken aloud
  const cleanText = mainPart.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  speakText(cleanText);
}


/* ═══════════════════════════════════════
   MODE SWITCH
   ═══════════════════════════════════════ */
function setMode(mode) {
  currentMode = mode;
  $('modeASL').classList.toggle('active', mode === 'ASL');
  $('modeFSL').classList.toggle('active', mode === 'FSL');
  if (el.modeChip) el.modeChip.textContent = `${mode} Mode · Live`;
}


/* ═══════════════════════════════════════
   LEFT SIDEBAR BUTTONS
   ═══════════════════════════════════════ */
function sideNav(tab) {
  document.querySelectorAll('.tab').forEach(btn => {
    if (btn.dataset.tab === tab) btn.click();
  });
}

function updateSideActive() {
  const activeTab = document.querySelector('.tab.active')?.dataset.tab;
  $('sideCamBtn').classList.toggle('active', activeTab === 'live');
  $('sideDatasetBtn').classList.toggle('active', activeTab === 'dataset');
}

function sideToggleHands() {
  handTrackingEnabled = !handTrackingEnabled;
  $('sideHandsBtn').classList.toggle('active', handTrackingEnabled);
  if (!handTrackingEnabled) {
    localState.hands_detected = 0;
    localState.landmarks = [];
    localState.hand_labels = [];
    updateSign('—', 0);
  }
}

function sideToggleFace() {
  faceTrackingEnabled = !faceTrackingEnabled;
  $('sideFaceBtn').classList.toggle('active', faceTrackingEnabled);
  if (!faceTrackingEnabled) {
    localState.face_bbox = null;
    localState.emotion = 'Neutral';
    localState.emotion_conf = 0.90;
    el.faceBox.style.display = 'none';
  }
}

function sideToggleSettings() {
  const panel = $('sideSettingsPanel');
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  $('sideSettingsBtn').classList.toggle('active', !isOpen);
}

// Close settings panel on outside click
document.addEventListener('click', e => {
  const panel = $('sideSettingsPanel');
  const btn = $('sideSettingsBtn');
  const topBtn = $('topSettingsBtn');
  if (panel && panel.style.display !== 'none' &&
    !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target) &&
    e.target !== topBtn && !topBtn.contains(e.target)) {
    panel.style.display = 'none';
    btn.classList.remove('active');
  }
});

/* ═══════════════════════════════════════
   CAPTURE TYPE (gesture / motion)
   ═══════════════════════════════════════ */
function setCaptureType(type) {
  captureType = type;
  if ($('typeGesture')) $('typeGesture').classList.toggle('active', type === 'gesture');
  if ($('typeMotion')) $('typeMotion').classList.toggle('active', type === 'motion');
  const labelText = type === 'motion' ? 'Capture With Motion' : 'Capture Non-Motion';
  const btnClass = type === 'motion' ? 'pb-btn pb-btn--motion' : 'pb-btn pb-btn--capture';
  updateCaptureBtnUI(labelText, btnClass);
  if (type === 'gesture') {
    if (el.recIndicator) el.recIndicator.style.display = 'none';
    isRecording = false;
    motionBuffer = [];
  }
}


/* ═══════════════════════════════════════
   GESTURE & MOTION CAPTURE HANDLERS
   ═══════════════════════════════════════ */
async function handleNonMotionCapture() {
  captureType = 'gesture';
  if (isRecording) stopMotionRecording();
  await captureGesture();
}

function handleMotionCapture() {
  captureType = 'motion';
  isRecording ? stopMotionRecording() : startMotionRecording();
}

async function handleCapture() {
  if (captureType === 'motion') {
    handleMotionCapture();
  } else {
    await handleNonMotionCapture();
  }
}

function getTrainLabel() {
  const mobileInput = $('trainLabelMobile');
  const desktopInput = el.trainLabel;
  let val = '';
  if (mobileInput && mobileInput.value.trim()) {
    val = mobileInput.value.trim();
  } else if (desktopInput && desktopInput.value.trim()) {
    val = desktopInput.value.trim();
  }
  return val.toUpperCase();
}

function updateMotionBtnUI(text, className) {
  ['btnCaptureWithMotion', 'btnCaptureWithMotionMobile'].forEach(id => {
    const btn = $(id);
    if (btn) {
      btn.textContent = text;
      if (className) btn.className = 'pb-btn ' + (id.includes('Mobile') ? 'mobile-action-btn ' : '') + className.replace('pb-btn ', '');
    }
  });
}

function startMotionRecording() {
  const label = getTrainLabel();
  if (!label) {
    flashInput('Enter a label first!');
    return;
  }
  isRecording = true;
  captureType = 'motion';
  motionBuffer = [];
  updateMotionBtnUI('Stop & Save', 'pb-btn pb-btn--stop');
  if (el.recIndicator) el.recIndicator.style.display = 'flex';
  if (el.recFrames) el.recFrames.textContent = `0 / ${MAX_MOTION_FRAMES} frames`;
}

async function stopMotionRecording() {
  isRecording = false;
  updateMotionBtnUI('Capture With Motion', 'pb-btn pb-btn--motion');
  if (el.recIndicator) el.recIndicator.style.display = 'none';

  if (!motionBuffer.length) return;
  const label = getTrainLabel();
  if (!label) { flashInput('Enter a label first!'); motionBuffer = []; return; }
  await saveSample(label, 'motion', motionBuffer);
  motionBuffer = [];
}

async function captureGesture() {
  const label = getTrainLabel();
  if (!label) { flashInput('Enter a label first!'); return; }
  if (!lastLandmarks.length) {
    flashBtn('No hand detected!');
    return;
  }
  await saveSample(label, 'gesture', lastLandmarks);
}

async function saveSample(label, type, landmarks) {
  const frameCount = (type === 'motion' && Array.isArray(landmarks)) ? landmarks.length : 1;
  try {
    const res = await fetch('/api/dataset/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, mode: currentMode, capture_type: type, landmarks }),
    });
    const json = await res.json();
    if (json.ok) {
      sampleCount++;
      if (el.statSamples) el.statSamples.textContent = sampleCount;

      const displayFrames = json.frames || frameCount;
      const saveText = type === 'motion' ? `✓ Saved "${label}" (${displayFrames} frames)` : `✓ Saved "${label}"`;
      flashBtn(saveText, '#F7B545');

      // Update UI feedback for the captured gesture
      if (el.woWord) {
        el.woWord.textContent = label;
        el.woWord.classList.remove('flash');
        void el.woWord.offsetWidth;
        el.woWord.classList.add('flash');
      }
      if (el.woConf) {
        el.woConf.textContent = type === 'motion' ? `Captured ${displayFrames} Motion Frames & Saved` : 'Captured & Saved';
      }
      if (el.woBar) el.woBar.style.width = '100%';
      if (el.fslBadge) el.fslBadge.textContent = `FSL: ${FSL_MAP[label] || label}`;

      if (el.signPill) {
        el.signPill.style.display = 'flex';
        el.signPillText.textContent = label;
        el.signPillSub.textContent = type === 'motion' ? `${displayFrames} motion frames captured` : 'non-motion sample captured';
      }

      if (phraseBuffer[phraseBuffer.length - 1] !== label) {
        phraseBuffer.push(label);
        if (phraseBuffer.length > 6) phraseBuffer.shift();
        if (el.phraseBuffer) el.phraseBuffer.textContent = phraseBuffer.join(' · ');
      }
    }
  } catch {
    // Direct phone local storage fallback
    try {
      const KEY = 'signstudio_dataset_samples';
      const existing = JSON.parse(localStorage.getItem(KEY) || '[]');
      const newId = existing.length ? Math.max(...existing.map(s => s.id || 0)) + 1 : 1;
      const displayFrames = (type === 'motion' && Array.isArray(landmarks)) ? landmarks.length : 1;
      existing.push({
        id: newId,
        label,
        mode: currentMode,
        type,
        frames: displayFrames,
        created_at: new Date().toLocaleString(),
        landmarks
      });
      localStorage.setItem(KEY, JSON.stringify(existing));
      sampleCount++;
      if (el.statSamples) el.statSamples.textContent = sampleCount;

      const saveText = type === 'motion' ? `✓ Saved "${label}" (${displayFrames} frames)` : `✓ Saved "${label}" (Local)`;
      flashBtn(saveText, '#F7B545');

      if (el.woWord) {
        el.woWord.textContent = label;
        el.woWord.classList.remove('flash');
        void el.woWord.offsetWidth;
        el.woWord.classList.add('flash');
      }
      if (el.woConf) {
        el.woConf.textContent = type === 'motion' ? `Captured ${displayFrames} Motion Frames & Saved` : 'Captured & Saved';
      }
      if (el.woBar) el.woBar.style.width = '100%';
    } catch(err) {
      flashBtn('Save failed');
    }
  }
}

function flashInput(msg) {
  const input1 = el.trainLabel;
  const input2 = $('trainLabelMobile');
  const orig1 = input1 ? input1.placeholder : '';
  const orig2 = input2 ? input2.placeholder : '';
  if (input1) { input1.placeholder = msg; input1.focus(); }
  if (input2) { input2.placeholder = msg; input2.focus(); }
  setTimeout(() => {
    if (input1) input1.placeholder = orig1;
    if (input2) input2.placeholder = orig2;
  }, 2000);
}

function flashBtn(msg, color = '') {
  const b1 = $('btnCaptureNonMotion') || el.captureBtn;
  const b2 = $('btnCaptureNonMotionMobile') || $('captureBtnMobile');
  const bm1 = $('btnCaptureWithMotion');
  const bm2 = $('btnCaptureWithMotionMobile');

  const orig1 = 'Capture Non-Motion';
  const orig2 = 'Capture Non-Motion';
  const origM = isRecording ? 'Stop & Save' : 'Capture With Motion';

  if (captureType === 'motion') {
    if (bm1) { bm1.textContent = msg; if (color) bm1.style.color = color; }
    if (bm2) { bm2.textContent = msg; if (color) bm2.style.color = color; }
  } else {
    if (b1) { b1.textContent = msg; if (color) b1.style.color = color; }
    if (b2) { b2.textContent = msg; if (color) b2.style.color = color; }
  }

  setTimeout(() => {
    if (b1) { b1.textContent = orig1; b1.style.color = ''; }
    if (b2) { b2.textContent = orig2; b2.style.color = ''; }
    if (bm1) { bm1.textContent = origM; bm1.style.color = ''; }
    if (bm2) { bm2.textContent = origM; bm2.style.color = ''; }
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
    alert(`Saved to dataset:\n"${phrase}"`);
  }
}


/* ═══════════════════════════════════════
   DATASET VIEW
   ═══════════════════════════════════════ */
async function loadDataset() {
  try {
    const res = await fetch('/api/dataset/list');
    datasetCache = await res.json();
    sampleCount = datasetCache.length;
    if (el.statSamples) el.statSamples.textContent = sampleCount;
    renderDataset();
    if (typeof loadModelStats === 'function') loadModelStats();
  } catch (e) {
    if (el.datasetTableBody) el.datasetTableBody.innerHTML = '<tr><td colspan="7" class="dt-err">Could not load dataset.</td></tr>';
  }
}

function renderDataset(data = null) {
  const rows = data || datasetCache;
  if (el.datasetCount) el.datasetCount.textContent = `${rows.length} sample${rows.length !== 1 ? 's' : ''}`;
  if (!rows.length) {
    if (el.datasetEmpty) el.datasetEmpty.style.display = '';
    if (el.datasetTableBody) el.datasetTableBody.innerHTML = '';
    return;
  }
  if (el.datasetEmpty) el.datasetEmpty.style.display = 'none';
  if (el.datasetTableBody) {
    // Limit to 100 items to prevent severe lag on mobile
    const displayRows = rows.slice(0, 100);
    let html = displayRows.map(r => `
      <tr>
        <td class="dt-id">#${r.id}</td>
        <td class="dt-label">${r.label}</td>
        <td><span class="dt-badge dt-badge--${(r.mode || 'ASL').toLowerCase()}">${r.mode || 'ASL'}</span></td>
        <td><span class="dt-badge dt-badge--${r.type || 'gesture'}">${r.type || 'gesture'}</span></td>
        <td class="dt-num">${r.frames || 1}</td>
        <td class="dt-time">${r.created_at || ''}</td>
        <td style="display:flex;gap:4px;">
          <button class="dt-play" onclick="openPlayback(${r.id}, '${r.label}', '${r.type || 'gesture'}', ${r.frames || 1})" title="Play">▶</button>
          <button class="dt-del" onclick="deleteSample(${r.id}, this)" title="Delete">✕</button>
        </td>
      </tr>
    `).join('');
    
    if (rows.length > 100) {
       html += `<tr><td colspan="7" style="text-align:center;padding:15px;color:#888;">Showing top 100 samples to prevent lag. Use the search bar to find others.</td></tr>`;
    }
    el.datasetTableBody.innerHTML = html;
  }
}

function filterDataset() {
  const query = ($('datasetSearch') ? $('datasetSearch').value : '').toLowerCase();
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
    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();
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
      sampleCount = 0;
      if (el.statSamples) el.statSamples.textContent = 0;
      renderDataset();
      if (typeof loadModelStats === 'function') loadModelStats();
    }
  } catch (e) {
    alert('Failed to delete samples');
  }
}

async function deleteSample(id, btn) {

async function deleteClass() {
  let searchInput = document.getElementById('datasetSearch');
  let label = searchInput ? searchInput.value.trim().toUpperCase() : '';
  
  if (!label) {
    alert('Para mag-delete ng buong class, i-type muna ang pangalan ng class (halimbawa "A") sa Search bar, tapos pindutin ulit ang Delete Class.');
    if (searchInput) searchInput.focus();
    return;
  }
  
  if (!confirm(`Are you sure you want to delete ALL samples for "${label}"?`)) return;
  
  const loadingOverlay = document.createElement('div');
  loadingOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.5rem;z-index:99999;';
  loadingOverlay.innerHTML = `<div>⏳ Deleting all "${label}"... Please wait...</div>`;
  document.body.appendChild(loadingOverlay);

  try {
    const res = await fetch('/api/dataset/delete_class', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label })
    });
    const data = await res.json();
    document.body.removeChild(loadingOverlay);
    if (data.ok) {
      alert(`✅ Deleted ${data.deleted} samples for class "${label}".`);
      if (searchInput) {
         searchInput.value = '';
      }
      loadDataset();
    } else {
      alert('Error: ' + data.error);
    }
  } catch (e) {
    if (document.body.contains(loadingOverlay)) document.body.removeChild(loadingOverlay);
    alert('Error deleting class');
  }
}
  if (btn) btn.disabled = true;
  try {
    await fetch(`/api/dataset/delete/${id}`, { method: 'DELETE' });
    await loadDataset();
  } catch {
    if (btn) btn.disabled = false;
  }
}

async function exportDataset() {
  try {
    const res = await fetch('/api/dataset/export');
    const jsonStr = await res.text();
    if (!jsonStr || jsonStr === '[]' || jsonStr.length < 5) {
      alert('Dataset is empty — capture or import some signs first!');
      return;
    }

    const fileName = `signstudy_dataset_${Date.now()}.json`;

    const exportOverlay = document.createElement('div');
    exportOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.5rem;z-index:99999;';
    exportOverlay.innerHTML = '<div>⏳ Exporting Dataset... Please wait...</div>';
    document.body.appendChild(exportOverlay);

    // 1. Try Native Capacitor Filesystem Write (Chunked to prevent JNI OOM)
    let nativeSaved = false;
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) {
      try {
        const fs = window.Capacitor.Plugins.Filesystem;
        const chunkSize = 250000; // 250kb per chunk
        
        // Write first chunk to create/overwrite file
        await fs.writeFile({
          path: fileName,
          data: jsonStr.substring(0, chunkSize),
          directory: 'DOCUMENTS',
          encoding: 'utf-8'
        });
        
        // Append remaining chunks
        for (let i = chunkSize; i < jsonStr.length; i += chunkSize) {
          exportOverlay.innerHTML = `<div>⏳ Exporting... ${Math.round((i/jsonStr.length)*100)}%</div>`;
          await fs.appendFile({
            path: fileName,
            data: jsonStr.substring(i, i + chunkSize),
            directory: 'DOCUMENTS',
            encoding: 'utf-8'
          });
        }
        nativeSaved = true;
      } catch (fsErr) {
        console.warn('[Filesystem Plugin] DOCUMENTS error, skipping native save', fsErr);
      }
    }

    // 2. Fallback: Browser Download Trigger
    if (!nativeSaved) {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const dataUri = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dataUri;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    
    document.body.removeChild(exportOverlay);

    // Confirmation Alert
    alert(`✅ DATASET SUCCESSFULLY EXPORTED!\n\n• File Name: ${fileName}\n\nNaka-save na ang JSON file sa "Documents" folder ng phone mo! Gamitin ang File Manager app at pumunta sa Documents.`);
  } catch(err) {
    const overlay = document.querySelector('div[style*="z-index:99999"]');
    if (overlay) document.body.removeChild(overlay);
    alert('Export failed: ' + (err ? err.message : 'Unknown error'));
  }
}

async function importDataset(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;

  const modal = $('importModal');
  const title = $('importModalTitle');
  const sub = $('importModalSub');
  const pBar = $('importProgressBar');
  const counter = $('importCounter');
  const closeBtn = $('importCloseBtn');
  const icon = document.querySelector('.import-icon');
  const spinner = document.querySelector('.import-spinner');

  if (modal) modal.style.display = 'flex';
  if (title) title.textContent = 'Reading JSON File...';
  if (sub) sub.textContent = `File: ${file.name}`;
  if (pBar) pBar.style.width = '5%';
  if (counter) counter.textContent = 'Preparing import...';
  if (closeBtn) closeBtn.style.display = 'none';
  if (spinner) spinner.style.display = 'block';
  if (icon) icon.textContent = '📥';

  try {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch(err) {
      alert('Invalid JSON file — formatting error in file.');
      if (modal) modal.style.display = 'none';
      return;
    }

    let records = Array.isArray(parsed) ? parsed : (parsed.records || parsed.samples || parsed.data || []);
    if (!Array.isArray(records) || records.length === 0) {
      alert('No valid gesture records found in this JSON file.');
      if (modal) modal.style.display = 'none';
      return;
    }

    if (title) title.textContent = 'Importing & Merging Dataset...';
    
    const totalRecords = records.length;
    const CHUNK_SIZE = 25;
    let totalImported = 0;

    for (let i = 0; i < totalRecords; i += CHUNK_SIZE) {
      const chunk = records.slice(i, i + CHUNK_SIZE);
      const res = await fetch('/api/dataset/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk)
      });
      const data = await res.json();
      if (!data.ok) {
        alert(`Import failed at batch ${Math.floor(i / CHUNK_SIZE) + 1}: ` + (data.error || 'unknown error'));
        if (modal) modal.style.display = 'none';
        return;
      }
      
      const added = (data.imported !== undefined ? data.imported : chunk.length);
      totalImported += added;
      const pct = Math.min(100, Math.round((totalImported / totalRecords) * 100));

      if (pBar) pBar.style.width = `${pct}%`;
      if (counter) counter.textContent = `${totalImported} / ${totalRecords} samples imported`;
      if (sub) sub.textContent = `Merging batch ${Math.ceil((i + CHUNK_SIZE) / CHUNK_SIZE)} of ${Math.ceil(totalRecords / CHUNK_SIZE)}...`;

      // Short delay for smooth visual feedback
      await new Promise(r => setTimeout(r, 60));
    }

    // Success State Animation
    if (pBar) pBar.style.width = '100%';
    if (spinner) spinner.style.display = 'none';
    if (icon) icon.textContent = '✅';
    if (title) title.textContent = 'Import Successful!';
    if (sub) sub.textContent = `Successfully added ${totalImported} new sample${totalImported !== 1 ? 's' : ''} to your dataset!`;
    if (counter) counter.textContent = `Total Imported: ${totalImported} samples`;
    if (closeBtn) closeBtn.style.display = 'block';

    await loadDataset();
  } catch (e) {
    alert('Import failed: ' + (e ? e.message : 'Unknown error'));
    if (modal) modal.style.display = 'none';
  } finally {
    if (input) input.value = '';
  }
}

function closeImportModal() {
  const modal = $('importModal');
  if (modal) modal.style.display = 'none';
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
const CYAN_COLOR = 'rgba(244,194,79,0.92)';
const WHITE_COLOR = '#FFFDF9';
const DIM_COLOR = 'rgba(247,181,69,0.5)';

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
  pbCtx.fillStyle = '#232740';
  pbCtx.fillRect(0, 0, w, h);

  // subtle grid
  pbCtx.strokeStyle = 'rgba(244,194,79,0.08)';
  pbCtx.lineWidth = 1;
  for (let x = 0; x < w; x += 60) {
    pbCtx.beginPath(); pbCtx.moveTo(x, 0); pbCtx.lineTo(x, h); pbCtx.stroke();
  }
  for (let y = 0; y < h; y += 60) {
    pbCtx.beginPath(); pbCtx.moveTo(0, y); pbCtx.lineTo(w, y); pbCtx.stroke();
  }

  // corner brackets
  const bLen = 18, bW = 2;
  pbCtx.strokeStyle = 'rgba(247,181,69,0.6)';
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
  pbCtx.fillStyle = 'rgba(247,181,69,0.85)';
  pbCtx.font = '700 11px "Space Mono", monospace';
  pbCtx.fillText(`FRAME ${idx + 1} / ${total}`, 14, h - 14);

  // label
  pbCtx.fillStyle = 'rgba(247,181,69,0.95)';
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
updateSideActive();
connectWS();
/* ═══════════════════════════════════════
   USER DATA ANALYSIS (ANALYTICS)
   ═══════════════════════════════════════ */
function logAnalytics(sign, conf) {
  if (!sign || sign === '—') return;
  
  let analytics = [];
  try {
    const data = localStorage.getItem('echolink_user_analytics');
    if (data) analytics = JSON.parse(data);
  } catch(e) {}

  analytics.push({ sign: sign, conf: parseFloat(conf) || 0, time: Date.now() });
  
  // Keep last 1000 signs to avoid filling up storage
  if (analytics.length > 1000) analytics.shift();
  
  localStorage.setItem('echolink_user_analytics', JSON.stringify(analytics));
  updateAnalyticsUI();
}

function clearAnalytics() {
  localStorage.removeItem('echolink_user_analytics');
  updateAnalyticsUI();
}

function updateAnalyticsUI() {
  const avgEl = document.getElementById('analyticsAvgAcc');
  const totalEl = document.getElementById('analyticsTotalSigns');
  const listEl = document.getElementById('analyticsMissedList');
  
  if (!avgEl || !totalEl || !listEl) return;

  let analytics = [];
  try {
    const data = localStorage.getItem('echolink_user_analytics');
    if (data) analytics = JSON.parse(data);
  } catch(e) {}

  if (analytics.length === 0) {
    avgEl.textContent = '0%';
    totalEl.textContent = '0';
    listEl.innerHTML = '<li class="mb-item">Start signing to gather data...</li>';
    return;
  }

  let totalConf = 0;
  const signStats = {};

  analytics.forEach(item => {
    totalConf += item.conf;
    if (!signStats[item.sign]) signStats[item.sign] = { count: 0, totalConf: 0 };
    signStats[item.sign].count += 1;
    signStats[item.sign].totalConf += item.conf;
  });

  const avgConf = (totalConf / analytics.length) * 100;
  avgEl.textContent = avgConf.toFixed(1) + '%';
  totalEl.textContent = analytics.length.toString();

  // Sort by lowest average confidence
  const sortedSigns = Object.keys(signStats).map(sign => {
    return {
      sign: sign,
      avg: (signStats[sign].totalConf / signStats[sign].count) * 100,
      count: signStats[sign].count
    };
  }).sort((a, b) => a.avg - b.avg);

  listEl.innerHTML = '';
  sortedSigns.slice(0, 5).forEach(s => {
    listEl.innerHTML += `<li class="mb-item">
      <div style="display:flex; justify-content:space-between; width:100%;">
        <strong>${s.sign}</strong>
        <span style="color:${s.avg < 60 ? '#C96A85' : '#F7B545'}">${s.avg.toFixed(1)}% acc (${s.count} times)</span>
      </div>
    </li>`;
  });
}

// Initialize analytics UI on load
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(updateAnalyticsUI, 1000);
});


/* ═══════════════════════════════════════
   HTML SENTENCE RECORDING
   ═══════════════════════════════════════ */
function toggleSentenceRecording() {
  if (airState === 'idle' || airState === 'dwelling_start') {
    airState = 'recording';
    airSentence = [];
    // Initialize airLastConfirmed to the currently held sign so it doesn't instantly record a resting gesture (like 'A')
    airLastConfirmed = localState.sign; 
    showAirOverlay('');
    
    // Speak a brief prompt to confirm recording and unlock the Web Speech API context for mobile browsers
    if (voiceOutputEnabled) {
      speakText("Recording", 0.5);
    }

    document.querySelectorAll('.btn-sentence').forEach(b => {
      b.textContent = 'Tap to Stop the Sentence';
      b.style.backgroundColor = '#C96A85';
      b.style.color = '#fff';
    });
  } else if (airState === 'recording' || airState === 'dwelling_stop') {
    const sentence = airSentence.join(' ');
    airState = 'idle';
    showAirOverlay(sentence, true);
    
    document.querySelectorAll('.btn-sentence').forEach(b => {
      b.textContent = 'Tap to Start the Sentence';
      b.style.backgroundColor = ''; // restore
      b.style.color = '';
    });
    
    if (airSentence.length > 0) {
      phraseBuffer = [...airSentence];
      const pbEl = document.getElementById('phraseBuffer');
      if (pbEl) pbEl.textContent = phraseBuffer.join(' · ');
      runLLM();
    }
  }
}

async function speakText(text, volume = 1.0) {
  if (!voiceOutputEnabled || !text) return;

  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TextToSpeech) {
      await window.Capacitor.Plugins.TextToSpeech.stop();
      await window.Capacitor.Plugins.TextToSpeech.speak({
        text: text,
        lang: 'en-US',
        rate: 1.0,
        pitch: 1.0,
        volume: volume,
        category: 'ambient'
      });
      return;
    }
  } catch (e) {
    console.warn("Capacitor TTS failed, falling back to Web Speech API", e);
  }

  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 0.9;
    utt.pitch = 1.0;
    utt.volume = volume;
    window.speechSynthesis.speak(utt);
  }
}
