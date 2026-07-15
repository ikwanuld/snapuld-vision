(function () {
  'use strict';

  const ULD_REGEX = /[A-Z]{3}\d{5}[A-Z]{2}/g; 
  const OCR_INTERVAL_MS = 2500;               
  const DUPLICATE_WINDOW_MS = 10000;          

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
    // Fallback list langsung di frontend
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
        height: { ideal: 720 }
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
      .then(recognizeText)
      .then(handleOcrResult)
      .catch(function (err) {
        console.error('OCR error:', err);
        setDetectionState('none', 'No ULD Found');
        // Surface the real error instead of just showing "not found" -
        // this is usually the CDN/worker failing to load, not a scanning miss
        showToast('OCR error: ' + (err && err.message ? err.message : 'unknown'), 'danger');
      })
      .finally(function () {
        state.ocrRunning = false;
        setScanningIndicator(false);
      });
  }

  // How much of the video frame to crop, matching the .scan-frame CSS inset (12%)
  const SCAN_INSET_RATIO = 0.12;
  // Upscale the cropped region before OCR - small crops read much better upscaled
  const UPSCALE_FACTOR = 2;

  function captureFrame() {
    return new Promise(function (resolve, reject) {
      const video = dom.video;
      if (!video.videoWidth) {
        reject(new Error('Video not ready'));
        return;
      }

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const insetX = vw * SCAN_INSET_RATIO;
      const insetY = vh * SCAN_INSET_RATIO;
      const cropW = vw - insetX * 2;
      const cropH = vh - insetY * 2;

      const canvas = dom.canvas;
      canvas.width = cropW * UPSCALE_FACTOR;
      canvas.height = cropH * UPSCALE_FACTOR;
      const ctx = canvas.getContext('2d');

      // Draw only the region inside the scan-frame guide, upscaled
      ctx.drawImage(
        video,
        insetX, insetY, cropW, cropH,   // source rect (crop)
        0, 0, canvas.width, canvas.height // dest rect (upscaled)
      );

      preprocessForOcr(ctx, canvas.width, canvas.height);
      resolve(canvas);
    });
  }

  // Grayscale + contrast stretch/threshold - helps a lot on stamped/embossed ULD tags
  function preprocessForOcr(ctx, w, h) {
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // First pass: convert to grayscale, track min/max for contrast stretch
    let min = 255, max = 0;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const g = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      gray[p] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }

    const range = Math.max(1, max - min);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const stretched = ((gray[p] - min) / range) * 255;
      data[i] = data[i + 1] = data[i + 2] = stretched;
    }

    ctx.putImageData(imageData, 0, 0);
  }

  function recognizeText(canvas) {
    setDetectionState('searching', 'Searching...');
    return getOcrWorker().then(function (worker) {
      return worker.recognize(canvas);
    }).then(function (result) {
      return (result && result.data && result.data.text) ? result.data.text : '';
    });
  }

  function getOcrWorker() {
    if (state.ocrWorker && state.workerReady) {
      return Promise.resolve(state.ocrWorker);
    }
    if (!state.ocrWorker) {
      state.ocrWorker = Tesseract.createWorker('eng')
        .then(function (worker) {
          // Tune Tesseract for short alphanumeric codes rather than paragraphs of text
          return worker.setParameters({
            tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            tessedit_pageseg_mode: '11' // sparse text - good for isolated codes/labels
          }).then(function () { return worker; });
        })
        .then(function (worker) {
          state.workerReady = true;
          return worker;
        })
        .catch(function (err) {
          state.ocrWorker = null; // allow retry on next cycle
          throw err;
        });
    }
    return state.ocrWorker;
  }

  function handleOcrResult(rawText) {
    const candidates = extractValidUldCandidates(rawText);

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
    const cleanedText = upperText.replace(/[-_\\\/]/g, ' ');
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
    if (kind !== 'found') {
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
    setTimeout(function() {
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
