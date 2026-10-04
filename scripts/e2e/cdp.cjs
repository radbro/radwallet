/**
 * A very small Chrome DevTools Protocol client, for driving the wallet inside
 * Android's WebView.
 *
 * Playwright cannot do this job: `connectOverCDP` opens with
 * `Browser.setDownloadBehavior`, which WebView does not implement, and the
 * connection dies before a single selector runs. Puppeteer would work but is a
 * dependency, and this repo already drives real Firefox over raw WebDriver —
 * a raw client is the house style, not an exception.
 *
 * Node 22 ships a global WebSocket, so this costs nothing to require.
 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  static async attach(port, match = 'localhost') {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const target = list.find((t) => t.type === 'page' && String(t.url).includes(match));
    if (!target) throw new Error(`no page target matching ${match} (saw ${list.length})`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('devtools websocket refused')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 60000);
    });
  }

  /** run an expression in the page and get its value back */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  text(selector = 'body') {
    return this.eval(`return (document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').trim();`);
  }

  count(selector) {
    return this.eval(`return document.querySelectorAll(${JSON.stringify(selector)}).length;`);
  }

  async waitFor(selector, ms = 30000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await this.count(selector)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for ${selector}`);
  }

  async waitForText(needle, ms = 30000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((await this.text()).includes(needle)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out waiting for text ${needle}`);
  }

  click(selector) {
    return this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('no element for ${selector}');
      el.click();
      return true;
    `);
  }

  /** click the first element matching `selector` whose text contains `needle` */
  clickText(needle, selector = 'button, a, label, .tile, .tab, .act') {
    return this.eval(`
      const want = ${JSON.stringify(needle)};
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((e) => (e.innerText || '').includes(want));
      if (!el) throw new Error('no clickable element containing ' + want);
      el.click();
      return true;
    `);
  }

  /**
   * Type into a controlled Preact input.
   *
   * The value has to go through the native setter and then an input event, or
   * the signal never sees it. Callers must not click the submit button in the
   * SAME evaluate — the update is queued, so a click in that turn reads the old
   * state. That trap already cost this repo a day on the Firefox suite; keeping
   * fill() and click() as separate round trips is the fix.
   */
  fill(selector, value) {
    return this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('no input for ${selector}');
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    `);
  }

  close() {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

module.exports = { Cdp };
