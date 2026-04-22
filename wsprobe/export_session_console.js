// Paste into DevTools Console on https://my.wealthsimple.com (logged in).
(function () {
  function bundleFromObject(obj, depth) {
    if (depth > 8 || !obj || typeof obj !== "object") return null;
    if (typeof obj.access_token === "string" && obj.access_token.length > 20) {
      const out = { access_token: obj.access_token };
      if (typeof obj.refresh_token === "string") out.refresh_token = obj.refresh_token;
      if (typeof obj.client_id === "string") out.client_id = obj.client_id;
      return out;
    }
    if (Array.isArray(obj)) {
      for (const x of obj) {
        const b = bundleFromObject(x, depth + 1);
        if (b) return b;
      }
      return null;
    }
    for (const k of Object.keys(obj)) {
      try {
        const b = bundleFromObject(obj[k], depth + 1);
        if (b) return b;
      } catch (_) {}
    }
    return null;
  }

  function tryStorage() {
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k) continue;
        const v = store.getItem(k);
        if (!v || v.length > 2e6) continue;
        try {
          const b = bundleFromObject(JSON.parse(v), 0);
          if (b) return b;
        } catch (_) {}
        try {
          const b = bundleFromObject(JSON.parse(decodeURIComponent(v)), 0);
          if (b) return b;
        } catch (_) {}
      }
    }
    return null;
  }

  function tryNextData() {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el || !el.textContent) return null;
    try {
      return bundleFromObject(JSON.parse(el.textContent), 0);
    } catch (_) {
      return null;
    }
  }

  function tryWindowGlobals() {
    const direct = [window.__NEXT_DATA__, window.__APOLLO_STATE__, window.__NUXT__];
    for (const candidate of direct) {
      try {
        const b = bundleFromObject(candidate, 0);
        if (b) return b;
      } catch (_) {}
    }
    const keys = Object.keys(window).filter((k) =>
      /oauth|apollo|relay|auth|token|session|store/i.test(k),
    );
    for (const k of keys) {
      try {
        const b = bundleFromObject(window[k], 0);
        if (b) return b;
      } catch (_) {}
    }
    return null;
  }

  const bundle = tryStorage() || tryNextData() || tryWindowGlobals();
  if (!bundle) {
    console.error(
      "Could not locate access_token in page state. Open a logged-in my.wealthsimple.com tab and try again.",
    );
    return;
  }

  const out = JSON.stringify(bundle, null, 2);
  console.log(out);
  if (typeof copy === "function") {
    copy(out);
    console.info("Copied JSON to clipboard. Paste into the waiting wsprobe terminal.");
  } else {
    console.info("Copy the JSON above, then paste it into the waiting wsprobe terminal.");
  }
})();
