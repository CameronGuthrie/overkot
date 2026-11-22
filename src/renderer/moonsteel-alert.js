'use strict';
(() => {
  const envelope = document.getElementById('flash-envelope');
  const glow = document.getElementById('edge-glow');
  let audio = null, soundTimer = null, disposed = false;
  const presets = {
    chime: { type: 'sine', notes: [[0, 880, .5], [.18, 1174.66, .6], [.36, 1567.98, .8]] },
    soft: { type: 'sine', notes: [[0, 523.25, .8], [.3, 659.25, .8], [.55, 783.99, .65]] },
    beacon: { type: 'triangle', notes: [[0, 659.25, .3], [.2, 987.77, .3], [.4, 1318.51, .65]] },
  };
  function stopAudio() {
    if (soundTimer !== null) clearTimeout(soundTimer);
    soundTimer = null;
    if (audio) {
      const previous = audio; audio = null;
      Promise.resolve().then(() => previous.close()).catch(() => {});
    }
  }
  async function playSound(settings) {
    if (!settings.soundEnabled || settings.volume <= 0) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) { document.documentElement.dataset.audioState = 'unavailable'; return; }
    let context;
    try {
      context = new AudioContext(); audio = context;
      await context.resume();
      if (disposed || audio !== context) { if (audio === context) stopAudio(); return; }
      document.documentElement.dataset.audioState = context.state;
      const master = context.createGain(); master.gain.value = settings.volume; master.connect(context.destination);
      const preset = presets[settings.sound];
      for (const [offset, frequency, duration] of preset.notes) {
        const oscillator = context.createOscillator(), gain = context.createGain();
        const start = context.currentTime + offset;
        oscillator.type = preset.type; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(.18, start + .018);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        oscillator.connect(gain); gain.connect(master);
        oscillator.start(start); oscillator.stop(start + duration + .03);
      }
      document.documentElement.dataset.soundPlayed = settings.sound;
      soundTimer = setTimeout(stopAudio, 1600);
    } catch {
      document.documentElement.dataset.audioState = 'failed';
      if (audio === context) stopAudio();
    }
  }
  const unsubscribe = window.moonsteelAlert.onData(payload => {
    if (disposed) return;
    stopAudio();
    const settings = window.MoonsteelAlertSettings.normalize(payload?.settings);
    const style = document.documentElement.style;
    style.setProperty('--edge-color', settings.color);
    style.setProperty('--edge-width', settings.borderWidth + 'px');
    style.setProperty('--edge-spread', settings.borderWidth + settings.blur + 'px');
    style.setProperty('--edge-opacity', String(settings.opacity));
    style.setProperty('--alert-duration', settings.duration + 's');
    style.setProperty('--pulse-period', 1 / settings.pulseSpeed + 's');
    envelope.classList.remove('active'); glow.classList.remove('active');
    document.documentElement.dataset.flashEnabled = String(settings.flashEnabled);
    document.documentElement.dataset.soundPlayed = '';
    if (settings.flashEnabled && settings.opacity > 0) {
      void envelope.offsetWidth;
      envelope.classList.add('active'); glow.classList.add('active');
    }
    void playSound(settings);
  });
  window.addEventListener('unload', () => {
    disposed = true; unsubscribe?.(); stopAudio();
  }, { once: true });
})();
