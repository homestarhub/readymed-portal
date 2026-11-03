/* HomeStar x ReadyMed Visit Portal - demo logic (no build step, no libraries).
 *
 * What is real:  "Request a visit" can ring the real HomeStar device (through the free ntfy.sh channel you
 *                type into Demo controls), and an incoming call from the device shows a Join button.
 * What is simulated: patients, alerts, biometrics, check-ins, reminders, Medicare minutes.
 * State lives in this browser only (localStorage). Family and Clinician pages share it when they are
 * open in the same browser. Nothing here is sent to a server we run, and no channel name is in this repo.
 */
(function () {
  'use strict';

  var PAGE = document.body.getAttribute('data-page');          // 'family' | 'clinician'
  var STATE_KEY = 'homestar_portal_state_v1';
  var SET_KEY = 'homestar_portal_settings_v1';
  var NTFY = 'https://ntfy.sh';
  var CHANNEL_RE = /^[A-Za-z0-9_-]{6,64}$/;
  var MIN = 60000;

  var PATIENTS = [
    { id: 'margaret', name: 'Margaret D.', first: 'Margaret', real: true },
    { id: 'robert', name: 'Robert T.', first: 'Robert', real: false },
    { id: 'dorothy', name: 'Dorothy L.', first: 'Dorothy', real: false }
  ];

  var TYPES = {
    fall: { level: 'urgent', title: 'Fall detected', photo: true,
      family: 'The camera saw a fall in the bedroom. She did not answer "Are you okay?"',
      clin: 'Camera pose model, confidence 94%. No reply to "Are you okay?" after 30 seconds. Family notified.',
      where: 'Possible fall in the bedroom' },
    help: { level: 'urgent', title: 'Called for help',
      family: 'She said "help" out loud.',
      clin: 'Help phrase heard by the bedside device.',
      where: 'Called for help' },
    no_answer: { level: 'urgent', title: 'No answer to "Are you okay?"',
      family: 'The device asked "Are you okay?" and got no answer.',
      clin: 'No spoken reply within 30 seconds of the check question.',
      where: 'Not answering' },
    left_bed: { level: 'check', title: 'Left the bed',
      family: 'Presence sensor lost her for 20 minutes.',
      clin: 'Presence sensor, 20 minutes away from the bed.',
      where: 'Out of bed' },
    no_move: { level: 'check', title: 'No movement',
      family: 'No movement for 2 hours during the day.',
      clin: 'Presence sensor: no motion for 2 hours, daytime.',
      where: 'No movement detected' },
    offline: { level: 'check', title: 'Device offline',
      family: 'The device lost its connection.',
      clin: 'No heartbeat from the device for 5 minutes.',
      offline: true },
    online: { level: 'info', title: 'Device back online',
      family: 'Wi-Fi was down for 4 minutes and is restored.',
      clin: 'Heartbeat restored after 4 minutes.',
      online: true }
  };

  // ------------------------------------------------------------------ storage
  function readJSON(key, fallback) {
    try {
      var s = window.localStorage.getItem(key);
      return s ? JSON.parse(s) : fallback;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode: keep going in memory */ }
  }

  function seed() {
    var now = Date.now();
    var DAY = 24 * 60 * MIN;
    var d0 = new Date(); d0.setHours(0, 0, 0, 0);
    var sod = d0.getTime();                      // start of today
    return {
      v: 1, nextId: 10,
      alerts: [
        { id: 1, patient: 'margaret', type: 'fall', ts: now - 50 * MIN, ack: false },
        { id: 2, patient: 'margaret', type: 'left_bed', ts: now - 190 * MIN, ack: true },
        { id: 3, patient: 'margaret', type: 'online', ts: now - 260 * MIN, ack: true },
        { id: 4, patient: 'robert', type: 'left_bed', ts: now - 70 * MIN, ack: false }
      ],
      status: {
        margaret: { online: true, where: 'In bed, resting', last: now - 2 * MIN },
        robert: { online: true, where: 'In bed, resting', last: now - 9 * MIN },
        dorothy: { online: true, where: 'In bed, resting', last: now - 4 * MIN }
      },
      bio: { margaret: { ts: now - 40 * MIN, pulse: 72, spo2: 96 } },
      visits: [
        { ts: sod - DAY + (18 * 60 + 10) * MIN, minutes: 14, who: 'Family', patient: 'margaret' },
        { ts: sod - 2 * DAY + (11 * 60 + 30) * MIN, minutes: 9, who: 'Clinician', patient: 'margaret' },
        { ts: sod - 4 * DAY + (19 * 60 + 45) * MIN, minutes: 22, who: 'Family', patient: 'margaret' }
      ],
      minutes: { margaret: 12, robert: 6, dorothy: 0 },
      incoming: null,
      live: null,
      lastMid: ''
    };
  }

  var state = readJSON(STATE_KEY, null);
  if (!state || state.v !== 1) { state = seed(); writeJSON(STATE_KEY, state); }
  var settings = readJSON(SET_KEY, { channel: '', room: '', fast: false });
  var sel = 'margaret';                 // selected patient (clinician page)
  var drawerOpen = false;
  var busy = false;                     // a biometrics reading is running

  function save() { writeJSON(STATE_KEY, state); }
  function saveSettings() { writeJSON(SET_KEY, settings); }

  // ------------------------------------------------------------------ helpers
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function patient(id) { for (var i = 0; i < PATIENTS.length; i++) { if (PATIENTS[i].id === id) { return PATIENTS[i]; } } return PATIENTS[0]; }
  function curId() { return PAGE === 'family' ? 'margaret' : sel; }
  function channelOK() { return CHANNEL_RE.test(settings.channel || ''); }
  function roomOK() { return /^https:\/\//i.test(settings.room || ''); }
  function fmtTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function fmtDay(ts) {
    var d = new Date(ts), now = new Date();
    var startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var t = fmtTime(ts);
    if (ts >= startToday) { return 'Today, ' + t; }
    if (ts >= startToday - 24 * 60 * MIN) { return 'Yesterday, ' + t; }
    return d.toLocaleDateString([], { weekday: 'long' }) + ', ' + t;
  }
  function fmtAgo(ts) {
    var m = Math.round((Date.now() - ts) / MIN);
    if (m < 1) { return 'just now'; }
    if (m < 60) { return m + (m === 1 ? ' minute ago' : ' minutes ago'); }
    var h = Math.round(m / 60);
    return h + (h === 1 ? ' hour ago' : ' hours ago');
  }
  function mmss(secs) {
    secs = Math.max(0, Math.floor(secs));
    var m = Math.floor(secs / 60), s = secs % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function minLabel(m) { return Math.max(1, Math.round(m)) + ' min'; }
  function rand(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    if (!t) { return; }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4500);
  }
  function result(msg) { var r = $('action-result'); if (r) { r.textContent = msg; } }

  // ------------------------------------------------------------------ ntfy transport
  function send(topic, body) {
    return fetch(NTFY + '/' + topic, { method: 'POST', body: body })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  var sources = [];
  var connState = 'off';
  function closeSources() {
    sources.forEach(function (s) { try { s.close(); } catch (e) { /* ignore */ } });
    sources = [];
  }
  function openTopic(topic, handler) {
    var es;
    try { es = new EventSource(NTFY + '/' + topic + '/sse'); } catch (e) { return; }
    es.onopen = function () { connState = 'on'; renderConn(); };
    es.onerror = function () { connState = 'retry'; renderConn(); };
    es.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d && d.event === 'message') { handler(d); }
    };
    sources.push(es);
  }
  function connect() {
    closeSources();
    if (!channelOK()) { connState = 'off'; renderConn(); return; }
    connState = 'retry';
    openTopic(settings.channel + '-doctor', onCallMessage);
    openTopic(settings.channel + '-alerts', onAlertMessage);
    renderConn();
  }

  // The patient said "call my doctor / family": the device posts to <channel>-doctor with a Click link.
  function onCallMessage(d) {
    if (d.id && d.id === state.lastMid) { return; }           // another tab already took this one
    state = readJSON(STATE_KEY, state);
    state.lastMid = d.id || '';
    state.incoming = { from: 'patient', patient: 'margaret', link: d.click || '', ts: Date.now(), simulated: false };
    save();
    renderAll();
  }
  // Optional: the device posts alerts to <channel>-alerts as plain words ("fall", "left the bed", ...).
  function onAlertMessage(d) {
    if (d.id && d.id === state.lastMid) { return; }
    var text = String(d.message || '').toLowerCase();
    var type = null;
    if (text.indexOf('fall') >= 0) { type = 'fall'; }
    else if (text.indexOf('help') >= 0) { type = 'help'; }
    else if (text.indexOf('answer') >= 0) { type = 'no_answer'; }
    else if (text.indexOf('bed') >= 0) { type = 'left_bed'; }
    else if (text.indexOf('movement') >= 0 || text.indexOf('motion') >= 0) { type = 'no_move'; }
    else if (text.indexOf('offline') >= 0) { type = 'offline'; }
    else if (text.indexOf('online') >= 0) { type = 'online'; }
    if (!type) { return; }
    state = readJSON(STATE_KEY, state);
    state.lastMid = d.id || '';
    addAlert('margaret', type);
  }

  // ------------------------------------------------------------------ actions
  function addAlert(pid, type) {
    var t = TYPES[type];
    state.alerts.unshift({ id: state.nextId++, patient: pid, type: type, ts: Date.now(), ack: false });
    var st = state.status[pid];
    st.last = Date.now();
    if (t.offline) { st.online = false; }
    if (t.online) { st.online = true; st.where = 'In bed, resting'; }
    if (t.where) { st.where = t.where; }
    save();
    renderAll();
  }

  function requestVisit() {
    if (state.live) { toast('A visit is already in progress.'); return; }
    var pid = curId();
    var p = patient(pid);
    if (p.real && channelOK()) {
      send(settings.channel, 'call').then(function (ok) {
        if (!ok) { toast('Could not reach the ring channel. Check the internet connection.'); }
      });
      if (roomOK()) { window.open(settings.room, '_blank', 'noopener'); }
      state.live = { patient: pid, start: Date.now(), phase: 'connected', mode: 'real', via: PAGE };
      result('Ring sent to the real device.' + (roomOK() ? ' The video room opened in a new tab.' : ' Add the video room link in Demo controls so this button opens it for you.'));
    } else {
      state.live = { patient: pid, start: Date.now(), phase: 'ringing', mode: 'simulated', via: PAGE };
      result(p.real ? 'Simulated: no device channel is set, so nothing real rang. Open Demo controls to add one.' : p.first + ' is a demo patient with no device. Simulated visit.');
    }
    save();
    renderAll();
  }

  function endVisit() {
    var L = state.live;
    if (!L) { return; }
    if (L.phase === 'connected') {
      var secs = (Date.now() - L.start) / 1000;
      var mins = (secs / 60) * (settings.fast ? 60 : 1);
      state.minutes[L.patient] = (state.minutes[L.patient] || 0) + mins;
      var who = L.via === 'patient' ? 'Patient call' : (L.via === 'clinician' ? 'Clinician' : 'Family');
      state.visits.unshift({ ts: L.start, minutes: mins, who: who, patient: L.patient });
    }
    if (L.mode === 'real' && channelOK()) { send(settings.channel, 'hangup'); }
    state.live = null;
    save();
    renderAll();
    toast('Visit ended.');
  }

  function answerIncoming() {
    var inc = state.incoming;
    if (!inc) { return; }
    if (inc.link && /^https:\/\//i.test(inc.link)) {
      window.open(inc.link, '_blank', 'noopener');
    } else if (roomOK() && !inc.simulated) {
      window.open(settings.room, '_blank', 'noopener');
    }
    var real = !inc.simulated;
    state.live = { patient: inc.patient || 'margaret', start: Date.now(), phase: 'connected', mode: real ? 'real' : 'simulated', via: 'patient', answered: true };
    state.incoming = null;
    save();
    renderAll();
  }

  function checkin() {
    var p = patient(curId());
    result('Check-in sent (simulated). The chime played and ' + p.first + ' said "answer." Nothing real rang.');
    state.visits.unshift({ ts: Date.now(), minutes: 0, who: 'Check-in', patient: p.id });
    save();
    renderAll();
  }

  function reminderSend() {
    var inp = $('reminder-text');
    var text = inp ? inp.value.trim() : '';
    if (!text) { toast('Type what the device should say.'); return; }
    result('Reminder sent (simulated): "' + text + '". The real device will speak it once voice reminders are built.');
    var box = $('reminder-box');
    if (box) { box.hidden = true; }
  }

  function biometrics() {
    if (busy) { return; }
    busy = true;
    var pid = curId();
    var secs = 6;
    function step() {
      if (secs > 0) {
        result('Measuring... ' + secs + ' s (about 30 s on the real device; demo is shortened). Experimental.');
        secs--;
        setTimeout(step, 1000);
      } else {
        state.bio[pid] = { ts: Date.now(), pulse: rand(62, 86), spo2: rand(94, 99) };
        busy = false;
        save();
        result('Reading saved. Experimental camera estimate, simulated.');
        renderAll();
      }
    }
    step();
  }

  function resetDemo() {
    state = seed();
    save();
    result('');
    renderAll();
    toast('Demo reset.');
  }

  // ------------------------------------------------------------------ rendering
  function pillFor(level) {
    var label = level === 'urgent' ? 'Urgent' : (level === 'check' ? 'Check' : 'Info');
    return '<span class="pill ' + level + '">' + label + '</span>';
  }

  function renderConn() {
    var el = $('conn');
    if (el) {
      if (channelOK()) {
        el.innerHTML = '<span class="pill live">Live device link' + (connState === 'on' ? '' : ' (connecting)') + '</span>';
      } else { el.innerHTML = ''; }
    }
    var line = $('conn-line');
    if (line) {
      if (!channelOK()) { line.textContent = 'No channel set: visits are simulated.'; }
      else if (connState === 'on') { line.textContent = 'Connected. Visits ring the real device and incoming calls show up here.'; }
      else { line.textContent = 'Channel saved. Connecting...'; }
    }
  }

  function renderIncoming() {
    var el = $('incoming');
    if (!el) { return; }
    var inc = state.incoming;
    if (!inc) { el.innerHTML = ''; return; }
    var who = patient(inc.patient || 'margaret');
    var headline = PAGE === 'family' ? who.first + ' is calling you' : who.name + ' is calling';
    var said = PAGE === 'family' ? 'She said "call my family" just now.' : 'She said "call my doctor" just now.';
    el.innerHTML =
      '<div class="banner" role="alert"><div><div class="eyebrow">Incoming call' + (inc.simulated ? ' (simulated)' : '') + '</div>' +
      '<div class="big">' + esc(headline) + '</div><div class="small muted">' + esc(said) + '</div></div>' +
      '<div class="btns"><button class="btn primary small" data-action="join" type="button">Join</button>' +
      '<button class="btn small" data-action="dismiss" type="button">Not now</button></div></div>';
  }

  function renderLive() {
    var el = $('visit-live');
    if (!el) { return; }
    var L = state.live;
    if (!L) { el.innerHTML = ''; return; }
    var p = patient(L.patient);
    if (L.phase === 'ringing') {
      el.innerHTML = '<div class="banner plain"><div><div class="eyebrow">Calling</div><div class="big">Ringing ' + esc(p.first) + '\'s bedside...</div>' +
        '<div class="small muted">Simulated. She just says "answer."</div></div>' +
        '<div class="btns"><button class="btn small" data-action="end" type="button">Cancel</button></div></div>';
      return;
    }
    var secs = (Date.now() - L.start) / 1000;
    var shown = settings.fast ? secs * 60 : secs;
    el.innerHTML = '<div class="banner ok"><div><div class="eyebrow">Visit in progress' + (L.mode === 'real' ? ' (real device)' : ' (simulated)') + '</div>' +
      '<div class="big">' + esc(p.first) + ' &middot; <span class="timer" id="visit-timer">' + mmss(shown) + '</span></div>' +
      '<div class="small muted">' + (settings.fast ? 'Fast clock: 1 second counts as 1 minute.' : 'Minutes are recorded when you end the visit.') + '</div></div>' +
      '<div class="btns">' +
      (L.mode === 'real' && roomOK() ? '<a class="btn small" href="' + esc(settings.room) + '" target="_blank" rel="noopener">Open video room</a>' : '') +
      '<button class="btn primary small" data-action="end" type="button">End visit</button></div></div>';
  }

  function alertsFor(pid) {
    return state.alerts.filter(function (a) { return a.patient === pid; }).sort(function (a, b) { return b.ts - a.ts; });
  }

  function renderAlerts() {
    var el = $('alerts');
    if (!el) { return; }
    var pid = curId();
    var list = alertsFor(pid);
    var count = $('alerts-count');
    if (count) {
      var today = list.filter(function (a) { return Date.now() - a.ts < 24 * 60 * MIN; }).length;
      count.textContent = (PAGE === 'clinician' ? patient(pid).name + ', ' : '') + today + ' today';
    }
    if (!list.length) { el.innerHTML = '<div class="empty">No alerts. Everything looks normal.</div>'; return; }
    el.innerHTML = list.map(function (a) {
      var t = TYPES[a.type];
      var detail = PAGE === 'family' ? t.family : t.clin;
      var action = '';
      if (PAGE === 'family' && t.level === 'urgent' && !a.ack) {
        action = '<button class="btn primary small" data-action="request-visit" type="button">Call now</button>';
      } else if (PAGE === 'clinician' && !a.ack && t.level !== 'info') {
        action = (t.level === 'urgent' ? '<button class="btn primary small" data-action="request-visit" type="button">Call now</button> ' : '') +
          '<button class="btn small" data-action="ack" data-id="' + a.id + '" type="button">Acknowledge</button>';
      } else if (PAGE === 'family' && !a.ack && t.level === 'check') {
        action = '<button class="btn small" data-action="request-visit" type="button">Call now</button>';
      }
      var photo = t.photo ? '<div class="photo">Fall photo<br>(simulated)</div>' : '';
      return '<div class="alert' + (a.ack ? ' done' : '') + '">' + photo +
        '<div class="body"><div class="head">' + pillFor(t.level) + '<span class="name">' + esc(t.title) + '</span>' +
        '<span class="time">' + esc(fmtTime(a.ts)) + '</span></div>' +
        '<div class="detail">' + esc(detail) + (a.ack ? ' Acknowledged.' : '') + '</div></div>' +
        (action ? '<div style="display:flex;gap:8px;flex-wrap:wrap">' + action + '</div>' : '') + '</div>';
    }).join('');
  }

  function renderStatus() {
    var el = $('status');
    if (!el) { return; }
    var st = state.status.margaret;
    var last = state.visits.filter(function (v) { return v.patient === 'margaret' && v.minutes > 0; })[0];
    el.innerHTML = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><span class="dot' + (st.online ? '' : ' off') + '"></span>' +
      '<strong>' + (st.online ? 'Device online' : 'Device offline') + '</strong></div>' +
      '<div class="kv">' + esc(st.where) + '<br>Last activity ' + esc(fmtAgo(st.last)) + '<br>' +
      (last ? 'Last visit: ' + esc(fmtDay(last.ts)) + ', ' + minLabel(last.minutes) : 'No visits yet') + '</div>';
  }

  function renderBio() {
    var el = $('bio');
    if (!el) { return; }
    var b = state.bio[curId()];
    if (PAGE === 'family') {
      el.innerHTML = '<div class="row-between" style="margin-bottom:12px"><h3 style="margin:0">Last biometrics reading</h3><span class="pill exp">Experimental</span></div>' +
        (b ? '<div class="small muted">' + esc(fmtTime(b.ts)) + '</div><div class="bigvalue">' + b.pulse + ' <small>pulse estimate</small></div>'
           : '<div class="empty">No reading yet. Tap Take Biometrics.</div>') +
        '<div class="note" style="margin-top:8px">Estimated from the camera. Not for medical decisions. Simulated reading.</div>';
    } else {
      el.innerHTML = '<div class="row-between" style="margin-bottom:12px"><h3 style="margin:0">Biometrics</h3><span class="pill exp">Experimental</span></div>' +
        (b ? '<div style="font-size:14px;line-height:1.8">' + esc(fmtTime(b.ts)) + '<br>Pulse estimate ' + b.pulse + ' &middot; SpO2 estimate ' + b.spo2 + '%<br><span class="muted">Blood pressure: not available</span></div>'
           : '<div class="empty">No reading yet for this patient.</div>') +
        '<div class="note" style="margin-top:8px">Camera estimates, simulated. Not validated and kept out of billing and the clinical record.</div>';
    }
  }

  function renderVisits() {
    var el = $('visits');
    if (!el) { return; }
    var rows = state.visits.filter(function (v) { return v.patient === 'margaret'; }).slice(0, 4);
    el.innerHTML = '<h3>Recent visits</h3>' + (rows.length ? rows.map(function (v) {
      return '<div class="list-row"><span>' + esc(fmtDay(v.ts)) + '</span><span class="muted">' + (v.minutes > 0 ? minLabel(v.minutes) : esc(v.who)) + '</span></div>';
    }).join('') : '<div class="empty">No visits yet.</div>');
  }

  function renderPatients() {
    var el = $('patients');
    if (!el) { return; }
    el.innerHTML = '<h3>My patients</h3>' + PATIENTS.map(function (p) {
      var open = alertsFor(p.id).filter(function (a) { return !a.ack && TYPES[a.type].level !== 'info'; });
      var urgent = open.filter(function (a) { return TYPES[a.type].level === 'urgent'; }).length;
      var badge = urgent ? '<span class="pill urgent">' + urgent + ' urgent</span>'
        : (open.length ? '<span class="pill check">' + open.length + ' check</span>' : '<span class="small muted">No alerts</span>');
      return '<button class="patient' + (p.id === sel ? ' active' : '') + '" data-action="select" data-id="' + p.id + '" type="button">' +
        '<div class="top"><span class="nm">' + esc(p.name) + '</span>' + badge + '</div>' +
        '<div class="st">' + (state.status[p.id].online ? 'Device online' : 'Device offline') + '</div></button>';
    }).join('');
    var nm = $('sel-name');
    if (nm) { nm.textContent = patient(sel).name; }
  }

  function renderMinutes() {
    var el = $('minutes');
    if (!el) { return; }
    var m = state.minutes[sel] || 0;
    var pct = Math.min(100, (m / 20) * 100);
    var note;
    if (m >= 40) { note = '40-minute mark reached.'; }
    else if (m >= 20) { note = '20-minute mark reached. ' + Math.ceil(40 - m) + ' more minutes to the 40-minute mark.'; }
    else { note = Math.ceil(20 - m) + ' more minutes to the 20-minute mark.'; }
    var month = new Date().toLocaleDateString([], { month: 'long' });
    el.innerHTML = '<h3 style="margin-bottom:4px">Medicare RPM minutes</h3><div class="small muted" style="margin-bottom:12px">' + esc(month) + ', simulated</div>' +
      '<div class="bigvalue">' + Math.floor(m) + ' <small>min logged</small></div>' +
      '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="20" aria-valuenow="' + Math.min(20, Math.floor(m)) + '"><div style="width:' + pct + '%"></div></div>' +
      '<div class="note">' + esc(note) + ' Call minutes are recorded automatically. Billing happens in OmniMD.</div>';
  }

  function renderCallLog() {
    var el = $('calllog');
    if (!el) { return; }
    var rows = state.visits.filter(function (v) { return v.patient === sel; }).slice(0, 5);
    el.innerHTML = '<h3>Call log</h3>' + (rows.length ? rows.map(function (v) {
      return '<div class="list-row"><span>' + esc(fmtDay(v.ts)) + '</span><span class="muted">' + (v.minutes > 0 ? minLabel(v.minutes) + ' &middot; ' : '') + esc(v.who) + '</span></div>';
    }).join('') : '<div class="empty">No calls yet.</div>');
  }

  function renderAll() {
    renderIncoming();
    renderLive();
    renderAlerts();
    renderStatus();
    renderBio();
    renderVisits();
    renderPatients();
    renderMinutes();
    renderCallLog();
    renderConn();
  }

  // ------------------------------------------------------------------ demo controls drawer
  function buildDrawer() {
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'drawer-toggle';
    toggle.setAttribute('data-action', 'drawer');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.textContent = 'Demo controls';
    document.body.appendChild(toggle);

    var d = document.createElement('div');
    d.className = 'drawer';
    d.id = 'drawer';
    d.hidden = true;
    d.innerHTML =
      '<h2>Demo controls</h2><div class="note">For the presenter. Settings stay in this browser only.</div>' +
      '<h3>Device link (real)</h3>' +
      '<label for="set-channel">Device channel name</label>' +
      '<input id="set-channel" type="text" autocomplete="off" spellcheck="false" placeholder="homestar-xxxxxxxxxx">' +
      '<label for="set-room">Video room link (https://meet.jit.si/...)</label>' +
      '<input id="set-room" type="url" autocomplete="off" spellcheck="false" placeholder="https://meet.jit.si/HomeStarHub-...">' +
      '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn small primary" data-action="save-settings" type="button">Save</button>' +
      '<button class="btn small" data-action="clear-settings" type="button">Clear</button></div>' +
      '<div class="status-line muted" id="conn-line"></div>' +
      '<div class="check"><input id="set-fast" type="checkbox"><label for="set-fast" style="margin:0;font-weight:500">Fast clock: 1 second counts as 1 minute</label></div>' +
      '<h3>Simulate an event</h3><div class="simgrid">' +
      '<button class="btn small" data-sim="fall" type="button">Fall</button>' +
      '<button class="btn small" data-sim="help" type="button">Called for help</button>' +
      '<button class="btn small" data-sim="no_answer" type="button">No answer</button>' +
      '<button class="btn small" data-sim="left_bed" type="button">Left the bed</button>' +
      '<button class="btn small" data-sim="no_move" type="button">No movement</button>' +
      '<button class="btn small" data-sim="offline" type="button">Device offline</button>' +
      '<button class="btn small" data-sim="online" type="button">Back online</button>' +
      '<button class="btn small" data-action="sim-call" type="button">Patient calls</button>' +
      '<button class="btn small" data-action="biometrics" type="button">Biometrics reading</button>' +
      '<button class="btn small" data-action="reset" type="button">Reset demo</button></div>';
    document.body.appendChild(d);

    var t = document.createElement('div');
    t.id = 'toast';
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.hidden = true;
    document.body.appendChild(t);

    $('set-channel').value = settings.channel || '';
    $('set-room').value = settings.room || '';
    $('set-fast').checked = !!settings.fast;
    $('set-fast').addEventListener('change', function () {
      settings.fast = $('set-fast').checked;
      saveSettings();
      renderAll();
    });

    var conn = document.createElement('span');
    conn.id = 'conn';
    var right = document.querySelector('.topbar .right');
    if (right) { right.insertBefore(conn, right.firstChild); }
  }

  function toggleDrawer() {
    drawerOpen = !drawerOpen;
    $('drawer').hidden = !drawerOpen;
    document.querySelector('.drawer-toggle').setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
  }

  function saveSettingsFromForm() {
    var ch = $('set-channel').value.trim();
    var room = $('set-room').value.trim();
    if (ch && !CHANNEL_RE.test(ch)) { toast('Channel names use letters, numbers, dash or underscore (6 to 64 characters).'); return; }
    if (room && !/^https:\/\//i.test(room)) { toast('The video room link must start with https://'); return; }
    settings.channel = ch;
    settings.room = room;
    saveSettings();
    connect();
    renderAll();
    toast(ch ? 'Saved. Visits now ring the real device.' : 'Saved. Visits are simulated.');
  }

  // ------------------------------------------------------------------ events
  document.addEventListener('click', function (e) {
    var simBtn = e.target.closest('[data-sim]');
    if (simBtn) {
      addAlert(curId(), simBtn.getAttribute('data-sim'));
      return;
    }
    var el = e.target.closest('[data-action]');
    if (!el) { return; }
    switch (el.getAttribute('data-action')) {
      case 'request-visit': requestVisit(); break;
      case 'end': endVisit(); break;
      case 'checkin': checkin(); break;
      case 'biometrics': biometrics(); break;
      case 'reminder-open': { var b = $('reminder-box'); if (b) { b.hidden = !b.hidden; } break; }
      case 'reminder-send': reminderSend(); break;
      case 'join': answerIncoming(); break;
      case 'dismiss': state.incoming = null; save(); renderAll(); break;
      case 'ack': {
        var id = parseInt(el.getAttribute('data-id'), 10);
        state.alerts.forEach(function (a) { if (a.id === id) { a.ack = true; } });
        save(); renderAll(); break;
      }
      case 'select': sel = el.getAttribute('data-id'); result(''); renderAll(); break;
      case 'omnimd': toast('In the real product this opens OmniMD for vitals and billing.'); break;
      case 'drawer': toggleDrawer(); break;
      case 'save-settings': saveSettingsFromForm(); break;
      case 'clear-settings': settings.channel = ''; settings.room = ''; saveSettings(); $('set-channel').value = ''; $('set-room').value = ''; connect(); renderAll(); toast('Cleared. Visits are simulated.'); break;
      case 'sim-call':
        state.incoming = { from: 'patient', patient: curId(), link: '', ts: Date.now(), simulated: true };
        save(); renderAll(); break;
      case 'reset': resetDemo(); break;
      default: break;
    }
  });

  window.addEventListener('storage', function (e) {
    if (e.key === STATE_KEY) { state = readJSON(STATE_KEY, state); renderAll(); }
  });

  // one tick per half second: advance a simulated ring, update the visit timer
  setInterval(function () {
    var L = state.live;
    if (L && L.phase === 'ringing' && Date.now() - L.start >= 3000) {
      L.phase = 'connected';
      L.start = Date.now();
      save();
      renderAll();
      return;
    }
    if (L && L.phase === 'connected') {
      var t = $('visit-timer');
      if (t) {
        var secs = (Date.now() - L.start) / 1000;
        t.textContent = mmss(settings.fast ? secs * 60 : secs);
      }
    }
  }, 500);

  buildDrawer();
  renderAll();
  connect();
})();
