/* i18n: carga es/en y aplica traducciones a los nodos con data-i18n. */
const I18N = {
  lang: localStorage.getItem('agenda_lang') || 'es',
  dict: {},

  async load(lang) {
    const res = await fetch(`/static/i18n/${lang}.json`);
    this.dict = await res.json();
    this.lang = lang;
    localStorage.setItem('agenda_lang', lang);
    document.documentElement.lang = lang;
    this.applyAll();
    document.querySelectorAll('.lang-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.lang === lang));
    window.dispatchEvent(new Event('lang-changed'));
  },

  t(key) {
    return this.dict[key] || key;
  },

  applyAll() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = this.t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = this.t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = this.t(el.dataset.i18nTitle);
    });
  },

  monthLabel(date) {
    return date.toLocaleDateString(this.lang === 'es' ? 'es-ES' : 'en-GB',
      { month: 'long', year: 'numeric' });
  },

  dayLabel(date) {
    return date.toLocaleDateString(this.lang === 'es' ? 'es-ES' : 'en-GB',
      { weekday: 'long', day: 'numeric', month: 'long' });
  },

  weekdays() {
    // Semana empezando en lunes
    const base = new Date(2024, 0, 1); // lunes
    return [...Array(7)].map((_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return d.toLocaleDateString(this.lang === 'es' ? 'es-ES' : 'en-GB', { weekday: 'short' });
    });
  },

  offsetLabel(min) {
    if (min % 10080 === 0 && min >= 10080) return `${min / 10080} ${this.t('unit.weeks')}`;
    if (min % 1440 === 0 && min >= 1440) return `${min / 1440} ${this.t('unit.days')}`;
    if (min % 60 === 0 && min >= 60) return `${min / 60} ${this.t('unit.hours')}`;
    return `${min} ${this.t('unit.minutes')}`;
  },
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.lang-btn');
  if (btn) I18N.load(btn.dataset.lang);
});
