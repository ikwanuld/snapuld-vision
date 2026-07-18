(function () {
  'use strict';

  const OCR_INTERVAL_MS = 2500;

  // How many consecutive frames must produce the same code before it's
  // treated as confirmed and auto-saved (mirrors "3 consecutive frames" from
  // the multi-ULD scanner spec) — this filters out one-off misreads.
  const STABLE_FRAMES_REQUIRED = 3;

  // Auto-correction of common OCR letter/digit confusions is only trusted
  // when Tesseract's own confidence for the frame is at least this high.
  const CORRECTION_MIN_CONFIDENCE = 60;

  // A ULD code is always 3 letters, 5 digits, 2 letters — used to decide,
  // position by position, whether a misread character should be corrected
  // as a letter or a digit.
  const ULD_PATTERN_TYPES = ['L', 'L', 'L', 'D', 'D', 'D', 'D', 'D', 'L', 'L'];
  const ULD_CODE_LENGTH = ULD_PATTERN_TYPES.length;

  // digit -> letter it's commonly confused with, and vice versa
  const LETTER_FIX = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z' };
  const DIGIT_FIX = { 'O': '0', 'I': '1', 'L': '1', 'S': '5', 'B': '8', 'Z': '2' };

  // Matches the CSS .scan-frame { inset: 4%; } so we only OCR what the user sees framed
  const SCAN_FRAME_INSET_RATIO = 0.04;

  // Flip to true while debugging to see exactly what Tesseract read, on-screen and in console
  const DEBUG_OCR = false;

  const state = {
    stream: null,
    ocrRunning: false,
    ocrTimer: null,
    ocrWorker: null,
    workerReady: false,
    audioCtx: null,
    // code -> consecutive-frame count, used to require stable reads before saving
    candidateStreaks: new Map(),
    // codes already submitted to the sheet this session
    savedUlds: new Set(),
    savedCount: 0,
    // scans that have been detected/confirmed but not yet submitted — each is
    // {id, uld, corrected} and shown as an editable row until Submit is pressed
    pendingQueue: [],
    nextEntryId: 1,
    selectedStation: null
  };

  const dom = {
    video: document.getElementById('camera-video'),
    canvas: document.getElementById('capture-canvas'),
    overlayMsg: document.getElementById('camera-overlay-msg'),
    scanningBadge: document.getElementById('scanning-badge'),
    scanningBadgeText: document.getElementById('scanning-badge-text'),
    detectionStatus: document.getElementById('detection-status'),
    detectionValue: document.getElementById('detection-value'),
    candidateChips: document.getElementById('candidate-chips'),
    lastSavedRow: document.getElementById('last-saved-row'),
    sessionSavedCount: document.getElementById('session-saved-count'),
    pendingQueueList: document.getElementById('pending-queue-list'),
    pendingCount: document.getElementById('pending-count'),
    submitQueueBtn: document.getElementById('submit-queue-btn'),
    stationSelect: document.getElementById('station-select'),
    userInput: document.getElementById('user-input'),
    connectionStatus: document.getElementById('connection-status'),
    connectionStatusText: document.getElementById('connection-status-text'),
    restartBtn: document.getElementById('restart-camera-btn'),
    toast: document.getElementById('toast')
  };

  window.addEventListener('load', init);

  function init() {
    loadStations();
    restoreOperatorName();
    startCamera();

    dom.restartBtn.addEventListener('click', function () {
      stopOcrLoop();
      stopCamera();
      startCamera();
    });

    dom.submitQueueBtn.addEventListener('click', submitPendingQueue);

    dom.userInput.addEventListener('change', function () {
      try {
        localStorage.setItem('snapuld_operator', dom.userInput.value.trim());
      } catch (e) {}
    });
  }

  function restoreOperatorName() {
    try {
      const saved = localStorage.getItem('snapuld_operator');
      if (saved) dom.userInput.value = saved;
    } catch (e) {}
  }

  function loadStations() {
    const stations = ['KUL', 'PEN', 'BKI', 'KCH', 'JHB'];
    let savedStation = null;
    try {
      savedStation = localStorage.getItem('snapuld_station');
    } catch (e) {}

    const initial = (savedStation && stations.indexOf(savedStation) !== -1) ? savedStation : stations[0];
    state.selectedStation = initial;

    dom.stationSelect.innerHTML = '';
    stations.forEach(function (code) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'station-chip' + (code === initial ? ' active' : '');
      chip.textContent = code;
      chip.setAttribute('aria-pressed', code === initial ? 'true' : 'false');

      chip.addEventListener('click', function () {
        state.selectedStation = code;
        Array.from(dom.stationSelect.children).forEach(function (c) {
          c.classList.remove('active');
          c.setAttribute('aria-pressed', 'false');
        });
        chip.classList.add('active');
        chip.setAttribute('aria-pressed', 'true');
        try {
          localStorage.setItem('snapuld_station', code);
        } catch (e) {}
      });

      dom.stationSelect.appendChild(chip);
    });
  }

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
        // Ask for continuous autofocus where supported so close-up paper/tags stay sharp
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
        // Distinguish "engine/network broke" from "nothing found" so it's obvious
        // when the problem is Tesseract/CDN rather than the tag itself.
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

  // Grab the raw video frame at full resolution
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

  // Minimum width (px) we want the cropped region to be before OCR. Phone
  // camera frames often make handwritten/stenciled text only 20-30px tall,
  // which is too small for reliable recognition — so we upscale first.
  const OCR_MIN_WIDTH = 900;

  // Crop to the on-screen scan-frame area, upscale if the text is small,
  // then binarize using a threshold computed from the actual image
  // (Otsu's method) instead of one fixed number — this survives shadows,
  // glare, and uneven lighting far better than a hardcoded cutoff.
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

  // Standard Otsu's method: picks the brightness cutoff that best separates
  // the image into two clusters (text vs. background) for this specific frame.
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

  // PSM 7 (single line) is tried first since a cropped ULD code is usually
  // one line. If that comes back empty, PSM 11 (sparse text, no layout
  // assumptions) is more forgiving of tilted text, extra marks, or a crop
  // that isn't a perfectly clean single line — this is what usually rescues
  // the "(empty)" case.
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
          // Restrict to what a ULD code can contain — cuts down on misreads
          // for a short isolated code. Page segmentation mode is set per
          // recognition attempt (see runRecognitionPass) since we try more
          // than one strategy.
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

    // Drop streaks for anything not read this frame, so an old misread
    // doesn't keep counting toward stability once it stops appearing.
    Array.from(state.candidateStreaks.keys()).forEach(function (code) {
      if (!seenThisFrame.has(code)) {
        state.candidateStreaks.delete(code);
      }
    });

    confirmedThisFrame.forEach(function (cand) {
      state.candidateStreaks.delete(cand.code);
      addToPendingQueue(cand.code, cand.corrected);
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
    renderCandidates(pending);
  }

  // A code counts as "tracked" once it's either already submitted this
  // session, or already sitting in the pending queue awaiting Submit —
  // either way we don't want it re-detected as a new candidate.
  function isAlreadyTracked(code) {
    if (state.savedUlds.has(code)) return true;
    return state.pendingQueue.some(function (entry) { return entry.uld === code; });
  }

  // Tries to correct a single character against the type (letter/digit)
  // expected at its position in the ULD pattern. Returns the corrected
  // character, or null if it can't be resolved to a valid one.
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

  // Attempts to interpret a fixed-length window as a ULD code, applying
  // position-aware auto-correction (O<->0, I/L<->1, S<->5, B<->8, Z<->2).
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

  function extractValidUldCandidates(rawText, confidence) {
    if (!rawText) return [];
    const upperText = rawText.toUpperCase();
    // Strip everything except letters/digits so spaces, dashes, underscores,
    // slashes, and line breaks between the three groups no longer block a match.
    const cleanedText = upperText.replace(/[^A-Z0-9]/g, '');

    const found = new Map(); // code -> corrected(boolean)

    for (let start = 0; start <= cleanedText.length - ULD_CODE_LENGTH; start++) {
      const windowStr = cleanedText.substr(start, ULD_CODE_LENGTH);
      const result = tryCorrectWindow(windowStr);
      if (!result) continue;

      // Only trust auto-corrected reads when the OCR pass itself was confident;
      // an exact match (no correction needed) is always accepted.
      if (result.corrected && confidence < CORRECTION_MIN_CONFIDENCE) continue;

      if (!found.has(result.code) || found.get(result.code)) {
        found.set(result.code, result.corrected);
      }
    }

    return Array.from(found.entries()).map(function (entry) {
      return { code: entry[0], corrected: entry[1] };
    });
  }

  function renderCandidates(candidates) {
    dom.candidateChips.innerHTML = '';
    candidates.forEach(function (cand) {
      const chip = document.createElement('div');
      chip.className = 'candidate-chip';
      chip.textContent = cand.code + (cand.corrected ? ' \u270e' : '');
      chip.title = cand.corrected ? 'Auto-corrected reading — tap to add to pending list' : 'Tap to add to pending list';
      chip.addEventListener('click', function () {
        addToPendingQueue(cand.code, cand.corrected);
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

  function addToPendingQueue(code, corrected) {
    if (isAlreadyTracked(code)) return;

    const entry = {
      id: state.nextEntryId++,
      uld: code,
      corrected: !!corrected
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
      hint.textContent = 'No scans queued yet.';
      dom.pendingQueueList.appendChild(hint);
    } else {
      state.pendingQueue.forEach(function (entry) {
        dom.pendingQueueList.appendChild(buildPendingRow(entry));
      });
    }

    dom.pendingCount.textContent = state.pendingQueue.length + ' pending';
    dom.submitQueueBtn.disabled = state.pendingQueue.length === 0;
  }

  // Builds one editable row: a text input holding the ULD code (correctable
  // by hand before submit) plus a remove button to discard a bad read.
  function buildPendingRow(entry) {
    const row = document.createElement('div');
    row.className = 'pending-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pending-input';
    input.value = entry.uld;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', function () {
      entry.uld = input.value;
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'pending-remove-btn';
    removeBtn.setAttribute('aria-label', 'Remove from pending list');
    removeBtn.textContent = '\u2715';
    removeBtn.addEventListener('click', function () {
      state.pendingQueue = state.pendingQueue.filter(function (e) { return e.id !== entry.id; });
      renderPendingQueue();
    });

    row.appendChild(input);
    row.appendChild(removeBtn);
    return row;
  }

  // Commits every row currently in the pending queue to the (simulated)
  // sheet. Whatever text is in each editable field at this moment is what
  // gets saved, so hand corrections made before pressing Submit are respected.
  function submitPendingQueue() {
    if (state.pendingQueue.length === 0) return;

    const station = state.selectedStation || '';
    const operator = (dom.userInput.value || '').trim() || 'Unknown';
    const timestamp = new Date().toISOString();

    const toSubmit = state.pendingQueue
      .map(function (entry) { return (entry.uld || '').trim().toUpperCase(); })
      .filter(function (code) { return code.length > 0; });

    if (toSubmit.length === 0) return;

    setConnectionStatus(true, 'Submitting...');
    dom.submitQueueBtn.disabled = true;

    // SIMULASI SIMPAN (Kerana GitHub Pages tiada backend DB)
    setTimeout(function () {
      toSubmit.forEach(function (code) {
        state.savedUlds.add(code);
      });

      updateLastSaved({
        uld: toSubmit[toSubmit.length - 1],
        station: station,
        user: operator,
        timestamp: timestamp
      });

      state.savedCount += toSubmit.length;
      updateSessionSavedCount();

      state.pendingQueue = [];
      renderPendingQueue();

      setConnectionStatus(true, 'Camera Ready');
      showToast(toSubmit.length + (toSubmit.length > 1 ? ' ULDs Disimpan' : ' ULD Disimpan') + ' (Simulasi)', 'success');
    }, 800);
  }

  function updateSessionSavedCount() {
    if (!dom.sessionSavedCount) return;
    dom.sessionSavedCount.textContent = state.savedCount + ' saved';
  }

  // Short confirmation beep on a stable/confirmed detection. Uses the Web
  // Audio API directly so no audio file needs to be bundled or hosted.
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

  function updateLastSaved(record) {
    if (!record) return;
    dom.lastSavedRow.innerHTML = '';

    const uldSpan = document.createElement('span');
    uldSpan.className = 'last-saved-uld';
    uldSpan.textContent = record.uld;

    const badge = document.createElement('span');
    badge.className = 'badge-success';
    badge.textContent = record.station + ' \u00B7 ' + formatTime(record.timestamp);

    dom.lastSavedRow.appendChild(uldSpan);
    dom.lastSavedRow.appendChild(badge);
  }

  function formatTime(isoString) {
    try {
      const d = new Date(isoString);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
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
