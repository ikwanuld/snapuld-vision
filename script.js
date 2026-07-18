(function () {
  'use strict';

  const OCR_INTERVAL_MS = 2500;

  // How many consecutive frames must produce the same code before it's
  // treated as confirmed and added to the pending list.
  const STABLE_FRAMES_REQUIRED = 3;

  // Auto-correction of common OCR letter/digit confusions is only trusted
  // when Tesseract's own confidence for the frame is at least this high.
  // A stricter bar applies when the corrected code's prefix isn't one of
  // the known ULD types below — an unfamiliar prefix needs a cleaner read.
  const CORRECTION_MIN_CONFIDENCE = 60;
  const CORRECTION_MIN_CONFIDENCE_UNKNOWN_PREFIX = 75;

  // A ULD code is always 3 letters, 5 digits, 2 letters.
  const ULD_PATTERN_TYPES = ['L', 'L', 'L', 'D', 'D', 'D', 'D', 'D', 'L', 'L'];
  const ULD_CODE_LENGTH = ULD_PATTERN_TYPES.length;

  const LETTER_FIX = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z' };
  const DIGIT_FIX = { 'O': '0', 'I': '1', 'L': '1', 'S': '5', 'B': '8', 'Z': '2' };

  const SCAN_FRAME_INSET_RATIO = 0.04;
  const OCR_MIN_WIDTH = 900;
  const DEBUG_OCR = false;

  // ---- Ops domain knowledge ----
  const STATIONS = ['KUL', 'BKI', 'KCH'];
  const FLIGHT_TYPES = ['AK', 'D7'];

  const ULD_TYPE_INFO = {
    AAY: { label: 'LD8 Container' },
    AKH: { label: 'LD3 Half Container' },
    PKC: { label: 'Pallet (PKC)' },
    AKE: { label: 'LD3 Container' },
    PMC: { label: 'Pallet 96x125 (PMC)' },
    PAG: { label: 'Pallet w/ Net (PAG)' },
    PAJ: { label: 'Pallet w/ Net (PAJ)' }
  };
  const KNOWN_ULD_PREFIXES = Object.keys(ULD_TYPE_INFO);

  const EXPECTED_ULD_DISPLAY = {
    AK: ['AAY', 'AKH', 'PKC', 'PAG/PAJ'],
    D7: ['AKE', 'PMC', 'PAG/PAJ']
  };
  const EXPECTED_PREFIXES = {
    AK: ['AAY', 'AKH', 'PKC', 'PAG', 'PAJ'],
    D7: ['AKE', 'PMC', 'PAG', 'PAJ']
  };

  const VIEWS = {
    home: { title: 'SnapULD Vision', subtitle: 'AI ULD Operations Platform', showBack: false, showStatus: false },
    setup: { title: 'Scan Details', subtitle: 'Set station, flight type & operator', showBack: true, showStatus: false },
    scanner: { title: 'ULD Scanner', subtitle: null, showBack: true, showStatus: true },
    dashboard: { title: 'Dashboard', subtitle: 'Operational analytics', showBack: true, showStatus: false },
    history: { title: 'Scan History', subtitle: 'All scan records', showBack: true, showStatus: false },
    damage: { title: 'AI Damage Detection', subtitle: 'Future module', showBack: true, showStatus: false }
  };

  const state = {
    currentView: 'home',
    setup: { operator: '', station: null, flightType: null },
    isOnline: true,

    stream: null,
    ocrRunning: false,
    ocrTimer: null,
    ocrWorker: null,
    workerReady: false,
    audioCtx: null,

    candidateStreaks: new Map(),
    savedUlds: new Set(),
    savedCount: 0,
    pendingQueue: [],
    nextEntryId: 1,
    // full session scan log, most recent first — each record carries the
    // metadata captured at submit time plus a syncStatus flag
    scannedLog: []
  };

  const dom = {
    headerBackBtn: document.getElementById('header-back-btn'),
    headerTitle: document.getElementById('header-title'),
    headerSubtitle: document.getElementById('header-subtitle'),
    connectionStatus: document.getElementById('connection-status'),
    connectionStatusText: document.getElementById('connection-status-text'),

    views: {
      home: document.getElementById('view-home'),
      setup: document.getElementById('view-setup'),
      scanner: document.getElementById('view-scanner'),
      dashboard: document.getElementById('view-dashboard'),
      history: document.getElementById('view-history'),
      damage: document.getElementById('view-damage')
    },

    navScanner: document.getElementById('nav-scanner'),
    navDashboard: document.getElementById('nav-dashboard'),
    navHistory: document.getElementById('nav-history'),
    navDamage: document.getElementById('nav-damage'),

    usernameInput: document.getElementById('username-input'),
    stationSelect: document.getElementById('station-select'),
    flightTypeSelect: document.getElementById('flight-type-select'),
    expectedUldChips: document.getElementById('expected-uld-chips'),
    expectedUldHint: document.getElementById('expected-uld-hint'),
    startScanBtn: document.getElementById('start-scan-btn'),

    contextStation: document.getElementById('context-station'),
    contextFlight: document.getElementById('context-flight'),
    contextOperator: document.getElementById('context-operator'),
    editDetailsBtn: document.getElementById('edit-details-btn'),

    video: document.getElementById('camera-video'),
    canvas: document.getElementById('capture-canvas'),
    overlayMsg: document.getElementById('camera-overlay-msg'),
    scanningBadge: document.getElementById('scanning-badge'),
    scanningBadgeText: document.getElementById('scanning-badge-text'),
    detectionStatus: document.getElementById('detection-status'),
    detectionValue: document.getElementById('detection-value'),
    candidateChips: document.getElementById('candidate-chips'),

    pendingQueueList: document.getElementById('pending-queue-list'),
    pendingCount: document.getElementById('pending-count'),
    submitQueueBtn: document.getElementById('submit-queue-btn'),

    scannedList: document.getElementById('scanned-list'),
    sessionSavedCount: document.getElementById('session-saved-count'),

    restartBtn: document.getElementById('restart-camera-btn'),
    toast: document.getElementById('toast')
  };

  window.addEventListener('load', init);

  function init() {
    initSetupView();
    wireNav();

    window.addEventListener('online', handleConnectivityChange);
    window.addEventListener('offline', handleConnectivityChange);
    state.isOnline = navigator.onLine;

    dom.submitQueueBtn.addEventListener('click', submitPendingQueue);
    dom.restartBtn.addEventListener('click', function () {
      stopOcrLoop();
      stopCamera();
      startCamera();
    });

    showView('home');
  }

  // ================= View router =================

  function showView(name) {
    const prev = state.currentView;
    if (prev === 'scanner' && name !== 'scanner') {
      stopOcrLoop();
      stopCamera();
    }

    Object.keys(dom.views).forEach(function (key) {
      dom.views[key].hidden = key !== name;
    });

    const cfg = VIEWS[name];
    dom.headerTitle.textContent = cfg.title;
    dom.headerSubtitle.textContent = (name === 'scanner') ? buildScannerSubtitle() : cfg.subtitle;
    dom.headerBackBtn.hidden = !cfg.showBack;
    dom.connectionStatus.hidden = !cfg.showStatus;

    state.currentView = name;

    if (name === 'scanner' && prev !== 'scanner') {
      updateContextBar();
      startCamera();
    }
  }

  function buildScannerSubtitle() {
    return (state.setup.station || '—') + ' \u00B7 ' + (state.setup.flightType || '—');
  }

  function wireNav() {
    dom.navScanner.addEventListener('click', function () {
      showView(isSetupComplete() ? 'scanner' : 'setup');
    });
    dom.navDashboard.addEventListener('click', function () { showView('dashboard'); });
    dom.navHistory.addEventListener('click', function () { showView('history'); });
    dom.navDamage.addEventListener('click', function () { showView('damage'); });
    dom.headerBackBtn.addEventListener('click', function () { showView('home'); });
    dom.editDetailsBtn.addEventListener('click', function () { showView('setup'); });
  }

  function isSetupComplete() {
    return !!(state.setup.operator && state.setup.station && state.setup.flightType);
  }

  // ================= Setup view =================

  function initSetupView() {
    let savedOperator = '';
    let savedStation = null;
    let savedFlightType = null;
    try {
      savedOperator = localStorage.getItem('snapuld_operator') || '';
      savedStation = localStorage.getItem('snapuld_station');
      savedFlightType = localStorage.getItem('snapuld_flight_type');
    } catch (e) {}

    state.setup.operator = savedOperator;
    dom.usernameInput.value = savedOperator;

    const initialStation = (savedStation && STATIONS.indexOf(savedStation) !== -1) ? savedStation : null;
    state.setup.station = initialStation;
    buildChipGroup(dom.stationSelect, STATIONS, initialStation, function (value) {
      state.setup.station = value;
      try { localStorage.setItem('snapuld_station', value); } catch (e) {}
      validateSetup();
    });

    const initialFlightType = (savedFlightType && FLIGHT_TYPES.indexOf(savedFlightType) !== -1) ? savedFlightType : null;
    state.setup.flightType = initialFlightType;
    buildChipGroup(dom.flightTypeSelect, FLIGHT_TYPES, initialFlightType, function (value) {
      state.setup.flightType = value;
      try { localStorage.setItem('snapuld_flight_type', value); } catch (e) {}
      renderExpectedUldChips(value);
      validateSetup();
    });

    dom.usernameInput.addEventListener('input', function () {
      state.setup.operator = dom.usernameInput.value.trim();
      validateSetup();
    });
    dom.usernameInput.addEventListener('change', function () {
      try { localStorage.setItem('snapuld_operator', dom.usernameInput.value.trim()); } catch (e) {}
    });

    renderExpectedUldChips(initialFlightType);
    validateSetup();

    dom.startScanBtn.addEventListener('click', function () {
      if (dom.startScanBtn.disabled) return;
      updateContextBar();
      showView('scanner');
    });
  }

  function buildChipGroup(container, options, initial, onSelect) {
    container.innerHTML = '';
    options.forEach(function (value) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'station-chip' + (value === initial ? ' active' : '');
      chip.textContent = value;
      chip.setAttribute('aria-pressed', value === initial ? 'true' : 'false');
      chip.addEventListener('click', function () {
        Array.from(container.children).forEach(function (c) {
          c.classList.remove('active');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        onSelect(value);
      });
      container.appendChild(chip);
    });
  }

  function renderExpectedUldChips(flightType) {
    dom.expectedUldChips.innerHTML = '';
    const list = EXPECTED_ULD_DISPLAY[flightType];
    if (!list) {
      dom.expectedUldHint.textContent = 'Select a flight type to see expected ULD prefixes.';
      return;
    }
    dom.expectedUldHint.textContent = 'Expected ULD prefixes for ' + flightType + ':';
    list.forEach(function (label) {
      const chip = document.createElement('span');
      chip.className = 'expected-uld-chip';
      chip.textContent = label;
      dom.expectedUldChips.appendChild(chip);
    });
  }

  function validateSetup() {
    const emailOk = /\S+@\S+\.\S+/.test(state.setup.operator || '');
    dom.startScanBtn.disabled = !(emailOk && state.setup.station && state.setup.flightType);
  }

  function updateContextBar() {
    dom.contextStation.textContent = state.setup.station || '—';
    dom.contextFlight.textContent = state.setup.flightType || '—';
    dom.contextOperator.textContent = state.setup.operator || '—';
  }

  // ================= Connectivity / offline sync =================

  function handleConnectivityChange() {
    state.isOnline = navigator.onLine;
    if (state.isOnline) {
      flushOfflineQueue();
    } else if (!dom.connectionStatus.hidden) {
      setConnectionStatus(false, 'Offline \u2013 Queuing');
    }
  }

  // Records saved while offline are marked "pending sync" and kept locally;
  // there's no real backend endpoint yet, so this flips them to "synced"
  // once connectivity returns — ready to wire to a real sync call later.
  function flushOfflineQueue() {
    const pending = state.scannedLog.filter(function (r) { return r.syncStatus === 'pending'; });
    if (pending.length === 0) return;
    pending.forEach(function (r) { r.syncStatus = 'synced'; });
    renderScannedList();
    showToast(pending.length + (pending.length > 1 ? ' records synced' : ' record synced'), 'success');
  }

  // ================= Camera =================

  function startCamera() {
    hideOverlay();
    setConnectionStatus(true, 'Camera Ready');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showOverlay('Camera Not Available');
      setConnectionStatus(false, 'No Camera API');
      return;
    }

    const constraints = {
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        focusMode: 'continuous'
      },
      audio: false
    };

    navigator.mediaDevices.getUserMedia(constraints)
      .then(function (stream) {
        state.stream = stream;
        dom.video.srcObject = stream;
        return dom.video.play();
      })
      .then(function () {
        setConnectionStatus(true, 'Camera Ready');
        startOcrLoop();
      })
      .catch(function (err) {
        console.error('Camera error:', err);
        showOverlay('Kamera Tidak Dapat Diakses / Benarkan Kebenaran');
        setConnectionStatus(false, 'Camera Error');
      });
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach(function (track) { track.stop(); });
      state.stream = null;
    }
    dom.video.srcObject = null;
  }

  function showOverlay(message) {
    dom.overlayMsg.textContent = message;
    dom.overlayMsg.classList.add('visible');
  }

  function hideOverlay() {
    dom.overlayMsg.classList.remove('visible');
  }

  function startOcrLoop() {
    stopOcrLoop();
    state.ocrTimer = setInterval(runOcrCycle, OCR_INTERVAL_MS);
    runOcrCycle();
  }

  function stopOcrLoop() {
    if (state.ocrTimer) {
      clearInterval(state.ocrTimer);
      state.ocrTimer = null;
    }
  }

  function runOcrCycle() {
    if (state.ocrRunning) return;
    if (!state.stream || dom.video.readyState < 2) return;

    state.ocrRunning = true;
    setScanningIndicator(true);

    captureFrame()
      .then(preprocessForOcr)
      .then(recognizeText)
      .then(handleOcrResult)
      .catch(function (err) {
        console.error('OCR error:', err);
        if (err && err.isEngineError) {
          setDetectionState('none', 'OCR Engine Error');
          setConnectionStatus(false, 'OCR Unavailable');
        } else {
          setDetectionState('none', 'No ULD Found');
        }
      })
      .finally(function () {
        state.ocrRunning = false;
        setScanningIndicator(false);
      });
  }

  function captureFrame() {
    return new Promise(function (resolve, reject) {
      const video = dom.video;
      if (!video.videoWidth) {
        reject(new Error('Video not ready'));
        return;
      }
      const canvas = dom.canvas;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    });
  }

  // Crop to the on-screen scan-frame area, upscale if the text is small,
  // then binarize using a per-frame Otsu threshold.
  function preprocessForOcr(sourceCanvas) {
    const fullW = sourceCanvas.width;
    const fullH = sourceCanvas.height;

    const cropX = Math.round(fullW * SCAN_FRAME_INSET_RATIO);
    const cropY = Math.round(fullH * SCAN_FRAME_INSET_RATIO);
    const cropW = fullW - cropX * 2;
    const cropH = fullH - cropY * 2;

    const scale = cropW < OCR_MIN_WIDTH ? Math.min(3, OCR_MIN_WIDTH / cropW) : 1;
    const outW = Math.round(cropW * scale);
    const outH = Math.round(cropH * scale);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext('2d');
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';

    outCtx.drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, outW, outH);

    const imageData = outCtx.getImageData(0, 0, outW, outH);
    const data = imageData.data;
    const grayValues = new Uint8ClampedArray(outW * outH);

    for (let p = 0; p < grayValues.length; p++) {
      const i = p * 4;
      grayValues[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    }

    const threshold = computeOtsuThreshold(grayValues);

    for (let p = 0; p < grayValues.length; p++) {
      const i = p * 4;
      const value = grayValues[p] > threshold ? 255 : 0;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
    }

    outCtx.putImageData(imageData, 0, 0);

    if (DEBUG_OCR) {
      console.log('Preprocessed crop:', outW, 'x', outH, '(scale ' + scale.toFixed(2) + 'x) threshold=', threshold);
    }

    return outCanvas;
  }

  function computeOtsuThreshold(grayValues) {
    const histogram = new Array(256).fill(0);
    for (let i = 0; i < grayValues.length; i++) {
      histogram[grayValues[i]]++;
    }

    const total = grayValues.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * histogram[t];

    let sumB = 0;
    let wB = 0;
    let maxVariance = 0;
    let threshold = 127;

    for (let t = 0; t < 256; t++) {
      wB += histogram[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;

      sumB += t * histogram[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const variance = wB * wF * (mB - mF) * (mB - mF);

      if (variance > maxVariance) {
        maxVariance = variance;
        threshold = t;
      }
    }

    return threshold;
  }

  function recognizeText(canvas) {
    setDetectionState('searching', 'Searching...');
    return getOcrWorker()
      .then(function (worker) {
        return runRecognitionPass(worker, canvas, '7').then(function (res) {
          if (res.text && res.text.trim().length > 0) return res;
          if (DEBUG_OCR) console.log('First pass empty, retrying with sparse-text mode...');
          return runRecognitionPass(worker, canvas, '11');
        });
      })
      .catch(function (err) {
        err.isEngineError = true;
        throw err;
      });
  }

  function runRecognitionPass(worker, canvas, pageSegMode) {
    return worker.setParameters({ tessedit_pageseg_mode: pageSegMode })
      .then(function () {
        return worker.recognize(canvas);
      })
      .then(function (result) {
        const text = (result && result.data && result.data.text) ? result.data.text : '';
        const confidence = (result && result.data && typeof result.data.confidence === 'number')
          ? result.data.confidence
          : 0;
        if (DEBUG_OCR) {
          console.log('Raw OCR text (PSM ' + pageSegMode + '):', JSON.stringify(text), 'confidence:', confidence);
        }
        return { text: text, confidence: confidence };
      });
  }

  function getOcrWorker() {
    if (state.ocrWorker && state.workerReady) {
      return Promise.resolve(state.ocrWorker);
    }
    if (!state.ocrWorker) {
      state.ocrWorker = Tesseract.createWorker('eng')
        .then(function (worker) {
          return worker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
          }).then(function () {
            state.workerReady = true;
            return worker;
          });
        })
        .catch(function (err) {
          state.ocrWorker = null;
          err.isEngineError = true;
          throw err;
        });
    }
    return state.ocrWorker;
  }

  // ================= Detection / recognition =================

  function handleOcrResult(ocrResult) {
    const rawText = ocrResult.text;
    const confidence = ocrResult.confidence;
    const candidates = extractValidUldCandidates(rawText, confidence);

    if (candidates.length === 0) {
      if (DEBUG_OCR) {
        dom.detectionValue.textContent = rawText ? rawText.trim().slice(0, 40) : '(empty)';
      }
      setDetectionState('none', 'No ULD Found');
      renderCandidates([]);
      state.candidateStreaks.clear();
      return;
    }

    const seenThisFrame = new Set();
    const confirmedThisFrame = [];

    candidates.forEach(function (cand) {
      seenThisFrame.add(cand.code);
      if (isAlreadyTracked(cand.code)) return;

      const streak = (state.candidateStreaks.get(cand.code) || 0) + 1;
      state.candidateStreaks.set(cand.code, streak);

      if (streak >= STABLE_FRAMES_REQUIRED) {
        confirmedThisFrame.push(cand);
      }
    });

    Array.from(state.candidateStreaks.keys()).forEach(function (code) {
      if (!seenThisFrame.has(code)) {
        state.candidateStreaks.delete(code);
      }
    });

    confirmedThisFrame.forEach(function (cand) {
      state.candidateStreaks.delete(cand.code);
      addToPendingQueue(cand.code, cand.corrected, confidence);
    });

    const pending = candidates.filter(function (c) {
      return !isAlreadyTracked(c.code);
    });

    if (pending.length === 0) {
      if (confirmedThisFrame.length > 0) {
        setDetectionState('found', '\u2713 Added to Pending List');
      }
      return;
    }

    if (pending.length === 1) {
      const streak = state.candidateStreaks.get(pending[0].code) || STABLE_FRAMES_REQUIRED;
      setDetectionState('searching', 'Stabilizing ' + Math.min(streak, STABLE_FRAMES_REQUIRED) + '/' + STABLE_FRAMES_REQUIRED + '...');
      dom.detectionValue.textContent = pending[0].code + (pending[0].corrected ? ' (auto-corrected)' : '');
      renderCandidates([]);
      return;
    }

    setDetectionState('searching', 'Multiple ULDs \u2013 stabilizing...');
    dom.detectionValue.textContent = pending.map(function (c) { return c.code; }).join(' / ');
    renderCandidates(pending, confidence);
  }

  function isAlreadyTracked(code) {
    if (state.savedUlds.has(code)) return true;
    return state.pendingQueue.some(function (entry) { return entry.uld === code; });
  }

  function correctChar(ch, expectedType) {
    if (expectedType === 'L') {
      if (ch >= 'A' && ch <= 'Z') return { value: ch, corrected: false };
      if (LETTER_FIX[ch]) return { value: LETTER_FIX[ch], corrected: true };
      return null;
    }
    if (ch >= '0' && ch <= '9') return { value: ch, corrected: false };
    if (DIGIT_FIX[ch]) return { value: DIGIT_FIX[ch], corrected: true };
    return null;
  }

  function tryCorrectWindow(windowStr) {
    let corrected = '';
    let anyCorrection = false;

    for (let i = 0; i < ULD_CODE_LENGTH; i++) {
      const result = correctChar(windowStr[i], ULD_PATTERN_TYPES[i]);
      if (!result) return null;
      corrected += result.value;
      if (result.corrected) anyCorrection = true;
    }

    return { code: corrected, corrected: anyCorrection };
  }

  // Smart correction: regex-shaped window + position-aware letter/digit
  // fixing + confidence gating, with a stricter confidence bar when the
  // corrected prefix isn't one of the known ULD types.
  function extractValidUldCandidates(rawText, confidence) {
    if (!rawText) return [];
    const upperText = rawText.toUpperCase();
    const cleanedText = upperText.replace(/[^A-Z0-9]/g, '');

    const found = new Map();

    for (let start = 0; start <= cleanedText.length - ULD_CODE_LENGTH; start++) {
      const windowStr = cleanedText.substr(start, ULD_CODE_LENGTH);
      const result = tryCorrectWindow(windowStr);
      if (!result) continue;

      if (result.corrected) {
        const prefix = result.code.slice(0, 3);
        const knownPrefix = KNOWN_ULD_PREFIXES.indexOf(prefix) !== -1;
        const requiredConfidence = knownPrefix ? CORRECTION_MIN_CONFIDENCE : CORRECTION_MIN_CONFIDENCE_UNKNOWN_PREFIX;
        if (confidence < requiredConfidence) continue;
      }

      if (!found.has(result.code) || found.get(result.code)) {
        found.set(result.code, result.corrected);
      }
    }

    return Array.from(found.entries()).map(function (entry) {
      return { code: entry[0], corrected: entry[1] };
    });
  }

  function renderCandidates(candidates, confidence) {
    dom.candidateChips.innerHTML = '';
    candidates.forEach(function (cand) {
      const chip = document.createElement('div');
      chip.className = 'candidate-chip';
      chip.textContent = cand.code + (cand.corrected ? ' \u270e' : '');
      chip.title = cand.corrected ? 'Auto-corrected reading — tap to add to pending list' : 'Tap to add to pending list';
      chip.addEventListener('click', function () {
        addToPendingQueue(cand.code, cand.corrected, confidence);
      });
      dom.candidateChips.appendChild(chip);
    });
  }

  function setDetectionState(kind, label) {
    dom.detectionStatus.textContent = label;
    dom.detectionStatus.classList.toggle('found', kind === 'found');
    if (kind !== 'found' && !DEBUG_OCR) {
      dom.detectionValue.textContent = '\u00A0';
    }
  }

  function setScanningIndicator(isScanning) {
    dom.scanningBadge.style.display = isScanning ? 'flex' : 'none';
    dom.scanningBadgeText.textContent = isScanning ? 'Scanning' : 'Idle';
  }

  // ================= Pending queue =================

  function addToPendingQueue(code, corrected, confidence) {
    if (isAlreadyTracked(code)) return;

    const entry = {
      id: state.nextEntryId++,
      uld: code,
      corrected: !!corrected,
      confidence: typeof confidence === 'number' ? Math.round(confidence) : null
    };
    state.pendingQueue.push(entry);
    renderPendingQueue();
    playBeep();

    setDetectionState('found', '\u2713 Added to Pending List');
    dom.detectionValue.textContent = code;
    renderCandidates([]);
  }

  function renderPendingQueue() {
    dom.pendingQueueList.innerHTML = '';

    if (state.pendingQueue.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'empty-hint';
      hint.textContent = 'No scans queued yet. Detected ULDs will appear here.';
      dom.pendingQueueList.appendChild(hint);
    } else {
      state.pendingQueue.forEach(function (entry) {
        dom.pendingQueueList.appendChild(buildPendingRow(entry));
      });
    }

    dom.pendingCount.textContent = state.pendingQueue.length + ' pending';
    dom.submitQueueBtn.disabled = state.pendingQueue.length === 0;
  }

  function buildPendingRow(entry) {
    const row = document.createElement('div');
    row.className = 'pending-row';

    const wrap = document.createElement('div');
    wrap.className = 'pending-input-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pending-input';
    input.value = entry.uld;
    input.autocomplete = 'off';
    input.spellcheck = false;

    const meta = document.createElement('div');
    meta.className = 'pending-meta';
    updatePendingMeta(meta, entry);

    input.addEventListener('input', function () {
      entry.uld = input.value;
      updatePendingMeta(meta, entry);
    });

    wrap.appendChild(input);
    wrap.appendChild(meta);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'pending-remove-btn';
    removeBtn.setAttribute('aria-label', 'Remove from pending list');
    removeBtn.textContent = '\u2715';
    removeBtn.addEventListener('click', function () {
      state.pendingQueue = state.pendingQueue.filter(function (e) { return e.id !== entry.id; });
      renderPendingQueue();
    });

    row.appendChild(wrap);
    row.appendChild(removeBtn);
    return row;
  }

  function updatePendingMeta(metaEl, entry) {
    const code = (entry.uld || '').trim().toUpperCase();
    const info = code.length >= 3 ? ULD_TYPE_INFO[code.slice(0, 3)] : null;
    const confidenceText = (typeof entry.confidence === 'number') ? entry.confidence + '% confidence' : '';

    metaEl.innerHTML = '';
    const typeSpan = document.createElement('span');
    if (info) {
      typeSpan.className = 'type-known';
      typeSpan.textContent = info.label;
    } else {
      typeSpan.textContent = 'Type unknown';
    }
    metaEl.appendChild(typeSpan);
    if (confidenceText) {
      metaEl.appendChild(document.createTextNode(' \u00B7 ' + confidenceText));
    }
  }

  // Commits every row currently pending to the (simulated) sheet, capturing
  // full scan metadata: timestamp, operator, station, flight type, GPS,
  // device, and OCR confidence. Offline submissions are marked pending-sync
  // and flip to synced automatically once connectivity returns.
  function submitPendingQueue() {
    if (state.pendingQueue.length === 0) return;

    const toSubmit = state.pendingQueue
      .map(function (entry) {
        return { uld: (entry.uld || '').trim().toUpperCase(), confidence: entry.confidence };
      })
      .filter(function (item) { return item.uld.length > 0; });

    if (toSubmit.length === 0) return;

    setConnectionStatus(true, 'Submitting...');
    dom.submitQueueBtn.disabled = true;

    getGpsCoordinates().then(function (gps) {
      const device = getDeviceInfo();
      const timestamp = new Date().toISOString();
      const station = state.setup.station || '';
      const flightType = state.setup.flightType || '';
      const operator = state.setup.operator || 'Unknown';
      const online = navigator.onLine;

      // SIMULASI SIMPAN (Kerana GitHub Pages tiada backend DB)
      setTimeout(function () {
        toSubmit.forEach(function (item) {
          state.savedUlds.add(item.uld);
          const prefix = item.uld.slice(0, 3);
          const typeInfo = ULD_TYPE_INFO[prefix];
          const expectedList = EXPECTED_PREFIXES[flightType] || [];

          state.scannedLog.unshift({
            uld: item.uld,
            type: typeInfo ? typeInfo.label : 'Unknown',
            expectedMatch: expectedList.indexOf(prefix) !== -1,
            station: station,
            flightType: flightType,
            operator: operator,
            timestamp: timestamp,
            confidence: item.confidence,
            gps: gps,
            device: device,
            syncStatus: online ? 'synced' : 'pending'
          });
        });

        state.savedCount += toSubmit.length;
        updateSessionSavedCount();
        renderScannedList();

        state.pendingQueue = [];
        renderPendingQueue();

        setConnectionStatus(true, state.stream ? 'Camera Ready' : 'Idle');
        showToast(
          toSubmit.length + (toSubmit.length > 1 ? ' ULDs Disimpan' : ' ULD Disimpan') +
          (online ? ' (Simulasi)' : ' \u2013 Queued Offline'),
          'success'
        );
      }, 800);
    });
  }

  function getGpsCoordinates() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) { resolve('Unavailable'); return; }
      const timeout = setTimeout(function () { resolve('Unavailable'); }, 4000);
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          clearTimeout(timeout);
          resolve(pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5));
        },
        function () {
          clearTimeout(timeout);
          resolve('Unavailable');
        },
        { enableHighAccuracy: false, timeout: 3500, maximumAge: 60000 }
      );
    });
  }

  function getDeviceInfo() {
    const ua = navigator.userAgent || '';
    if (/ipad/i.test(ua)) return 'iPad';
    if (/iphone/i.test(ua)) return 'iPhone';
    if (/android/i.test(ua)) return 'Android';
    if (/windows/i.test(ua)) return 'Windows';
    if (/macintosh|mac os/i.test(ua)) return 'Mac';
    return 'Unknown Device';
  }

  function updateSessionSavedCount() {
    dom.sessionSavedCount.textContent = state.savedCount + ' scanned';
  }

  // ================= Scanned list =================

  function renderScannedList() {
    dom.scannedList.innerHTML = '';

    if (state.scannedLog.length === 0) {
      const hint = document.createElement('span');
      hint.className = 'empty-hint';
      hint.textContent = 'Nothing submitted yet this session.';
      dom.scannedList.appendChild(hint);
      return;
    }

    state.scannedLog.forEach(function (record) {
      dom.scannedList.appendChild(buildScannedRow(record));
    });
  }

  function buildScannedRow(record) {
    const row = document.createElement('div');
    row.className = 'scanned-row';

    const main = document.createElement('div');
    main.className = 'scanned-main';

    const uldLine = document.createElement('span');
    uldLine.className = 'scanned-uld';
    uldLine.textContent = record.uld;

    const subLine = document.createElement('span');
    subLine.className = 'scanned-sub';
    subLine.textContent = record.type + ' \u00B7 ' + formatTime(record.timestamp) +
      (record.expectedMatch === false ? ' \u00B7 Unexpected type' : '');

    main.appendChild(uldLine);
    main.appendChild(subLine);

    const badge = document.createElement('span');
    badge.className = 'badge ' + (record.syncStatus === 'synced' ? 'badge-synced' : 'badge-pending-sync');
    badge.textContent = record.syncStatus === 'synced' ? 'Synced' : 'Pending Sync';

    row.appendChild(main);
    row.appendChild(badge);
    return row;
  }

  function formatTime(isoString) {
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  // ================= Misc: beep, status, toast =================

  function playBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!state.audioCtx) state.audioCtx = new AudioCtx();
      const ctx = state.audioCtx;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;

      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    } catch (e) {
      console.warn('Beep failed:', e);
    }
  }

  function setConnectionStatus(isOnline, label) {
    dom.connectionStatusText.textContent = label;
    dom.connectionStatus.classList.toggle('offline', !isOnline);
  }

  let toastTimer = null;
  function showToast(message, kind) {
    dom.toast.textContent = message;
    dom.toast.className = 'toast show ' + (kind || 'info');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      dom.toast.classList.remove('show');
    }, 2200);
  }

})();
