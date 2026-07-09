/* Estado y lógica de la SPA. */
const App = {
  state: {
    cursor: new Date(),        // mes visible
    weekCursor: new Date(),    // semana visible en la vista de horas
    view: 'month',
    data: { audits: [], events: [], vacations: [], types: {}, teammates: {} },
    timeData: null,            // rejilla de horas de la semana visible
    extraRows: {},             // filas añadidas a mano por semana: { weekStart: [task keys] }
    notes: [],
    todos: [],
    taskGroups: [],            // grupos de la lista de tareas (Hoy + propios)
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
    this.initReminders();
  },

  // ------------------------------------------------------------ avisos (navegador)

  requestNotifyPermission() {
    if (!('Notification' in window) || Notification.permission !== 'default') return;
    Notification.requestPermission().catch(() => {});
    // Algunos navegadores exigen un gesto: reintentar en el primer clic
    const once = () => {
      if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      document.removeEventListener('click', once);
    };
    document.addEventListener('click', once, { once: true });
  },

  initReminders() {
    this.requestNotifyPermission();
    this.startReminderPolling();
  },

  startReminderPolling() {
    this.stopReminderPolling();
    this.pollDueReminders();
    this._reminderTimer = setInterval(() => this.pollDueReminders(), 30000);
  },

  stopReminderPolling() {
    if (this._reminderTimer) {
      clearInterval(this._reminderTimer);
      this._reminderTimer = null;
    }
  },

  async pollDueReminders() {
    try {
      const due = await API.get('/api/reminders/due');
      if (!due.length) return;
      const granted = ('Notification' in window) && Notification.permission === 'granted';
      due.forEach((r) => {
        if (granted) {
          try { new Notification(r.title, { body: r.body }); } catch (_) { /* noop */ }
        } else {
          this.toast(`${r.title} — ${r.body}`);
        }
      });
      await API.post('/api/reminders/ack', { ids: due.map((r) => r.id) });
    } catch (_) {
      /* silencioso: 401 (sesión caduca) o red; el poller reintenta */
    }
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
    [this.state.data, this.state.notes, this.state.todos, this.state.taskGroups] =
      await Promise.all([
        API.get(`/api/calendar?date_from=${from}&date_to=${to}`),
        API.get('/api/notes'),
        API.get('/api/todos'),
        API.get('/api/task-groups'),
      ]);
    this.render();
  },

  render() {
    const { cursor, data, view } = this.state;
    this.$('month-label').textContent =
      view === 'hours' ? this.weekLabel()
        : view === 'tasks' ? I18N.t('nav.tasks')
          : I18N.monthLabel(cursor);

    const handlers = {
      onDayClick: (d) => this.openDayModal(d),
      onAuditClick: (a) => this.openItemModal('audit', a),
      onEventClick: (ev) => this.openItemModal(ev.kind, ev),
      onVacationClick: (v) => this.openItemModal('vacation', v),
      onTaskToggle: (t) => this.toggleTodo(t),
    };

    this.$('calendar-view').classList.toggle('hidden', view !== 'month');
    this.$('agenda-view').classList.toggle('hidden', view !== 'agenda');
    this.$('tasks-view').classList.toggle('hidden', view !== 'tasks');
    this.$('hours-view').classList.toggle('hidden', view !== 'hours');
    this.$('view-month').classList.toggle('active', view === 'month');
    this.$('view-agenda').classList.toggle('active', view === 'agenda');
    this.$('view-tasks').classList.toggle('active', view === 'tasks');
    this.$('view-hours').classList.toggle('active', view === 'hours');

    if (view === 'month') {
      const augmented = { ...data, todayTasks: this.hoyTasks(false) };
      Cal.renderMonth(this.$('calendar-view'),
        cursor.getFullYear(), cursor.getMonth(), augmented, handlers);
    } else if (view === 'agenda') {
      Cal.renderAgenda(this.$('agenda-view'), data, handlers);
    } else if (view === 'tasks') {
      this.renderTasks();
    } else {
      this.renderHours();
    }
    this.renderSidebar();
    this.renderLegend();
  },

  // ------------------------------------------------------------ tareas (grupos)

  hoyGroupId() {
    const g = this.state.taskGroups.find((x) => x.slug === 'today');
    return g ? g.id : null;
  },

  hoyTasks(includeDone) {
    const hoy = this.hoyGroupId();
    return this.state.todos.filter((t) =>
      t.group_id === hoy && (includeDone || !t.done));
  },

  groupLabel(g) {
    return g.slug ? I18N.t('taskgroup.' + g.slug) : g.name;
  },

  async toggleTodo(t) {
    await API.put(`/api/todos/${t.id}`, { content: t.content, done: !t.done });
    await this.reloadTodos();
    if (this.state.view === 'month') this.render();
  },

  async moveTodo(t, groupId) {
    await API.put(`/api/todos/${t.id}`,
      { content: t.content, done: t.done, group_id: groupId });
    await this.reloadTodos();
  },

  renderTasks() {
    const box = this.$('tasks-view');
    box.innerHTML = '';

    const toolbar = document.createElement('div');
    toolbar.className = 'tasks-toolbar';
    const form = document.createElement('form');
    form.className = 'inline-form';
    form.innerHTML =
      `<input id="taskgroup-name" type="text" maxlength="40" placeholder="${I18N.t('tasks.new_group')}" required>` +
      `<button class="btn btn-primary" type="submit">${I18N.t('form.add')}</button>`;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = form.querySelector('#taskgroup-name').value.trim();
      if (!name) return;
      await API.post('/api/task-groups', { name });
      this.state.taskGroups = await API.get('/api/task-groups');
      this.renderTasks();
    });
    toolbar.appendChild(form);
    box.appendChild(toolbar);

    const grid = document.createElement('div');
    grid.className = 'tasks-grid';
    this.state.taskGroups.forEach((g) => grid.appendChild(this.taskGroupCard(g)));
    box.appendChild(grid);
  },

  taskGroupCard(group) {
    const card = document.createElement('div');
    card.className = 'task-group';
    const tasks = this.state.todos.filter((t) => t.group_id === group.id);
    const pending = tasks.filter((t) => !t.done).length;

    const head = document.createElement('div');
    head.className = 'task-group-head';
    head.innerHTML = `<h3></h3><span class="tg-count">${pending}</span>`;
    head.querySelector('h3').textContent = this.groupLabel(group);
    if (!group.builtin) {
      const del = document.createElement('button');
      del.className = 'btn btn-icon tg-del';
      del.innerHTML = `<svg class="icon"><use href="#i-trash"/></svg>`;
      del.title = I18N.t('form.delete');
      del.addEventListener('click', async () => {
        if (!confirm(I18N.t('tasks.group_delete_confirm'))) return;
        await API.del(`/api/task-groups/${group.id}`);
        this.state.taskGroups = await API.get('/api/task-groups');
        await this.reloadTodos();
        this.renderTasks();
      });
      head.appendChild(del);
    }
    card.appendChild(head);

    const list = document.createElement('div');
    list.className = 'todo-list';
    if (!tasks.length) {
      list.innerHTML = `<p class="empty-hint">${I18N.t('todos.empty')}</p>`;
    } else {
      tasks.forEach((t) => list.appendChild(this.taskRow(t)));
    }
    card.appendChild(list);

    const add = document.createElement('form');
    add.className = 'todo-quickadd';
    add.innerHTML =
      `<input type="text" maxlength="200" placeholder="${I18N.t('todos.placeholder')}">` +
      `<button class="btn btn-icon" type="submit" aria-label="+"><svg class="icon"><use href="#i-plus"/></svg></button>`;
    add.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = add.querySelector('input');
      const content = input.value.trim();
      if (!content) return;
      await API.post('/api/todos', { content, group_id: group.id });
      input.value = '';
      await this.reloadTodos();
    });
    card.appendChild(add);
    return card;
  },

  taskRow(t) {
    const el = this.todoItem(t);
    // Insignia de recurrencia
    if (t.recurrence) {
      const badge = document.createElement('span');
      badge.className = 'rec-badge';
      badge.innerHTML = `<svg class="icon"><use href="#i-repeat"/></svg><span></span>`;
      badge.querySelector('span').textContent = this.recurShort(t);
      el.querySelector('.todo-text').appendChild(badge);
    }
    // Botón para configurar la recurrencia
    const rec = document.createElement('button');
    rec.className = 'btn btn-icon task-rec' + (t.recurrence ? ' on' : '');
    rec.innerHTML = `<svg class="icon"><use href="#i-repeat"/></svg>`;
    rec.title = I18N.t('recur.task_title');
    rec.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openTodoRecurrence(t);
    });
    // Selector para mover la tarea a otro grupo
    const sel = document.createElement('select');
    sel.className = 'task-move';
    this.state.taskGroups.forEach((g) => {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = this.groupLabel(g);
      if (g.id === t.group_id) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', () => this.moveTodo(t, Number(sel.value)));
    sel.addEventListener('click', (e) => e.stopPropagation());
    const delBtn = el.querySelector('.del');
    el.insertBefore(sel, delBtn);
    el.insertBefore(rec, delBtn);
    return el;
  },

  recurShort(t) {
    const n = t.rec_interval > 1 ? `×${t.rec_interval}` : '';
    return `${I18N.t('recur.' + t.recurrence)}${n}`;
  },

  openTodoRecurrence(t) {
    this.$('tr-id').value = t.id;
    this.$('tr-freq').value = t.recurrence || '';
    this.$('tr-interval').value = t.rec_interval || 1;
    this.$('tr-due').value = t.due || Cal.fmt(new Date());
    const on = Boolean(t.recurrence);
    document.querySelectorAll('#todo-recur-form .tr-when').forEach((el) =>
      el.classList.toggle('hidden', !on));
    this.openModal('modal-todo-recur');
  },

  async saveTodoRecurrence() {
    const id = this.$('tr-id').value;
    const freq = this.$('tr-freq').value;
    const body = freq
      ? { recurrence: freq,
          rec_interval: Number(this.$('tr-interval').value) || 1,
          due: this.$('tr-due').value || Cal.fmt(new Date()) }
      : { recurrence: null };
    await API.put(`/api/todos/${id}/recurrence`, body);
    this.closeModals();
    await this.reloadTodos();
    this.toast(I18N.t('toast.saved'));
  },

  // ------------------------------------------------------------ horas

  weekLabel() {
    const td = this.state.timeData;
    if (!td) return '';
    const loc = I18N.lang === 'es' ? 'es-ES' : 'en-GB';
    const a = Cal.parse(td.days[0]).toLocaleDateString(loc, { day: 'numeric', month: 'short' });
    const b = Cal.parse(td.days[6]).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' });
    return `${a} – ${b}`;
  },

  fmtHours(h) {
    return Number.isInteger(h) ? String(h) : String(Number(h.toFixed(2)));
  },

  navigate(dir) {
    if (this.state.view === 'tasks') return;  // la vista de tareas no navega por fecha
    if (this.state.view === 'hours') {
      this.state.weekCursor.setDate(this.state.weekCursor.getDate() + dir * 7);
      this.loadHours();
    } else {
      this.state.cursor.setMonth(this.state.cursor.getMonth() + dir);
      this.refresh();
    }
  },

  async loadHours() {
    const start = Cal.fmt(Cal.weekStart(this.state.weekCursor));
    this.state.timeData = await API.get(`/api/time/week?start=${start}`);
    this.state.view = 'hours';
    this.render();
  },

  /* Filas visibles de la rejilla: categorías + auditorías que solapan la semana
     o tienen horas imputadas + filas añadidas a mano. */
  eventColor(kind) {
    return kind === 'meeting' ? '#a78bfa' : '#e3b341';
  },

  eventRowName(ev) {
    const time = ev.datetime.includes('T') ? ' ' + ev.datetime.slice(11, 16) : '';
    return `${ev.kind === 'meeting' ? '👥' : '✔'} ${ev.title}${time}`;
  },

  hoursRows() {
    const td = this.state.timeData;
    const first = td.days[0], last = td.days[6];
    const catById = {}, auditById = {}, eventById = {};
    td.categories.forEach((c) => { catById[c.id] = c; });
    td.audits.forEach((a) => { auditById[a.id] = a; });
    (td.events || []).forEach((e) => { eventById[e.id] = e; });

    const rows = [];
    const seen = new Set();
    const push = (key, name, color) => {
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ key, name, color });
    };
    const pushKey = (key) => {
      const [kind, id] = key.split(':');
      if (kind === 'audit' && auditById[id]) push(key, auditById[id].title, auditById[id].color);
      else if (kind === 'cat' && catById[id]) push(key, catById[id].name, catById[id].color);
      else if (kind === 'event' && eventById[id]) {
        push(key, this.eventRowName(eventById[id]), this.eventColor(eventById[id].kind));
      }
    };

    // Auditorías que solapan la semana (fase ejecución o informe)
    td.audits.forEach((a) => {
      const exec = a.audit_start && a.audit_start <= last && a.audit_end >= first;
      const rep = a.report_start && a.report_end &&
        a.report_start <= last && a.report_end >= first;
      if (exec || rep) push(`audit:${a.id}`, a.title, a.color);
    });
    // Reuniones y tareas que caen en la semana
    (td.events || []).forEach((e) =>
      push(`event:${e.id}`, this.eventRowName(e), this.eventColor(e.kind)));
    // Filas con horas imputadas esta semana (incluye categorías con horas)
    td.entries.forEach((e) => {
      const key = e.audit_id ? `audit:${e.audit_id}`
        : e.event_id ? `event:${e.event_id}` : `cat:${e.category_id}`;
      pushKey(key);
    });
    // Filas añadidas a mano en esta semana (las categorías solo salen si se seleccionan)
    (this.state.extraRows[td.start] || []).forEach((key) => pushKey(key));
    return { rows, catById, auditById, eventById };
  },

  entryCol(kind) {
    return kind === 'audit' ? 'audit_id' : kind === 'event' ? 'event_id' : 'category_id';
  },

  cellValue(key, day) {
    const [kind, id] = key.split(':');
    const col = this.entryCol(kind);
    const e = this.state.timeData.entries.find((x) =>
      x.day === day && x[col] === Number(id));
    return e || null;
  },

  setLocalEntry(key, day, hours, note) {
    const [kind, id] = key.split(':');
    const col = this.entryCol(kind);
    const list = this.state.timeData.entries;
    const idx = list.findIndex((x) => x.day === day && x[col] === Number(id));
    if (hours > 0) {
      const rec = { day, hours, note: note || null,
        audit_id: null, category_id: null, event_id: null };
      rec[col] = Number(id);
      if (idx >= 0) list[idx] = rec; else list.push(rec);
    } else if (idx >= 0) {
      list.splice(idx, 1);
    }
  },

  renderHours() {
    const box = this.$('hours-view');
    box.innerHTML = '';
    const td = this.state.timeData;
    if (!td) return;
    const { rows, catById, auditById } = this.hoursRows();
    const days = td.days;
    const todayStr = Cal.fmt(new Date());

    // Barra de herramientas
    const toolbar = document.createElement('div');
    toolbar.className = 'hours-toolbar';

    const addSel = document.createElement('select');
    addSel.className = 'hours-addrow';
    addSel.innerHTML = `<option value="">${I18N.t('hours.add_row')}</option>`;
    const shown = new Set(rows.map((r) => r.key));
    td.audits.forEach((a) => {
      if (!shown.has(`audit:${a.id}`)) {
        const o = document.createElement('option');
        o.value = `audit:${a.id}`;
        o.textContent = a.title;
        addSel.appendChild(o);
      }
    });
    td.categories.forEach((c) => {
      if (!shown.has(`cat:${c.id}`)) {
        const o = document.createElement('option');
        o.value = `cat:${c.id}`;
        o.textContent = c.name;
        addSel.appendChild(o);
      }
    });
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = I18N.t('hours.new_cat');
    addSel.appendChild(newOpt);
    addSel.addEventListener('change', async () => {
      const v = addSel.value;
      if (!v) return;
      if (v === '__new__') {
        const name = (prompt(I18N.t('hours.new_cat_prompt')) || '').trim();
        addSel.value = '';
        if (!name) return;
        try {
          const cat = await API.post('/api/time/categories', { name, color: '#8b949e' });
          // Añadirla como fila de esta semana (las categorías ya no salen solas)
          (this.state.extraRows[td.start] ||= []).push(`cat:${cat.id}`);
          await this.loadHours();
        } catch (err) {
          this.toast(`${I18N.t('toast.error')}: ${err.message}`, true);
        }
        return;
      }
      (this.state.extraRows[td.start] ||= []).push(v);
      this.renderHours();
    });
    toolbar.appendChild(addSel);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn';
    copyBtn.textContent = I18N.t('hours.copy');
    copyBtn.addEventListener('click', () => this.copyHoursSummary(rows));
    toolbar.appendChild(copyBtn);

    const total = document.createElement('span');
    total.className = 'hours-weektotal';
    total.id = 'hours-weektotal';
    toolbar.appendChild(total);
    box.appendChild(toolbar);

    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-hint';
      empty.textContent = I18N.t('hours.empty');
      box.appendChild(empty);
      return;
    }

    // Tabla
    const wrap = document.createElement('div');
    wrap.className = 'hours-wrap';
    const table = document.createElement('table');
    table.className = 'hours-grid';
    const loc = I18N.lang === 'es' ? 'es-ES' : 'en-GB';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    htr.innerHTML = `<th class="task-col">${I18N.t('hours.task')}</th>`;
    days.forEach((ds) => {
      const d = Cal.parse(ds);
      const th = document.createElement('th');
      th.className = 'day-col';
      if (ds === todayStr) th.classList.add('today');
      if (d.getDay() === 0 || d.getDay() === 6) th.classList.add('weekend');
      th.innerHTML = `<span class="dow">${d.toLocaleDateString(loc, { weekday: 'short' })}</span>` +
        `<span class="dnum">${d.getDate()}</span>`;
      htr.appendChild(th);
    });
    const thTot = document.createElement('th');
    thTot.className = 'sum-col';
    thTot.textContent = 'Σ';
    htr.appendChild(thTot);
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.className = 'task-col';
      th.innerHTML = `<span class="row-swatch"></span><span class="row-name"></span>`;
      th.querySelector('.row-swatch').style.background = row.color || '#8b949e';
      th.querySelector('.row-name').textContent = row.name;
      tr.appendChild(th);

      days.forEach((ds) => {
        const td2 = document.createElement('td');
        td2.className = 'cell';
        if (ds === todayStr) td2.classList.add('today');
        const cur = this.cellValue(row.key, ds);
        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.className = 'cell-input';
        input.dataset.key = row.key;
        input.dataset.day = ds;
        input.value = cur ? this.fmtHours(cur.hours) : '';
        if (cur && cur.note) { input.title = cur.note; td2.classList.add('has-note'); }
        input.addEventListener('change', () => this.saveCell(input));
        input.addEventListener('focus', () => input.select());
        td2.appendChild(input);
        tr.appendChild(td2);
      });

      const tot = document.createElement('td');
      tot.className = 'row-sum';
      tot.dataset.key = row.key;
      tr.appendChild(tot);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const tfoot = document.createElement('tfoot');
    const ftr = document.createElement('tr');
    ftr.innerHTML = `<th class="task-col">${I18N.t('hours.day_total')}</th>`;
    days.forEach((ds) => {
      const td3 = document.createElement('td');
      td3.className = 'day-sum';
      td3.dataset.day = ds;
      if (ds === todayStr) td3.classList.add('today');
      ftr.appendChild(td3);
    });
    const grand = document.createElement('td');
    grand.className = 'grand-sum';
    ftr.appendChild(grand);
    tfoot.appendChild(ftr);
    table.appendChild(tfoot);

    wrap.appendChild(table);
    box.appendChild(wrap);
    this.updateHoursTotals();
  },

  parseCell(str) {
    const raw = (str || '').trim().replace(',', '.');
    if (raw === '') return 0;
    const n = parseFloat(raw);
    return isNaN(n) || n < 0 ? 0 : n;
  },

  async saveCell(input) {
    const key = input.dataset.key;
    const day = input.dataset.day;
    const hours = this.parseCell(input.value);
    const [kind, id] = key.split(':');
    const prev = this.cellValue(key, day);
    const body = { day, hours, note: prev ? prev.note : null };
    body[this.entryCol(kind)] = Number(id);
    try {
      await API.put('/api/time/entry', body);
      this.setLocalEntry(key, day, hours, prev ? prev.note : null);
      input.value = hours > 0 ? this.fmtHours(hours) : '';
      this.updateHoursTotals();
    } catch (err) {
      this.toast(`${I18N.t('toast.error')}: ${err.message}`, true);
    }
  },

  updateHoursTotals() {
    const box = this.$('hours-view');
    const days = this.state.timeData.days;
    const dayTotals = {};
    days.forEach((d) => { dayTotals[d] = 0; });
    let grand = 0;

    box.querySelectorAll('tbody tr').forEach((tr) => {
      let rowSum = 0;
      tr.querySelectorAll('.cell-input').forEach((inp) => {
        const v = this.parseCell(inp.value);
        rowSum += v;
        dayTotals[inp.dataset.day] += v;
      });
      grand += rowSum;
      const cell = tr.querySelector('.row-sum');
      cell.textContent = rowSum ? this.fmtHours(rowSum) : '';
    });
    box.querySelectorAll('.day-sum').forEach((td) => {
      const v = dayTotals[td.dataset.day] || 0;
      td.textContent = v ? this.fmtHours(v) : '';
    });
    const grandCell = box.querySelector('.grand-sum');
    if (grandCell) grandCell.textContent = grand ? this.fmtHours(grand) : '';
    const wt = this.$('hours-weektotal');
    if (wt) wt.textContent = `${I18N.t('hours.week_total')}: ${this.fmtHours(grand)} ${I18N.t('unit.hours')}`;
  },

  copyHoursSummary(rows) {
    const lines = [];
    let grand = 0;
    const box = this.$('hours-view');
    rows.forEach((row, i) => {
      const tr = box.querySelectorAll('tbody tr')[i];
      let sum = 0;
      tr.querySelectorAll('.cell-input').forEach((inp) => { sum += this.parseCell(inp.value); });
      if (sum > 0) { lines.push(`${row.name}: ${this.fmtHours(sum)} ${I18N.t('unit.hours')}`); grand += sum; }
    });
    lines.push(`${I18N.t('hours.week_total')}: ${this.fmtHours(grand)} ${I18N.t('unit.hours')}`);
    const text = `${this.weekLabel()}\n${lines.join('\n')}`;
    navigator.clipboard.writeText(text)
      .then(() => this.toast(I18N.t('hours.copied')))
      .catch(() => this.toast(I18N.t('toast.error'), true));
  },

  // ------------------------------------------------------------ sidebar

  mapsUrl(location) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
  },

  shortDay(dateStr) {
    if (!dateStr) return '';
    const loc = I18N.lang === 'es' ? 'es-ES' : 'en-GB';
    return Cal.parse(dateStr).toLocaleDateString(loc,
      { weekday: 'short', day: 'numeric', month: 'short' });
  },

  sideItem(entry, data, showDate = false) {
    const el = document.createElement('div');
    el.className = 'side-item';
    let title = '', sub = '', color = '#8b949e', onclick = null, location = null, dayStr = null;

    if (entry.type === 'event') {
      const ev = entry.ev;
      title = ev.title;
      location = ev.location;
      dayStr = ev.datetime.slice(0, 10);
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
      const isReport = entry.type === 'report-start' || entry.phase === 'report';
      const phase = isReport ? I18N.t('side.reporting') : I18N.t('side.audit_ongoing');
      dayStr = entry.sort ? entry.sort.slice(0, 10)
        : (isReport ? a.report_start : a.audit_start);
      const typeName = I18N.lang === 'es' ? type.name_es : type.name_en;
      sub = `${phase} · ${typeName || ''}${a.location ? ' · ' + a.location : ''}`;
      onclick = () => App.openItemModal('audit', a);
    }

    // En listas sin agrupar por día (p. ej. "Próximo") anteponer el día
    if (showDate && dayStr) {
      const d = this.shortDay(dayStr);
      if (d) sub = `${d} · ${sub}`;
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

    // Próximos 7 días (1 semana): inicios de auditoría/informe y eventos
    const upList = this.$('upcoming-list');
    upList.innerHTML = '';
    const upcoming = [];
    for (let i = 1; i <= 7; i++) {
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
        .forEach((e) => upList.appendChild(this.sideItem(e, this.state.data, true)));
    }

    // Lista de tareas (solo grupo Hoy)
    this.renderTodos('side-todos', 6, true);

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
    this._editingSeries = Boolean(existing && existing.series_id);
    this.$('item-form').reset();
    this.$('item-delete').classList.toggle('hidden', !existing);
    // En edición no se cambia de pestaña
    document.querySelectorAll('#item-tabs .tab').forEach((t) =>
      t.style.display = existing ? (t.dataset.tab === kind ? '' : 'none') : '');
    this.setItemTab(kind);
    this.fillTypeSelect();
    this.fillAuditLinkSelect();
    this.renderTeammateChips(existing && kind === 'audit' ? existing.teammate_ids : []);

    // La recurrencia solo se define al crear (no al editar una ocurrencia)
    document.querySelectorAll('#item-form .only-create').forEach((el) =>
      el.classList.toggle('hidden', Boolean(existing)));
    this.$('item-recur').value = '';
    this.$('item-recur-interval').value = '1';
    this.$('item-recur-until').value = '';
    this.$('item-recur-count').value = '';
    this.syncRecurWhen();

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

  syncRecurWhen() {
    const on = Boolean(this.$('item-recur').value);
    document.querySelectorAll('#item-form .recur-when').forEach((el) =>
      el.classList.toggle('hidden', !on));
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
          const freq = this.$('item-recur').value;
          if (freq) {
            body.recurrence = freq;
            body.rec_interval = Number(this.$('item-recur-interval').value) || 1;
            body.rec_until = this.$('item-recur-until').value || null;
            body.rec_count = this.$('item-recur-count').value
              ? Number(this.$('item-recur-count').value) : null;
          }
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
    if (!this.state.editing) return;
    const { kind, id } = this.state.editing;
    // Evento de una serie: preguntar si borrar solo esta o toda la serie
    const inSeries = (kind === 'meeting' || kind === 'task') &&
      this._editingSeries;
    let path;
    if (kind === 'audit') path = `/api/audits/${id}`;
    else if (kind === 'vacation') path = `/api/vacations/${id}`;
    else path = `/api/events/${id}`;

    if (inSeries) {
      const all = confirm(I18N.t('recur.delete_series_confirm'));
      // Aceptar = toda la serie; Cancelar = solo esta (tras confirmar)
      if (all) {
        path += '?scope=series';
      } else if (!confirm(I18N.t('recur.delete_one_confirm'))) {
        return;
      }
    } else if (!confirm(I18N.t('form.confirm_delete'))) {
      return;
    }
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

  renderTodos(boxId, limit = null, onlyHoy = false) {
    const box = this.$(boxId);
    if (!box) return;
    box.innerHTML = '';
    let items = this.state.todos;
    if (onlyHoy) {
      const hoy = this.hoyGroupId();
      items = items.filter((t) => t.group_id === hoy);
    }
    if (limit) items = items.filter((t) => !t.done).slice(0, limit);
    if (!items.length) {
      box.innerHTML = `<p class="empty-hint">${I18N.t('todos.empty')}</p>`;
      return;
    }
    items.forEach((t) => box.appendChild(this.todoItem(t)));
  },

  async reloadTodos() {
    this.state.todos = await API.get('/api/todos');
    this.renderTodos('side-todos', 6, true);
    if (!this.$('modal-todos').classList.contains('hidden')) {
      this.renderTodos('todos-list');
    }
    if (this.state.view === 'tasks') this.renderTasks();
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
    await this.renderCategoriesPane();
    this.openModal('modal-settings');
  },

  async renderCategoriesPane() {
    const cats = await API.get('/api/time/categories');
    const list = this.$('time-cats-list');
    list.innerHTML = '';
    if (!cats.length) {
      list.innerHTML = `<p class="empty-hint">${I18N.t('todos.empty')}</p>`;
    }
    cats.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'manage-row';
      row.innerHTML = `<span class="swatch"></span><span></span>
        <button class="del"><svg class="icon"><use href="#i-trash"/></svg></button>`;
      row.querySelector('.swatch').style.background = c.color;
      row.querySelector('span:nth-child(2)').textContent = c.name;
      row.querySelector('.del').addEventListener('click', async () => {
        if (!confirm(I18N.t('settings.cat_delete_confirm'))) return;
        await API.del(`/api/time/categories/${c.id}`);
        await this.renderCategoriesPane();
      });
      list.appendChild(row);
    });
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

    window.addEventListener('session-expired', () => {
      this.stopReminderPolling();
      this.showAuth(false);
    });
    window.addEventListener('lang-changed', () => {
      if (!this.$('screen-app').classList.contains('hidden')) {
        API.put('/api/settings', { lang: I18N.lang }).catch(() => {});
        this.render();
      }
    });

    // Navegación
    this.$('nav-prev').addEventListener('click', () => this.navigate(-1));
    this.$('nav-next').addEventListener('click', () => this.navigate(1));
    this.$('nav-today').addEventListener('click', () => {
      this.state.cursor = new Date();
      this.state.weekCursor = new Date();
      if (this.state.view === 'hours') this.loadHours();
      else this.refresh();
    });
    this.$('view-month').addEventListener('click', () => {
      this.state.view = 'month';
      this.render();
    });
    this.$('view-agenda').addEventListener('click', () => {
      this.state.view = 'agenda';
      this.render();
    });
    this.$('view-tasks').addEventListener('click', () => {
      this.state.view = 'tasks';
      this.render();
    });
    this.$('view-hours').addEventListener('click', () => this.loadHours());
    this.$('btn-logout').addEventListener('click', async () => {
      this.stopReminderPolling();
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
    this.$('item-recur').addEventListener('change', () => this.syncRecurWhen());

    // Recurrencia de tareas
    this.$('tr-freq').addEventListener('change', () => {
      const on = Boolean(this.$('tr-freq').value);
      document.querySelectorAll('#todo-recur-form .tr-when').forEach((el) =>
        el.classList.toggle('hidden', !on));
    });
    this.$('todo-recur-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveTodoRecurrence();
    });

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

    this.$('time-cat-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await API.post('/api/time/categories', {
        name: this.$('time-cat-name').value,
        color: this.$('time-cat-color').value,
      });
      this.$('time-cat-name').value = '';
      await this.renderCategoriesPane();
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
