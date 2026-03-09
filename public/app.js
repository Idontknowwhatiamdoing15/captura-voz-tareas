(() => {
  // ── Elements ──────────────────────────────────────────────────────────────
  const body          = document.body;
  const captureBtn    = document.getElementById('capture-btn');
  const retryBtn      = document.getElementById('retry-btn');
  const transcriptEl  = document.getElementById('transcript');
  const statusEl      = document.getElementById('status');
  const countdownRing = document.getElementById('countdown-ring');

  // ── State machine ────────────────────────────────────────────────────────
  // States: idle | listening | sending | success | error
  // "countdown" is a CSS sub-state of listening (body gets both classes)
  const STATES = {
    idle:      { status: 'Toca para hablar' },
    listening: { status: 'Escuchando… · Toca para cancelar' },
    sending:   { status: 'Enviando a Notion…' },
    success:   { status: '¡Tarea guardada!' },
    error:     { status: '' },  // message set dynamically
  };

  let currentState      = 'idle';
  let finalText         = '';
  let silenceTimer      = null;
  let countdownInterval = null;

  function setState(state, message) {
    currentState = state;
    body.className = state;
    if (state === 'error' && finalText.trim()) {
      body.classList.add('error-retryable');
      captureBtn.setAttribute('aria-label', 'Reintentar envío');
    } else if (state === 'idle') {
      captureBtn.setAttribute('aria-label', 'Iniciar captura de voz');
    }
    statusEl.textContent = message ?? STATES[state].status;
  }

  // ── Countdown indicator ───────────────────────────────────────────────────
  const SILENCE_DELAY_MS = 2000;

  function stopCountdown() {
    clearInterval(countdownInterval);
    countdownInterval = null;
    body.classList.remove('countdown');
    countdownRing.classList.remove('animating');
    if (currentState === 'listening') {
      statusEl.textContent = STATES.listening.status;
    }
  }

  function startCountdown() {
    body.classList.add('countdown');
    let seconds = Math.ceil(SILENCE_DELAY_MS / 1000);
    statusEl.textContent = `Enviando en ${seconds}s… (toca para cancelar)`;

    // Reset SVG ring animation by removing and re-adding class
    countdownRing.classList.remove('animating');
    void countdownRing.offsetWidth; // force reflow
    countdownRing.classList.add('animating');

    countdownInterval = setInterval(() => {
      seconds--;
      if (seconds > 0) {
        statusEl.textContent = `Enviando en ${seconds}s… (toca para cancelar)`;
      } else {
        clearInterval(countdownInterval);
      }
    }, 1000);
  }

  // ── Silence detection ────────────────────────────────────────────────────
  function resetSilenceTimer() {
    clearTimeout(silenceTimer);
    stopCountdown();
    if (finalText.trim()) {
      startCountdown();
    }
    silenceTimer = setTimeout(sendTask, SILENCE_DELAY_MS);
  }

  // ── Speech Recognition ───────────────────────────────────────────────────
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    setState('error', 'Tu navegador no soporta reconocimiento de voz. Usa Chrome en Android.');
    captureBtn.disabled = true;
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang            = navigator.language || 'es-ES';
  recognition.continuous      = false;
  recognition.interimResults  = true;
  recognition.maxAlternatives = 1;

  // ── Recognition events ───────────────────────────────────────────────────
  recognition.onstart = () => {
    setState('listening');
    transcriptEl.textContent = '';
    finalText = '';
  };

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }
    // Final text is shown at full opacity; interim text (still being processed
    // by the browser) is wrapped in a <span> and dimmed so the user can tell
    // which part is "locked in" and which may still change.
    const safeInterim = interim
      ? `<span class="interim">${interim.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</span>`
      : '';
    transcriptEl.innerHTML = finalText.replace(/&/g,'&amp;').replace(/</g,'&lt;') + safeInterim;
    resetSilenceTimer();
  };

  recognition.onerror = (event) => {
    clearTimeout(silenceTimer);
    stopCountdown();
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      setState('error', 'Activa el micrófono en los ajustes del navegador.');
    } else if (event.error === 'no-speech') {
      setState('idle', 'No se detectó voz. Toca para intentar de nuevo.');
      transcriptEl.textContent = '';
    } else if (event.error === 'network') {
      setState('error', 'Sin conexión. Comprueba el internet e inténtalo de nuevo.');
    } else {
      setState('idle', 'Error al escuchar. Toca para intentar de nuevo.');
    }
  };

  recognition.onend = () => {
    // If recognition ends naturally before silence timer fires,
    // the timer will still send after SILENCE_DELAY_MS.
    // If we're still listening and have no text, return to idle.
    if (currentState === 'listening' && !finalText.trim()) {
      clearTimeout(silenceTimer);
      stopCountdown();
      setState('idle', 'No se capturó texto. Toca para intentar de nuevo.');
    }
  };

  // ── Send task ─────────────────────────────────────────────────────────────
  async function sendTask() {
    clearTimeout(silenceTimer);
    stopCountdown();
    const text = finalText.trim();
    if (!text) {
      setState('idle', 'No se capturó texto. Toca para intentar de nuevo.');
      return;
    }

    setState('sending');

    try {
      const response = await fetch('/api/add-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (response.ok) {
        setState('success');
        setTimeout(() => {
          setState('idle');
          transcriptEl.textContent = '';
        }, 2500);
      } else {
        const data = await response.json().catch(() => ({}));
        setState('error', data.error || 'Error al guardar. Toca Reintentar.');
      }
    } catch {
      setState('error', 'Sin conexión. Toca Reintentar cuando tengas internet.');
    }
  }

  // ── Button handlers ──────────────────────────────────────────────────────
  captureBtn.addEventListener('click', () => {
    if (currentState === 'sending' || currentState === 'success') return;

    if (currentState === 'listening') {
      // Second tap while listening (or during countdown) — cancel
      clearTimeout(silenceTimer);
      stopCountdown();
      recognition.stop();
      setState('idle');
      transcriptEl.textContent = '';
      return;
    }

    // idle or error → start listening
    transcriptEl.textContent = '';
    finalText = '';
    try {
      recognition.start();
    } catch {
      // recognition already started — ignore
    }
  });

  retryBtn.addEventListener('click', () => {
    if (finalText.trim()) {
      sendTask();
    } else {
      setState('idle');
      transcriptEl.textContent = '';
    }
  });

  // ── Auto-start on icon tap ────────────────────────────────────────────────
  if (new URLSearchParams(location.search).get('action') === 'record') {
    try {
      recognition.start();
    } catch {
      // recognition already started — ignore
    }
  }

  // ── Service Worker registration ──────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service Worker registration failed:', err);
      });
    });
  }
})();
