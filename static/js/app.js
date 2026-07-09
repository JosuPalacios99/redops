/* Estado y lógica de la SPA. */
const App = {
  state: {
    cursor: new Date(),        // mes visible
    view: 'month',
    data: { audits: [], events: [], vacations: [], types: {}, teammates: {} },
    notes: [],
    todos: [],
    setupMode: false,
    editing: null,             // {kind, id} en edición, null en creación
    itemTab: 'audit',
    offsets: [],               // avisos del elemento del modal
    settingsOffsets: [],       // avisos por defecto en edición (ajustes)
    defaultReminders: [1440, 60],
  },

  $(id) { return document.getElementById(id); },

  toast(msg, isError = false) {
    const el = this.$('toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
  },

  // ------------------------------------------------------------ arranque

  async boot() {
    await I18N.load(I18N.lang);
    this.bindEvents();
    const status = await API.get('/api/auth/status');
    if (status.logged_in) {
      await this.enterApp();
    } else {
      this.showAuth(!status.setup_done);
    }
  },

  showAuth(setupMode) {
    this.state.setupMode = setupMode;
    this.$('screen-app').classList.add('hidden');
    this.$('screen-auth').classList.remove('hidden');
    this.$('auth-subtitle').classList.toggle('hidden', !setupMode);
    this.$('auth-title').dataset.i18n = setupMode ? 'auth.setup_title' : 'auth.login_title';
    this.$('auth-submit').dataset.i18n = setupMode ? 'auth.create' : 'auth.enter';
    I18N.applyAll();
  },

  async enterApp() {
    this.$('screen-auth').classList.add('hidden');
    this.$('screen-app').classList.remove('hidden');
    const settings = await API.get('/api/settings');
    this.state.defaultReminders = settings.default_reminders;
    if (settings.lang !== I18N.lang) await I18N.load(settings.lang);
    await this.refresh();
  },

  // ------------------------------------------------------------ datos

  async refresh() {
    const { start, end } = Cal.monthRange(
      this.state.cursor.getFullYear(), this.state.cursor.getMonth());
    // Rango amplio para que la vista agenda y el panel lateral tengan datos
    const from = Cal.fmt(start);
    const toDate = new Date();
    toDate.setDate(toDate.getDate() + 60);
    const to = Cal.fmt(new Date(Math.max(end, toDate)));
    [this.state.data, this.state.notes, this.state.todos] = await Promise.all([
      API.get(`/api/calendar?date_from=${from}&date_to=${to}`),
      API.get('/api/notes'),
      API.get('/api/todos'),
    ]);
    this.render();
  },

  render() {
    const { cursor, data, view } = this.state;
    this.$('month-label').textContent = I18N.monthLabel(cursor);

    const handlers = {
      onDayClick: (d) => this.openDayModal(d),
      onAuditClick: (a) => this.openItemModal('audit', a),
      onEventClick: (ev) => this.openItemModal(ev.kind, ev),
      onVacationClick: (v) => this.openItemModal('vacation', v),
    };

    this.$('calendar-view').classList.toggle('hidden', view !== 'month');
    this.$('agenda-view').classList.toggle('hidden', view !== 'agenda');
    this.$('view-month').classList.toggle('active', view === 'month');
    this.$('view-agenda').classList.toggle('active', view === 'agenda');

    if (view === 'month') {
      Cal.renderMonth(this.$('calendar-view'),
        cursor.getFullYear(), cursor.getMonth(), data, handlers);
    } else {
      Cal.renderAgenda(this.$('agenda-view'), data, handlers);
    }
    this.renderSidebar();
    this.renderLegend();
  },

  // ------------------------------------------------------------ sidebar

  mapsUrl(location) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
  },

  sideItem(entry, data) {
    const el = document.createElement('div');
    el.className = 'side-item';
    let title = '', sub = '', color = '#8b949e', onclick = null, location = null;

    if (entry.type === 'event') {
      const ev = entry.ev;
      title = ev.title;
      location = ev.location;
      const time = ev.datetime.includes('T') ? ev.datetime.slice(11, 16) : '';
      sub = `${I18N.t('item.' + ev.kind)}${time ? ' · ' + time : ''}${ev.location ? ' · ' + ev.location : ''}`;
      color = ev.kind === 'meeting' ? '#bc8cff' : '#d29922';
      if (ev.done) el.classList.add('done');
      onclick = () => App.openItemModal(ev.kind, ev);
    } else if (entry.type === 'vacation') {
      const v = entry.v;
      title = `🏖 ${v.title}`;
      location = v.location;
      sub = `${I18N.t('item.vacation')} · ${v.start_date} → ${v.end_date}${v.location ? ' · ' + v.location : ''}`;
      color = 'var(--vacation)';
      onclick = () => App.openItemModal('vacation', v);
    } else {
      const a = entry.a;
      const type = data.types[a.type_id] || {};
      color = type.color || color;
      title = a.title;
      location = a.location;
      const phase = entry.type === 'report-start' || entry.phase === 'report'
        ? I18N.t('side.reporting') : I18N.t('side.audit_ongoing');
      const typeName = I18N.lang === 'es' ? type.name_es : type.name_en;
      sub = `${phase} · ${typeName || ''}${a.location ? ' · ' + a.location : ''}`;
      onclick = () => App.openItemModal('audit', a);
    }

    el.style.borderLeftColor = color;
    el.innerHTML = `<div class="si-body"><div class="si-title"></div><div class="si-sub"></div></div>`;
    el.querySelector('.si-title').textContent = title;
    el.querySelector('.si-sub').textContent = sub;

    // Toggle rápido de completado para tareas
    if (entry.type === 'event' && entry.ev.kind === 'task') {
      const ev = entry.ev;
      const tog = document.createElement('button');
      tog.className = 'task-toggle' + (ev.done ? ' checked' : '');
      tog.title = I18N.t('form.done');
      tog.innerHTML = `<svg class="icon"><use href="#i-check"/></svg>`;
      tog.addEventListener('click', async (e) => {
        e.stopPropagation();
        await API.put(`/api/events/${ev.id}`, {
          title: ev.title, kind: ev.kind, audit_id: ev.audit_id,
          datetime: ev.datetime, duration_min: ev.duration_min,
          location: ev.location, notes: ev.notes, done: !ev.done,
        });
        await App.refresh();
        if (App._dayModalDate && !App.$('modal-day').classList.contains('hidden')) {
          App.openDayModal(App._dayModalDate);
        }
      });
      el.prepend(tog);
    }

    if (location) {
      const link = document.createElement('a');
      link.className = 'si-map';
      link.innerHTML = `<svg class="icon"><use href="#i-pin"/></svg>`;
      link.href = App.mapsUrl(location);
      link.target = '_blank';
      link.title = I18N.t('form.open_maps');
      link.addEventListener('click', (e) => e.stopPropagation());
      el.querySelector('.si-sub').appendChild(link);
    }
    el.addEventListener('click', onclick);
    return el;
  },

  entriesForDay(dateStr) {
    const { data } = this.state;
    const entries = [];
    data.audits.forEach((a) => {
      Cal.phasesAt(a, dateStr).forEach((phase) =>
        entries.push({ type: 'audit', phase, a }));
    });
    (data.vacations || []).forEach((v) => {
      if (dateStr >= v.start_date && dateStr <= v.end_date) {
        entries.push({ type: 'vacation', v });
      }
    });
    data.events.forEach((ev) => {
      if (ev.datetime.slice(0, 10) === dateStr) entries.push({ type: 'event', ev });
    });
    return entries;
  },

  renderSidebar() {
    const todayStr = Cal.fmt(new Date());
    const todayList = this.$('today-list');
    todayList.innerHTML = '';
    const todayEntries = this.entriesForDay(todayStr);
    if (!todayEntries.length) {
      todayList.innerHTML = `<p class="empty-hint">${I18N.t('side.empty')}</p>`;
    } else {
      todayEntries.forEach((e) => todayList.appendChild(this.sideItem(e, this.state.data)));
    }

    // Próximos 14 días: inicios de auditoría/informe y eventos
    const upList = this.$('upcoming-list');
    upList.innerHTML = '';
    const upcoming = [];
    for (let i = 1; i <= 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const ds = Cal.fmt(d);
      this.state.data.audits.forEach((a) => {
        if (a.audit_start === ds) upcoming.push({ type: 'audit', a, sort: ds });
        if (a.report_start === ds) upcoming.push({ type: 'audit', phase: 'report', a, sort: ds });
      });
      (this.state.data.vacations || []).forEach((v) => {
        if (v.start_date === ds) upcoming.push({ type: 'vacation', v, sort: ds });
      });
      this.state.data.events.forEach((ev) => {
        if (ev.datetime.slice(0, 10) === ds && !ev.done) upcoming.push({ type: 'event', ev, sort: ev.datetime });
      });
    }
    if (!upcoming.length) {
      upList.innerHTML = `<p class="empty-hint">${I18N.t('side.empty')}</p>`;
    } else {
      upcoming.sort((a, b) => a.sort.localeCompare(b.sort)).slice(0, 8)
        .forEach((e) => upList.appendChild(this.sideItem(e, this.state.data)));
    }

    // Lista de tareas
    this.renderTodos('side-todos', 6);

    // Últimas notas rápidas
    const notesBox = this.$('side-notes');
    notesBox.innerHTML = '';
    if (!this.state.notes.length) {
      notesBox.innerHTML = `<p class="empty-hint">${I18N.t('side.empty')}</p>`;
    } else {
      this.state.notes.slice(0, 3).forEach((n) => {
        const el = document.createElement('div');
        el.className = 'side-item';
        el.style.borderLeftColor = '#d2a8ff';
        el.innerHTML = `<div class="si-title"></div>`;
        el.querySelector('.si-title').textContent =
          n.content.length > 60 ? n.content.slice(0, 60) + '…' : n.content;
        el.addEventListener('click', () => this.openNotesModal());
        notesBox.appendChild(el);
      });
    }
  },

  renderLegend() {
    const legend = this.$('legend');
    legend.innerHTML = '';
    Object.values(this.state.data.types).forEach((t) => {
      const row = document.createElement('div');
      row.className = 'legend-item';
      row.innerHTML = `<span class="legend-swatch"></span><span></span>`;
      row.querySelector('.legend-swatch').style.background = t.color;
      row.querySelector('span:last-child').textContent =
        I18N.lang === 'es' ? t.name_es : t.name_en;
      legend.appendChild(row);
    });
    const vac = document.createElement('div');
    vac.className = 'legend-item';
    vac.innerHTML = `<span class="legend-swatch" style="background: var(--vacation)"></span><span></span>`;
    vac.querySelector('span:last-child').textContent = I18N.t('item.vacation');
    legend.appendChild(vac);
  },

  // ------------------------------------------------------------ modales

  openModal(id) {
    this.$('modal-backdrop').classList.remove('hidden');
    document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
    this.$(id).classList.remove('hidden');
  },

  closeModals() {
    this.$('modal-backdrop').classList.add('hidden');
  },

  openDayModal(dateStr) {
    const entries = this.entriesForDay(dateStr);
    this.$('day-label').textContent = I18N.dayLabel(Cal.parse(dateStr));
    const box = this.$('day-items');
    box.innerHTML = '';
    if (!entries.length) {
      box.innerHTML = `<p class="empty-hint">${I18N.t('side.empty')}</p>`;
    } else {
      entries.forEach((e) => box.appendChild(this.sideItem(e, this.state.data)));
    }
    this.openModal('modal-day');
    this._dayModalDate = dateStr;
  },

  setItemTab(tab) {
    this.state.itemTab = tab;
    document.querySelectorAll('#item-tabs .tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.tab === tab));
    const isAudit = tab === 'audit';
    const isVacation = tab === 'vacation';
    const isEvent = tab === 'meeting' || tab === 'task';
    document.querySelectorAll('#item-form .only-audit').forEach((el) =>
      el.classList.toggle('hidden', !isAudit));
    document.querySelectorAll('#item-form .only-event').forEach((el) =>
      el.classList.toggle('hidden', !isEvent));
    document.querySelectorAll('#item-form .only-meeting').forEach((el) =>
      el.classList.toggle('hidden', tab !== 'meeting'));
    document.querySelectorAll('#item-form .only-task').forEach((el) =>
      el.classList.toggle('hidden', tab !== 'task' || !this.state.editing));
    document.querySelectorAll('#item-form .only-vacation').forEach((el) =>
      el.classList.toggle('hidden', !isVacation));
    this.$('item-audit-start').required = isAudit;
    this.$('item-audit-end').required = isAudit;
    this.$('item-datetime').required = isEvent;
    this.$('item-vac-start').required = isVacation;
    this.$('item-vac-end').required = isVacation;

    // El campo título es "Título / cliente" salvo en vacaciones, donde es solo "Título"
    const titleSpan = this.$('item-title').closest('label').querySelector('span');
    titleSpan.textContent = I18N.t(isVacation ? 'form.title_only' : 'form.title');
    this.$('item-title').placeholder = isVacation ? '' : I18N.t('form.title_ph');
  },

  async openItemModal(kind, existing = null, presetDate = null) {
    this.state.editing = existing ? { kind, id: existing.id } : null;
    this.$('item-form').reset();
    this.$('item-delete').classList.toggle('hidden', !existing);
    // En edición no se cambia de pestaña
    document.querySelectorAll('#item-tabs .tab').forEach((t) =>
      t.style.display = existing ? (t.dataset.tab === kind ? '' : 'none') : '');
    this.setItemTab(kind);
    this.fillTypeSelect();
    this.fillAuditLinkSelect();
    this.renderTeammateChips(existing && kind === 'audit' ? existing.teammate_ids : []);

    if (existing) {
      this.$('item-id').value = existing.id;
      this.$('item-title').value = existing.title;
      this.$('item-location').value = existing.location || '';
      this.$('item-notes').value = existing.notes || '';
      if (kind === 'audit') {
        this.$('item-type').value = existing.type_id;
        this.$('item-audit-start').value = existing.audit_start;
        this.$('item-audit-end').value = existing.audit_end;
        this.$('item-report-start').value = existing.report_start || '';
        this.$('item-report-end').value = existing.report_end || '';
        this.$('item-status').value = existing.status;
      } else if (kind === 'vacation') {
        this.$('item-vac-start').value = existing.start_date;
        this.$('item-vac-end').value = existing.end_date;
      } else {
        this.$('item-datetime').value = existing.datetime;
        this.$('item-duration').value = existing.duration_min || '';
        this.$('item-audit-link').value = existing.audit_id || '';
        this.$('item-done').checked = Boolean(existing.done);
      }
      const targetKind = kind === 'audit' ? 'audit_start'
        : kind === 'vacation' ? 'vacation_start' : 'event';
      const rems = await API.get(
        `/api/reminders?target_kind=${targetKind}&target_id=${existing.id}`);
      this.state.offsets = rems.filter((r) => !r.fired_at).map((r) => r.offset_min);
    } else {
      this.state.offsets = [...this.state.defaultReminders];
      const base = presetDate || Cal.fmt(new Date());
      this.$('item-audit-start').value = base;
      this.$('item-audit-end').value = base;
      this.$('item-vac-start').value = base;
      this.$('item-vac-end').value = base;
      this.$('item-datetime').value = `${base}T10:00`;
      this.$('item-done').checked = false;
    }
    this.renderReminderChips();
    this.openModal('modal-item');
    setTimeout(() => this.$('item-title').focus(), 50);
  },

  fillTypeSelect() {
    const sel = this.$('item-type');
    sel.innerHTML = '';
    Object.values(this.state.data.types).forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = I18N.lang === 'es' ? t.name_es : t.name_en;
      sel.appendChild(opt);
    });
  },

  fillAuditLinkSelect() {
    const sel = this.$('item-audit-link');
    sel.innerHTML = `<option value="">${I18N.t('form.none')}</option>`;
    this.state.data.audits.forEach((a) => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.title;
      sel.appendChild(opt);
    });
  },

  renderTeammateChips(selectedIds = []) {
    const box = this.$('item-teammates');
    box.innerHTML = '';
    const mates = Object.values(this.state.data.teammates);
    if (!mates.length) {
      box.innerHTML = `<p class="empty-hint">${I18N.t('hint.no_teammates')}</p>`;
      return;
    }
    mates.forEach((tm) => {
      const chip = document.createElement('span');
      chip.className = 'chip' + (selectedIds.includes(tm.id) ? ' selected' : '');
      chip.dataset.id = tm.id;
      chip.textContent = tm.name;
      chip.style.color = tm.color;
      chip.addEventListener('click', () => chip.classList.toggle('selected'));
      box.appendChild(chip);
    });
  },

  renderOffsetChips(boxId, offsets) {
    const box = this.$(boxId);
    box.innerHTML = '';
    offsets.sort((a, b) => a - b).forEach((min, idx) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `<span></span><b>✕</b>`;
      chip.querySelector('span').textContent =
        `${I18N.offsetLabel(min)} ${I18N.t('rem.before')}`;
      chip.querySelector('b').addEventListener('click', () => {
        offsets.splice(idx, 1);
        this.renderOffsetChips(boxId, offsets);
      });
      box.appendChild(chip);
    });
  },

  renderReminderChips() {
    this.renderOffsetChips('reminder-chips', this.state.offsets);
  },

  /* Conecta un grupo preset+custom+botón con una lista de offsets. */
  bindOffsetControls(presetId, customId, addBtnId, getOffsets, boxId) {
    this.$(presetId).addEventListener('change', () => {
      this.$(customId).classList.toggle('hidden', this.$(presetId).value !== 'custom');
    });
    this.$(addBtnId).addEventListener('click', () => {
      const preset = this.$(presetId).value;
      const min = preset === 'custom'
        ? Number(this.$(customId).value) : Number(preset);
      const offsets = getOffsets();
      if (min > 0 && !offsets.includes(min)) {
        offsets.push(min);
        this.renderOffsetChips(boxId, offsets);
      }
    });
  },

  async saveItem() {
    const tab = this.state.itemTab;
    const editing = this.state.editing;
    const title = this.$('item-title').value.trim();
    const location = this.$('item-location').value.trim() || null;
    const notes = this.$('item-notes').value.trim() || null;

    try {
      if (tab === 'audit') {
        // Si solo se rellena una fecha del informe, completar la otra
        let reportStart = this.$('item-report-start').value || null;
        let reportEnd = this.$('item-report-end').value || null;
        if (reportStart && !reportEnd) reportEnd = reportStart;
        if (reportEnd && !reportStart) reportStart = reportEnd;
        const body = {
          title,
          type_id: Number(this.$('item-type').value),
          location,
          audit_start: this.$('item-audit-start').value,
          audit_end: this.$('item-audit-end').value,
          report_start: reportStart,
          report_end: reportEnd,
          status: this.$('item-status').value,
          notes,
          teammate_ids: [...this.$('item-teammates').querySelectorAll('.chip.selected')]
            .map((c) => Number(c.dataset.id)),
          reminder_offsets: this.state.offsets,
        };
        if (editing) await API.put(`/api/audits/${editing.id}`, body);
        else await API.post('/api/audits', body);
      } else if (tab === 'vacation') {
        const body = {
          title,
          start_date: this.$('item-vac-start').value,
          end_date: this.$('item-vac-end').value,
          location,
          notes,
          reminder_offsets: this.state.offsets,
        };
        if (editing) await API.put(`/api/vacations/${editing.id}`, body);
        else await API.post('/api/vacations', body);
      } else {
        const body = {
          title,
          kind: tab,
          audit_id: this.$('item-audit-link').value
            ? Number(this.$('item-audit-link').value) : null,
          datetime: this.$('item-datetime').value,
          duration_min: this.$('item-duration').value
            ? Number(this.$('item-duration').value) : null,
          location,
          notes,
          done: false,
          reminder_offsets: this.state.offsets,
        };
        if (editing) {
          body.done = tab === 'task'
            ? this.$('item-done').checked
            : false;
          await API.put(`/api/events/${editing.id}`, body);
        } else {
          await API.post('/api/events', body);
        }
      }
      this.closeModals();
      this.toast(I18N.t('toast.saved'));
      await this.refresh();
    } catch (err) {
      this.toast(`${I18N.t('toast.error')}: ${err.message}`, true);
    }
  },

  async deleteItem() {
    if (!this.state.editing || !confirm(I18N.t('form.confirm_delete'))) return;
    const { kind, id } = this.state.editing;
    const path = kind === 'audit' ? `/api/audits/${id}`
      : kind === 'vacation' ? `/api/vacations/${id}` : `/api/events/${id}`;
    await API.del(path);
    this.closeModals();
    this.toast(I18N.t('toast.deleted'));
    await this.refresh();
  },

  // ------------------------------------------------------------ lista de tareas

  todoItem(t) {
    const el = document.createElement('div');
    el.className = 'todo-item' + (t.done ? ' done' : '');
    el.innerHTML = `
      <button class="task-toggle${t.done ? ' checked' : ''}"><svg class="icon"><use href="#i-check"/></svg></button>
      <span class="todo-text"></span>
      <button class="del"><svg class="icon"><use href="#i-trash"/></svg></button>`;
    el.querySelector('.todo-text').textContent = t.content;
    el.querySelector('.task-toggle').addEventListener('click', async () => {
      await API.put(`/api/todos/${t.id}`, { content: t.content, done: !t.done });
      await this.reloadTodos();
    });
    el.querySelector('.del').addEventListener('click', async () => {
      await API.del(`/api/todos/${t.id}`);
      await this.reloadTodos();
    });
    // Editar en línea con doble clic
    el.querySelector('.todo-text').addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = t.content;
      input.className = 'todo-edit';
      const save = async () => {
        const v = input.value.trim();
        if (v && v !== t.content) {
          await API.put(`/api/todos/${t.id}`, { content: v, done: t.done });
          await this.reloadTodos();
        } else {
          this.reloadTodos();
        }
      };
      input.addEventListener('blur', save);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') this.reloadTodos();
      });
      el.querySelector('.todo-text').replaceWith(input);
      input.focus();
    });
    return el;
  },

  renderTodos(boxId, limit = null) {
    const box = this.$(boxId);
    if (!box) return;
    box.innerHTML = '';
    let items = this.state.todos;
    if (limit) items = items.filter((t) => !t.done).slice(0, limit);
    if (!items.length) {
      box.innerHTML = `<p class="empty-hint">${I18N.t('todos.empty')}</p>`;
      return;
    }
    items.forEach((t) => box.appendChild(this.todoItem(t)));
  },

  async reloadTodos() {
    this.state.todos = await API.get('/api/todos');
    this.renderTodos('side-todos', 6);
    if (!this.$('modal-todos').classList.contains('hidden')) {
      this.renderTodos('todos-list');
    }
  },

  async addTodo(inputId) {
    const content = this.$(inputId).value.trim();
    if (!content) return;
    await API.post('/api/todos', { content });
    this.$(inputId).value = '';
    await this.reloadTodos();
  },

  openTodosModal() {
    this.renderTodos('todos-list');
    this.openModal('modal-todos');
    setTimeout(() => this.$('todo-input').focus(), 50);
  },

  // ------------------------------------------------------------ notas rápidas

  resetNoteForm() {
    this.$('note-id').value = '';
    this.$('note-input').value = '';
    this.$('note-submit').dataset.i18n = 'form.add';
    this.$('note-cancel').classList.add('hidden');
    I18N.applyAll();
  },

  async openNotesModal() {
    this.resetNoteForm();
    this.state.notes = await API.get('/api/notes');
    this.renderNotesList();
    this.openModal('modal-notes');
    this.$('note-input').focus();
  },

  renderNotesList() {
    const list = this.$('notes-list');
    list.innerHTML = '';
    if (!this.state.notes.length) {
      list.innerHTML = `<p class="empty-hint">${I18N.t('side.empty')}</p>`;
      return;
    }
    this.state.notes.forEach((n) => {
      const row = document.createElement('div');
      row.className = 'note-row';
      row.innerHTML = `<div class="note-content"></div>
        <div class="note-meta"><span></span>
        <button class="del"><svg class="icon"><use href="#i-trash"/></svg></button></div>`;
      row.querySelector('.note-content').textContent = n.content;
      row.querySelector('.note-meta span').textContent =
        (n.updated_at || n.created_at || '').slice(0, 16).replace('T', ' ');
      row.addEventListener('click', () => {
        this.$('note-id').value = n.id;
        this.$('note-input').value = n.content;
        this.$('note-submit').dataset.i18n = 'form.save';
        this.$('note-cancel').classList.remove('hidden');
        I18N.applyAll();
        this.$('note-input').focus();
      });
      row.querySelector('.del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(I18N.t('form.confirm_delete'))) return;
        await API.del(`/api/notes/${n.id}`);
        this.state.notes = await API.get('/api/notes');
        this.renderNotesList();
        this.renderSidebar();
      });
      list.appendChild(row);
    });
  },

  async saveNote() {
    const content = this.$('note-input').value.trim();
    if (!content) return;
    const id = this.$('note-id').value;
    if (id) await API.put(`/api/notes/${id}`, { content });
    else await API.post('/api/notes', { content });
    this.resetNoteForm();
    this.state.notes = await API.get('/api/notes');
    this.renderNotesList();
    this.renderSidebar();
  },

  // ------------------------------------------------------------ ajustes

  async openSettings() {
    const settings = await API.get('/api/settings');
    this.$('set-lang').value = settings.lang;
    this.state.settingsOffsets = [...settings.default_reminders];
    this.renderOffsetChips('set-reminder-chips', this.state.settingsOffsets);
    await this.renderTeammatesPane();
    await this.renderTypesPane();
    this.openModal('modal-settings');
  },

  async renderTeammatesPane() {
    const mates = await API.get('/api/teammates');
    const list = this.$('teammates-list');
    list.innerHTML = '';
    mates.forEach((tm) => {
      const row = document.createElement('div');
      row.className = 'manage-row';
      row.innerHTML = `<span class="swatch"></span><span></span>
        <button class="del"><svg class="icon"><use href="#i-trash"/></svg></button>`;
      row.querySelector('.swatch').style.background = tm.color;
      row.querySelector('span:nth-child(2)').textContent = tm.name;
      row.querySelector('.del').addEventListener('click', async () => {
        if (!confirm(I18N.t('form.confirm_delete'))) return;
        await API.del(`/api/teammates/${tm.id}`);
        await this.renderTeammatesPane();
        await this.refresh();
      });
      list.appendChild(row);
    });
  },

  async renderTypesPane() {
    const types = await API.get('/api/audit-types');
    const list = this.$('types-list');
    list.innerHTML = '';
    types.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'manage-row';
      row.innerHTML = `<span class="swatch"></span><span></span>
        <button class="del"><svg class="icon"><use href="#i-trash"/></svg></button>`;
      row.querySelector('.swatch').style.background = t.color;
      row.querySelector('span:nth-child(2)').textContent =
        `${t.name_es} / ${t.name_en}`;
      const del = row.querySelector('.del');
      if (t.builtin) del.style.visibility = 'hidden';
      del.addEventListener('click', async () => {
        if (!confirm(I18N.t('form.confirm_delete'))) return;
        try {
          await API.del(`/api/audit-types/${t.id}`);
          await this.renderTypesPane();
          await this.refresh();
        } catch (err) {
          const key = err.message === 'type_in_use'
            ? 'settings.type_in_use' : 'settings.builtin_type';
          this.toast(I18N.t(key), true);
        }
      });
      list.appendChild(row);
    });
  },

  // ------------------------------------------------------------ eventos UI

  bindEvents() {
    // Auth
    this.$('auth-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = this.$('auth-error');
      errEl.classList.add('hidden');
      try {
        const creds = {
          username: this.$('auth-username').value,
          password: this.$('auth-password').value,
        };
        await API.post(this.state.setupMode ? '/api/auth/setup' : '/api/auth/login', creds);
        await this.enterApp();
      } catch (err) {
        const key = err.message === 'password_too_short'
          ? 'auth.password_too_short' : 'auth.bad_credentials';
        errEl.textContent = I18N.t(key);
        errEl.classList.remove('hidden');
      }
    });

    window.addEventListener('session-expired', () => this.showAuth(false));
    window.addEventListener('lang-changed', () => {
      if (!this.$('screen-app').classList.contains('hidden')) {
        API.put('/api/settings', { lang: I18N.lang }).catch(() => {});
        this.render();
      }
    });

    // Navegación
    this.$('nav-prev').addEventListener('click', () => {
      this.state.cursor.setMonth(this.state.cursor.getMonth() - 1);
      this.refresh();
    });
    this.$('nav-next').addEventListener('click', () => {
      this.state.cursor.setMonth(this.state.cursor.getMonth() + 1);
      this.refresh();
    });
    this.$('nav-today').addEventListener('click', () => {
      this.state.cursor = new Date();
      this.refresh();
    });
    this.$('view-month').addEventListener('click', () => {
      this.state.view = 'month';
      this.render();
    });
    this.$('view-agenda').addEventListener('click', () => {
      this.state.view = 'agenda';
      this.render();
    });
    this.$('btn-logout').addEventListener('click', async () => {
      await API.post('/api/auth/logout', {});
      this.showAuth(false);
    });
    this.$('btn-settings').addEventListener('click', () => this.openSettings());
    this.$('btn-notes').addEventListener('click', () => this.openNotesModal());
    this.$('btn-todos').addEventListener('click', () => this.openTodosModal());

    // Lista de tareas
    this.$('side-todo-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.addTodo('side-todo-input');
    });
    this.$('todo-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.addTodo('todo-input');
    });
    this.$('todos-clear').addEventListener('click', async () => {
      await API.post('/api/todos/clear-done', {});
      await this.reloadTodos();
    });

    // Tema claro/oscuro
    this.$('btn-theme').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('agenda_theme', next);
    });

    // Notas rápidas
    this.$('note-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveNote();
    });
    this.$('note-cancel').addEventListener('click', () => this.resetNoteForm());

    // Abrir ubicación en Maps
    this.$('item-location-maps').addEventListener('click', () => {
      const loc = this.$('item-location').value.trim();
      if (loc) window.open(this.mapsUrl(loc), '_blank');
    });

    // FAB y modales
    this.$('fab').addEventListener('click', () => this.openItemModal('audit'));
    this.$('modal-backdrop').addEventListener('click', (e) => {
      if (e.target === this.$('modal-backdrop')) this.closeModals();
    });
    document.querySelectorAll('.modal-close').forEach((b) =>
      b.addEventListener('click', () => this.closeModals()));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeModals();
    });

    // Formulario de elemento
    document.querySelectorAll('#item-tabs .tab').forEach((t) =>
      t.addEventListener('click', () => this.setItemTab(t.dataset.tab)));
    this.$('item-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveItem();
    });
    this.$('item-delete').addEventListener('click', () => this.deleteItem());

    // Avisos (modal de elemento y ajustes)
    this.bindOffsetControls('reminder-preset', 'reminder-custom',
      'reminder-add-btn', () => this.state.offsets, 'reminder-chips');
    this.bindOffsetControls('set-reminder-preset', 'set-reminder-custom',
      'set-reminder-add-btn', () => this.state.settingsOffsets, 'set-reminder-chips');

    // Validación de rangos de fechas: el fin nunca antes del inicio
    [['item-audit-start', 'item-audit-end'],
     ['item-report-start', 'item-report-end'],
     ['item-vac-start', 'item-vac-end']].forEach(([startId, endId]) => {
      this.$(startId).addEventListener('change', () => {
        const start = this.$(startId).value;
        if (!start) return;
        this.$(endId).min = start;
        if (!this.$(endId).value || this.$(endId).value < start) {
          this.$(endId).value = start;
        }
      });
    });
    // El informe no puede empezar antes de acabar la auditoría
    this.$('item-audit-end').addEventListener('change', () => {
      const end = this.$('item-audit-end').value;
      if (end) {
        this.$('item-report-start').min = end;
        this.$('item-report-end').min = end;
      }
    });

    // Añadir desde el modal de día
    this.$('day-add').addEventListener('click', () => {
      const date = this._dayModalDate;
      this.closeModals();
      this.openItemModal('audit', null, date);
    });

    // Ajustes: pestañas
    document.querySelectorAll('#settings-tabs .tab').forEach((t) =>
      t.addEventListener('click', () => {
        document.querySelectorAll('#settings-tabs .tab').forEach((x) =>
          x.classList.toggle('active', x === t));
        document.querySelectorAll('.settings-pane').forEach((p) =>
          p.classList.toggle('hidden', p.dataset.pane !== t.dataset.tab));
      }));

    this.$('set-save-general').addEventListener('click', async () => {
      const reminders = [...this.state.settingsOffsets];
      const lang = this.$('set-lang').value;
      await API.put('/api/settings', { lang, default_reminders: reminders });
      this.state.defaultReminders = reminders;
      if (lang !== I18N.lang) await I18N.load(lang);
      this.toast(I18N.t('toast.saved'));
    });

    this.$('teammate-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await API.post('/api/teammates', {
        name: this.$('teammate-name').value,
        color: this.$('teammate-color').value,
      });
      this.$('teammate-name').value = '';
      await this.renderTeammatesPane();
      await this.refresh();
    });

    this.$('type-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await API.post('/api/audit-types', {
        name_es: this.$('type-name-es').value,
        name_en: this.$('type-name-en').value,
        color: this.$('type-color').value,
      });
      this.$('type-name-es').value = '';
      this.$('type-name-en').value = '';
      await this.renderTypesPane();
      await this.refresh();
    });

    this.$('password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = this.$('pw-msg');
      msg.classList.add('hidden');
      if (this.$('pw-new').value !== this.$('pw-new2').value) {
        msg.textContent = I18N.t('settings.password_mismatch');
        msg.classList.remove('hidden');
        return;
      }
      try {
        await API.post('/api/auth/password', {
          current_password: this.$('pw-current').value,
          new_password: this.$('pw-new').value,
        });
        this.closeModals();
        this.toast(I18N.t('settings.password_changed'));
        this.showAuth(false);
      } catch (err) {
        const key = err.message === 'password_too_short'
          ? 'auth.password_too_short' : 'auth.bad_credentials';
        msg.textContent = I18N.t(key);
        msg.classList.remove('hidden');
      }
    });
  },
};

App.boot();
