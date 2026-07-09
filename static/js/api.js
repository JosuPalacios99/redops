/* Wrapper mínimo de la API. Todas las llamadas van con la cookie de sesión. */
const API = {
  async request(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (res.status === 401 && !path.startsWith('/api/auth')) {
      window.dispatchEvent(new Event('session-expired'));
      throw new Error('not_authenticated');
    }
    if (!res.ok) {
      let detail = 'error';
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  },
  get: (p) => API.request('GET', p),
  post: (p, b) => API.request('POST', p, b),
  put: (p, b) => API.request('PUT', p, b),
  del: (p) => API.request('DELETE', p),
};
