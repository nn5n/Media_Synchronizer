// Everything that decides something, with no screen and no network, so it can be tested without a phone.
(function (root) {
  'use strict';

  const DEFAULT_REPOSITORY = 'nn5n/Private_Synchronizer';
  const REQUESTS_FILE = 'requests.json';
  const RESULTS_FILE = 'results.json';
  const MAX_NAME = 200;
  /** A removed line must be remembered long enough for the projector to see it. */
  const KEEP_REMOVED_MS = 90 * 24 * 3600 * 1000;
  const MAX_WRITE_TRIES = 4;

  function validToken(text) {
    return /^[A-Za-z0-9_]{20,255}$/.test(text);
  }

  function validRepository(text) {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text);
  }

  /** Reads a setup address such as #token=...&repo=owner/name. Null when it holds no usable key. */
  function parseSetupFragment(hash) {
    const text = String(hash || '').replace(/^#/, '');
    if (!text) return null;
    const params = new URLSearchParams(text);
    const token = params.get('token');
    if (!token || !validToken(token)) return null;
    const repo = params.get('repo');
    return { token, repo: repo && validRepository(repo) ? repo : null };
  }

  function newId(random) {
    let id = 'r-';
    const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (const value of random(16)) id += letters[value % letters.length];
    return id;
  }

  function newRequest(name, now, random) {
    return { id: newId(random), name: String(name).trim().slice(0, MAX_NAME), addedAt: now, chosen: [], removedAt: null };
  }

  function sameName(a, b) {
    return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
  }

  /** True when a line with this name is already on the list, so the same show is not asked for twice. */
  function alreadyListed(requests, name) {
    return requests.some((request) => !request.removedAt && sameName(request.name, name));
  }

  /** Two phones, or a phone and an older copy of itself, can both have changed the list. Nothing added or chosen is ever lost. */
  function mergeRequests(remote, local, now) {
    const byId = new Map();
    for (const request of [...remote, ...local]) {
      const known = byId.get(request.id);
      if (!known) {
        byId.set(request.id, { ...request, chosen: [...(request.chosen || [])], removedAt: request.removedAt || null });
        continue;
      }
      known.chosen = [...new Set([...known.chosen, ...(request.chosen || [])])];
      known.removedAt = known.removedAt || request.removedAt || null;
    }
    return [...byId.values()]
      .filter((request) => !request.removedAt || now - request.removedAt < KEEP_REMOVED_MS)
      .sort((a, b) => a.addedAt - b.addedAt);
  }

  function sameRequests(a, b) {
    return encodeRequests(a) === encodeRequests(b);
  }

  function encodeRequests(requests) {
    const rows = requests.map((r) => ({ id: r.id, name: r.name, addedAt: r.addedAt, chosen: r.chosen || [], removedAt: r.removedAt || null }));
    return JSON.stringify({ version: 1, requests: rows }, null, 1);
  }

  /** Throws on a damaged file, which must not be read as an empty list and then written back over it. */
  function decodeRequests(text) {
    const rows = JSON.parse(text).requests;
    if (!Array.isArray(rows)) throw new Error('damaged list');
    return rows.filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string');
  }

  function decodeResults(text) {
    const rows = JSON.parse(text).results;
    if (!Array.isArray(rows)) throw new Error('damaged results');
    const byId = {};
    for (const row of rows) if (row && typeof row.id === 'string') byId[row.id] = row;
    return byId;
  }

  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function fromBase64(content) {
    const binary = atob(String(content).replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  }

  const SITE_WORDS = {
    found: { mark: '✓', word: 'Added' },
    not_found: { mark: '–', word: 'Not found' },
    down: { mark: '!', word: 'Site down, will try again' },
    unsure: { mark: '?', word: 'Not sure, your pick' },
    hidden: { mark: '–', word: 'Made in Russia, left out' },
  };

  /** What one line of the list should say right now. */
  function itemView(request, result, pending) {
    if (!result) {
      return {
        status: pending ? 'Saved on this phone, will send when online' : 'Waiting for the projector',
        official: null,
        sites: [],
        whichShow: [],
        picks: [],
        extras: [],
      };
    }
    const sites = (result.sites || []).map((site) => {
      const words = SITE_WORDS[site.state] || { mark: '?', word: site.state };
      const lookupOnly = site.state === 'down' && result.lookupDown;
      return {
        id: site.id,
        name: site.name || site.id,
        state: site.state,
        mark: words.mark,
        word: lookupOnly ? 'Will try again' : words.word,
        titles: site.titles || [],
      };
    });
    const chosen = new Set(request.chosen || []);
    const offered = (site) => (site.candidates || []).filter((c) => !chosen.has(c.id)).map((c) => ({ ...c, siteName: site.name || site.id }));
    const picks = (result.sites || []).filter((site) => site.state === 'unsure').flatMap(offered);
    const extras = (result.sites || []).filter((site) => site.state !== 'unsure').flatMap(offered);
    const whichShow = (result.candidates || []).filter((c) => !chosen.has(c.id));
    const applied = new Set(result.applied || []);
    const pickPending = [...chosen].some((id) => !applied.has(id));
    return {
      status: statusWords(result, sites, whichShow, picks, pickPending),
      official: result.title ? { title: result.title, year: result.year || null, type: result.type || null } : null,
      sites,
      whichShow,
      picks,
      extras,
    };
  }

  function statusWords(result, sites, whichShow, picks, pickPending) {
    if (pickPending) return 'Your choice is on its way to the projector';
    if (result.status === 'searching') return 'Searching on the projector…';
    if (whichShow.length > 0) return 'Which one do you mean?';
    if (result.status === 'needs_choice' || picks.length > 0) {
      return sites.some((site) => site.state === 'found') ? 'Added. One more site needs your pick' : 'Not sure yet. Please pick the right one';
    }
    if (result.status === 'retry') {
      return result.lookupDown ? 'Name lookup is down, will try again' : 'Some sites are down, will try again';
    }
    const added = sites.filter((site) => site.state === 'found').length;
    if (added === 0) return 'Not found on any site';
    return added === 1 ? 'Added to Favorites from 1 site' : `Added to Favorites from ${added} sites`;
  }

  function describe(candidate) {
    const type = candidate.type === 'movie' ? 'Movie' : candidate.type === 'series' ? 'Series' : null;
    return [candidate.siteName, type, candidate.year].filter(Boolean).join(' · ');
  }

  /**
   * Sends what this phone has and takes in what is new. On success the merged list is the new truth. On any failure
   * nothing is lost, because the phone keeps its own copy and tries again later.
   */
  async function syncRequests(remote, local, now) {
    let attempts = 0;
    let merged = local;
    while (attempts < MAX_WRITE_TRIES) {
      attempts += 1;
      const read = await remote.read(REQUESTS_FILE);
      if (read.failed) return { ok: false, reason: read.failed, list: local };
      let current;
      try {
        current = read.missing ? [] : decodeRequests(read.text);
      } catch (error) {
        return { ok: false, reason: 'damaged', list: local };
      }
      merged = mergeRequests(current, local, now);
      if (!read.missing && sameRequests(current, merged)) return { ok: true, list: merged };
      if (read.missing && merged.length === 0) return { ok: true, list: merged };
      const written = await remote.write(REQUESTS_FILE, encodeRequests(merged), read.missing ? null : read.sha);
      if (written.saved) return { ok: true, list: merged };
      if (!written.conflict) return { ok: false, reason: written.failed, list: local };
    }
    return { ok: false, reason: 'busy', list: local };
  }

  /** What is shown, newest first. Removed lines are only kept so the projector can see the removal. */
  function visibleRequests(requests) {
    return requests.filter((request) => !request.removedAt).sort((a, b) => b.addedAt - a.addedAt);
  }

  function removeRequest(requests, id, now) {
    return requests.map((request) => (request.id === id ? { ...request, removedAt: now } : request));
  }

  function choose(requests, id, choice) {
    return requests.map((request) => (request.id === id ? { ...request, chosen: [...new Set([...(request.chosen || []), choice])] } : request));
  }

  function problemWords(reason) {
    if (reason === 401) return 'The access key was refused. Replace it in Settings.';
    if (reason === 403) return 'The access key cannot change this list, or GitHub is limiting requests. Check Settings.';
    if (reason === 404) return 'This list cannot be found with this access key. Check Settings.';
    if (reason === 'damaged') return 'The list on GitHub looks damaged. Nothing was changed.';
    if (reason === 'offline') return 'No internet. Everything is saved on this phone.';
    return 'Could not reach GitHub. Everything is saved on this phone.';
  }

  /** The two files through GitHub's API. Answers are never stored by the browser, and an error is only ever a status number. */
  function gitHub(fetchFn, repository, token) {
    const root = `https://api.github.com/repos/${repository}`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    return {
      async check() {
        try {
          const response = await fetchFn(root, { headers, cache: 'no-store' });
          return response.ok ? { ok: true } : { failed: response.status };
        } catch (error) {
          return { failed: 'offline' };
        }
      },
      async read(path) {
        let response;
        try {
          response = await fetchFn(`${root}/contents/${path}`, { headers, cache: 'no-store' });
        } catch (error) {
          return { failed: 'offline' };
        }
        if (response.status === 404) return { missing: true };
        if (!response.ok) return { failed: response.status };
        try {
          const body = await response.json();
          return { text: fromBase64(body.content), sha: body.sha };
        } catch (error) {
          return { failed: 'damaged' };
        }
      },
      async write(path, text, sha) {
        const body = { message: 'Update list', content: toBase64(text) };
        if (sha) body.sha = sha;
        let response;
        try {
          response = await fetchFn(`${root}/contents/${path}`, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify(body),
          });
        } catch (error) {
          return { failed: 'offline' };
        }
        if (response.ok) return { saved: true };
        if (response.status === 409 || response.status === 422) return { conflict: true };
        return { failed: response.status };
      },
    };
  }

  const api = {
    DEFAULT_REPOSITORY, REQUESTS_FILE, RESULTS_FILE, MAX_NAME,
    validToken, validRepository, parseSetupFragment, newRequest, alreadyListed, mergeRequests, encodeRequests, decodeRequests, decodeResults,
    toBase64, fromBase64, itemView, describe, syncRequests, visibleRequests, removeRequest, choose, problemWords, gitHub,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WatchListLogic = api;
})(typeof self !== 'undefined' ? self : this);
