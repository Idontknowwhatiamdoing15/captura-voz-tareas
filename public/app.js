(() => {
  // ── Elements ──────────────────────────────────────────────────────────────
  const body        = document.body;
  const captureBtn  = document.getElementById('capture-btn');
  const retryBtn    = document.getElementById('retry-btn');
  const transcriptEl= document.getElementById('transcript');
  const statusEl    = document.getElementById('status');

  // ── State machine ────────────────────────────────────────────────────────
  // States: idle | listening | sending | success | error
  const STATES = {
    idle:      { status: 'Toca para hablar' },
    listening: { status: 'Escuchando…' },
    sending:   { status: 'Enviando a Notion…' },
    success:   { status: '¡Tarea guardada!' },
    error:     { status: '' },  // message set dynamically
  };

  let currentState = 'idle';
  let finalText    = '';
  let silenceTimer = null;

  function setState(state, message) {
    currentState = state;
    body.className = state;
    statusEl.textContent = message ?? STATES[state].status;
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

  // ── Silence detection ────────────────────────────────────────────────────
  const SILENCE_DELAY_MS = 2000;

  function resetSilenceTimer() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(sendTask, SILENCE_DELAY_MS);
  }

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
    transcriptEl.textContent = finalText + interim;
    resetSilenceTimer();
  };

  recognition.onerror = (event) => {
    clearTimeout(silenceTimer);
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
      setState('idle', 'No se capturó texto. Toca para intentar de nuevo.');
    }
  };

  // ── Send task ─────────────────────────────────────────────────────────────
  async function sendTask() {
    clearTimeout(silenceTimer);
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
          transcriptEl.textContent = '';
          setState('idle');
        }, 1500);
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
      // Second tap while listening — cancel
      clearTimeout(silenceTimer);
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

  // ── Service Worker registration ──────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service Worker registration failed:', err);
      });
    });
  }
})();
