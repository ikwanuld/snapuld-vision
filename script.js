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
      state.ocrWorker = Tesseract.createWorker('eng').then(function (worker) {
        state.workerReady = true;
        return worker;
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