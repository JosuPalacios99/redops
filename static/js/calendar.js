/* Render del calendario mensual y de la vista agenda. Sin dependencias. */
const Cal = {
  fmt(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  parse(s) {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
  },

  /* Lunes de la semana que contiene `d`. */
  weekStart(d) {
    const s = new Date(d);
    s.setHours(0, 0, 0, 0);
    s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
    return s;
  },

  /* Rango visible de un mes (lunes a domingo, 6 semanas). */
  monthRange(year, month) {
    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    const end = new Date(start);
    end.setDate(start.getDate() + 41);
    return { start, end };
  },

  /* Fases de una auditoría que tocan un día concreto. */
  phasesAt(audit, dateStr) {
    const phases = [];
    if (audit.audit_start && dateStr >= audit.audit_start && dateStr <= audit.audit_end) {
      phases.push('audit');
    }
    if (audit.report_start && audit.report_end &&
        dateStr >= audit.report_start && dateStr <= audit.report_end) {
      phases.push('report');
    }
    return phases;
  },

  renderMonth(container, year, month, data, handlers) {
    const { start } = this.monthRange(year, month);
    const todayStr = this.fmt(new Date());
    const grid = document.createElement('div');
    grid.className = 'cal-grid';

    I18N.weekdays().forEach((wd) => {
      const el = document.createElement('div');
      el.className = 'cal-dow';
      el.textContent = wd;
      grid.appendChild(el);
    });

    for (let i = 0; i < 42; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const dateStr = this.fmt(day);

      const cell = document.createElement('div');
      cell.className = 'cal-cell';
      if (day.getDay() === 0 || day.getDay() === 6) cell.classList.add('weekend');
      if (day.getMonth() !== month) cell.classList.add('other-month');
      if (dateStr === todayStr) cell.classList.add('today');
      cell.addEventListener('click', () => handlers.onDayClick(dateStr));

      const num = document.createElement('span');
      num.className = 'cal-daynum';
      num.textContent = day.getDate();
      cell.appendChild(num);

      const items = document.createElement('div');
      items.className = 'cal-items';

      const dayItems = [];
      data.audits.forEach((a) => {
        this.phasesAt(a, dateStr).forEach((phase) => dayItems.push({ kind: 'audit', phase, a }));
      });
      (data.vacations || []).forEach((v) => {
        if (dateStr >= v.start_date && dateStr <= v.end_date) {
          dayItems.push({ kind: 'vacation', v });
        }
      });
      data.events.forEach((ev) => {
        if (ev.datetime.slice(0, 10) === dateStr) dayItems.push({ kind: 'event', ev });
      });

      const MAX = 4;
      dayItems.slice(0, MAX).forEach((it) => {
        if (it.kind === 'audit') {
          items.appendChild(this.auditBar(it.a, it.phase, dateStr, data.types, handlers));
        } else if (it.kind === 'vacation') {
          items.appendChild(this.vacationBar(it.v, dateStr, handlers));
        } else {
          items.appendChild(this.eventChip(it.ev, handlers));
        }
      });
      if (dayItems.length > MAX) {
        const more = document.createElement('div');
        more.className = 'cal-more';
        more.textContent = `+${dayItems.length - MAX} ${I18N.t('cal.more')}`;
        items.appendChild(more);
      }

      // Tareas del grupo Hoy: solo en la celda de hoy
      if (dateStr === todayStr && (data.todayTasks || []).length) {
        data.todayTasks.forEach((t) => items.appendChild(this.taskChip(t, handlers)));
      }

      cell.appendChild(items);
      grid.appendChild(cell);
    }

    container.innerHTML = '';
    container.appendChild(grid);
  },

  auditBar(audit, phase, dateStr, types, handlers) {
    const bar = document.createElement('div');
    const color = (types[audit.type_id] || {}).color || '#8b949e';
    const rangeStart = phase === 'audit' ? audit.audit_start : audit.report_start;
    const isStart = dateStr === rangeStart;
    const isMonday = this.parse(dateStr).getDay() === 1;

    bar.className = `cal-bar ${phase === 'report' ? 'report' : ''} ${isStart ? 'bar-start' : 'bar-cont'}`;
    bar.style.background = phase === 'audit' ? color : '';
    if (phase === 'report') bar.style.backgroundColor = color + '55';
    bar.textContent = (isStart || isMonday)
      ? (phase === 'report' ? `${audit.title} ${I18N.t('cal.report_suffix')}` : audit.title)
      : ' ';
    bar.title = audit.title;
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onAuditClick(audit);
    });
    return bar;
  },

  vacationBar(vac, dateStr, handlers) {
    const bar = document.createElement('div');
    const isStart = dateStr === vac.start_date;
    const isMonday = this.parse(dateStr).getDay() === 1;
    bar.className = `cal-bar ${isStart ? 'bar-start' : 'bar-cont'}`;
    bar.style.background = 'var(--vacation)';
    bar.textContent = (isStart || isMonday) ? `🏖 ${vac.title}` : ' ';
    bar.title = vac.title;
    bar.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onVacationClick(vac);
    });
    return bar;
  },

  taskChip(t, handlers) {
    const chip = document.createElement('div');
    chip.className = 'cal-chip task-chip';
    chip.innerHTML = `<span class="tc-box"><svg class="icon"><use href="#i-check"/></svg></span><span class="tc-text"></span>`;
    chip.querySelector('.tc-text').textContent = t.content;
    chip.title = t.content;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (handlers.onTaskToggle) handlers.onTaskToggle(t);
    });
    return chip;
  },

  eventChip(ev, handlers) {
    const chip = document.createElement('div');
    chip.className = `cal-chip ${ev.kind} ${ev.done ? 'done' : ''}`;
    const time = ev.datetime.includes('T') ? ev.datetime.slice(11, 16) + ' ' : '';
    const rep = ev.series_id ? '🔁 ' : '';
    chip.textContent = `${rep}${time}${ev.title}`;
    chip.title = chip.textContent;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onEventClick(ev);
    });
    return chip;
  },

  /* Vista agenda: lista cronológica de los próximos `days` días. */
  renderAgenda(container, data, handlers, days = 30) {
    container.innerHTML = '';
    const today = new Date();
    const todayStr = this.fmt(today);
    let shown = 0;

    for (let i = 0; i < days; i++) {
      const day = new Date(today);
      day.setDate(today.getDate() + i);
      const dateStr = this.fmt(day);

      const entries = [];
      data.audits.forEach((a) => {
        if (a.audit_start === dateStr) entries.push({ type: 'audit-start', a });
        if (a.report_start === dateStr) entries.push({ type: 'report-start', a });
      });
      (data.vacations || []).forEach((v) => {
        if (v.start_date === dateStr) entries.push({ type: 'vacation', v });
      });
      data.events.forEach((ev) => {
        if (ev.datetime.slice(0, 10) === dateStr) entries.push({ type: 'event', ev });
      });
      if (!entries.length) continue;
      shown++;

      const section = document.createElement('div');
      section.className = 'agenda-day' + (dateStr === todayStr ? ' today' : '');
      const h = document.createElement('h3');
      h.textContent = I18N.dayLabel(day);
      section.appendChild(h);

      const list = document.createElement('div');
      list.className = 'side-list';
      entries.forEach((entry) => list.appendChild(App.sideItem(entry, data)));
      section.appendChild(list);
      container.appendChild(section);
    }

    if (!shown) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `<svg class="icon"><use href="#i-calendar"/></svg><p></p>`;
      empty.querySelector('p').textContent = I18N.t('agenda.empty');
      container.appendChild(empty);
    }
  },
};
