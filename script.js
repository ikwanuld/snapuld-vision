(function () {
  'use strict';

  // Matches 3 letters + 5 digits + 2 letters, e.g. AKE12345AK
  // Applied AFTER we strip every non-alphanumeric character, so it survives
  // spaces, dashes, underscores, slashes between the groups (AKE 12345 AK, AKE-12345-AK, etc.)
  const ULD_REGEX = /[A-Z]{3}\d{5}[A-Z]{2}/g;

  const OCR_INTERVAL_MS = 2500;
  const DUPLICATE_WINDOW_MS = 10000;

  // Matches the CSS .scan-frame { inset: 4%; } so we only OCR what the user sees framed
  const SCAN_FRAME_INSET_RATIO = 0.04;

  // Flip to true while debugging to see exactly what Tesseract read, on-screen and in console
  const DEBUG_OCR = true;

  const state = {
    stream: null,
    ocrRunning: false,
    ocrTimer: null,
    lastDetectedUld: null,
    lastDetectedTime: 0,
    ocrWorker: null,
    workerReady: false
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
    dom.stationSelect.innerHTML = '';
    ['KUL', 'PEN', 'BKI', 'KCH', 'JHB'].forEach(function (code) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code;
      dom.stationSelect.appendChild(opt);
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
        return runRecognitionPass(worker, canvas, '7').then(function (text) {
          if (text && text.trim().length > 0) return text;
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
        if (DEBUG_OCR) {
          console.log('Raw OCR text (PSM ' + pageSegMode + '):', JSON.stringify(text));
        }
        return text;
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

  function handleOcrResult(rawText) {
    const candidates = extractValidUldCandidates(rawText);

    if (DEBUG_OCR) {
      dom.detectionValue.textContent = rawText ? rawText.trim().slice(0, 40) : '(empty)';
    }

    if (candidates.length === 0) {
      setDetectionState('none', 'No ULD Found');
      renderCandidates([]);
      return;
    }

    if (candidates.length === 1) {
      setDetectionState('found', '\u2713 ULD Detected');
      dom.detectionValue.textContent = candidates[0];
      renderCandidates([]);
      attemptSave(candidates[0]);
      return;
    }

    setDetectionState('found', '\u2713 Multiple ULDs Detected');
    dom.detectionValue.textContent = candidates.join(' / ');
    renderCandidates(candidates);
  }

  function extractValidUldCandidates(rawText) {
    if (!rawText) return [];
    const upperText = rawText.toUpperCase();
    // Strip everything except letters/digits so spaces, dashes, underscores,
    // slashes, and line breaks between the three groups no longer block a match.
    const cleanedText = upperText.replace(/[^A-Z0-9]/g, '');
    const matches = cleanedText.match(ULD_REGEX);
    if (!matches) return [];
    return matches.filter(function (val, idx) {
      return matches.indexOf(val) === idx;
    });
  }

  function renderCandidates(candidates) {
    dom.candidateChips.innerHTML = '';
    candidates.forEach(function (code) {
      const chip = document.createElement('div');
      chip.className = 'candidate-chip';
      chip.textContent = code;
      chip.addEventListener('click', function () {
        attemptSave(code, true);
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
    dom.scanningBadgeText.textContent = isScanning ? 'Scanning...' : 'Idle';
  }

  function isDuplicate(uld) {
    const now = Date.now();
    if (state.lastDetectedUld === uld && (now - state.lastDetectedTime) < DUPLICATE_WINDOW_MS) {
      return true;
    }
    return false;
  }

  function markDetected(uld) {
    state.lastDetectedUld = uld;
    state.lastDetectedTime = Date.now();
  }

  function attemptSave(uld, manualPick) {
    if (!manualPick && isDuplicate(uld)) {
      return;
    }

    markDetected(uld);
    renderCandidates([]);

    const record = {
      uld: uld,
      station: dom.stationSelect.value || '',
      user: (dom.userInput.value || '').trim() || 'Unknown',
      timestamp: new Date().toISOString()
    };

    setConnectionStatus(true, 'Saving...');

    // SIMULASI SIMPAN (Kerana GitHub Pages tiada backend DB)
    setTimeout(function () {
      setConnectionStatus(true, 'Camera Ready');
      showToast('Imbasan Dikesan (Simulasi)', 'success');
      updateLastSaved(record);
    }, 800);
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
