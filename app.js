'use strict';

// A setup address must not stay visible or end up in the history, so this runs before anything else.
function takeSetupAddress() {
  const setup = WatchListLogic.parseSetupFragment(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  return setup;
}
const setupFromAddress = takeSetupAddress();

(function () {
  const L = WatchListLogic;
  const KEYS = { token: 'watchlist.token', repo: 'watchlist.repo', list: 'watchlist.list', sent: 'watchlist.sent', results: 'watchlist.results' };
  const REFRESH_MS = 30000;
  const $ = (id) => document.getElementById(id);

  function loadJson(key, fallback) {
    try {
      const text = localStorage.getItem(key);
      return text === null ? fallback : JSON.parse(text);
    } catch (error) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  const state = {
    token: localStorage.getItem(KEYS.token),
    repo: localStorage.getItem(KEYS.repo) || L.DEFAULT_REPOSITORY,
    list: loadJson(KEYS.list, []),
    sent: loadJson(KEYS.sent, []),
    results: loadJson(KEYS.results, {}),
    syncing: false,
    again: false,
    problem: null,
    checkedAt: null,
  };

  function useSetup(setup) {
    state.token = setup.token;
    localStorage.setItem(KEYS.token, state.token);
    if (setup.repo) {
      state.repo = setup.repo;
      localStorage.setItem(KEYS.repo, state.repo);
    }
  }

  if (setupFromAddress) useSetup(setupFromAddress);

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function persistList() {
    saveJson(KEYS.list, state.list);
  }

  function showScreen() {
    const ready = Boolean(state.token);
    $('setup').hidden = ready;
    $('list-screen').hidden = !ready;
    if (!ready) {
      $('setup-repo').value = state.repo;
      $('setup-cancel').hidden = true;
    }
  }

  function render() {
    const connection = $('connection');
    connection.className = state.problem ? 'message problem' : 'message';
    connection.textContent = state.problem || (state.checkedAt ? `Checked ${new Date(state.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '');

    // Redrawn only when something changed, so a refresh cannot close what the viewer has open.
    const signature = JSON.stringify([state.list, state.sent, state.results]);
    if (signature === state.drawn) return;
    state.drawn = signature;
    const rows = L.visibleRequests(state.list);
    $('empty').hidden = rows.length > 0;
    const items = $('items');
    items.textContent = '';
    for (const request of rows) items.appendChild(renderItem(request));
  }

  function renderItem(request) {
    const known = state.sent.some((row) => row.id === request.id);
    const view = L.itemView(request, state.results[request.id], !known);
    const item = element('li', 'item');
    item.appendChild(element('div', 'item-name', request.name));
    if (view.official && view.official.title !== request.name) {
      item.appendChild(element('div', 'item-official', [view.official.title, view.official.year].filter(Boolean).join(' · ')));
    }
    item.appendChild(element('div', 'item-status', view.status));

    if (view.sites.length > 0) {
      const chips = element('ul', 'chips');
      for (const site of view.sites) {
        const chip = element('li', `chip chip-${site.state}`);
        chip.appendChild(element('span', 'chip-mark', site.mark));
        const label = element('span');
        label.appendChild(document.createTextNode(site.name));
        label.appendChild(element('span', 'chip-note', site.word));
        chip.appendChild(label);
        chips.appendChild(chip);
      }
      item.appendChild(chips);
    }

    addChoices(item, request, view.whichShow, 'Which one?');
    addChoices(item, request, view.picks, 'Is it one of these?');
    if (view.extras.length > 0) {
      const more = element('details');
      more.appendChild(element('summary', null, 'Other possible matches'));
      addChoices(more, request, view.extras, null);
      item.appendChild(more);
    }

    const remove = element('button', 'remove', 'Remove from this list');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      if (!window.confirm('Remove from this list? Anything already added stays in Favorites on the projector.')) return;
      state.list = L.removeRequest(state.list, request.id, Date.now());
      persistList();
      render();
      sync();
    });
    item.appendChild(remove);
    return item;
  }

  function addChoices(parent, request, choices, heading) {
    if (choices.length === 0) return;
    if (heading) parent.appendChild(element('div', 'choice-title', heading));
    for (const candidate of choices) {
      const button = element('button', 'choice');
      button.type = 'button';
      button.appendChild(document.createTextNode(candidate.title));
      button.appendChild(element('small', null, L.describe(candidate)));
      button.addEventListener('click', () => {
        state.list = L.choose(state.list, request.id, candidate.id);
        persistList();
        render();
        sync();
      });
      parent.appendChild(button);
    }
  }

  function addName() {
    const input = $('name');
    const name = input.value.trim();
    if (!name) return;
    if (L.alreadyListed(L.visibleRequests(state.list), name)) {
      state.problem = 'This name is already on the list.';
      render();
      return;
    }
    const random = (count) => crypto.getRandomValues(new Uint8Array(count));
    state.list = [...state.list, L.newRequest(name, Date.now(), random)];
    state.problem = null;
    persistList();
    input.value = '';
    render();
    sync();
  }

  /** One at a time. Anything asked for meanwhile runs right after. */
  async function sync() {
    if (!state.token) return;
    if (state.syncing) {
      state.again = true;
      return;
    }
    state.syncing = true;
    try {
      const remote = L.gitHub(fetch.bind(window), state.repo, state.token);
      const synced = await L.syncRequests(remote, state.list, Date.now());
      if (!synced.ok) {
        state.problem = L.problemWords(synced.reason);
      } else {
        state.list = synced.list;
        state.sent = synced.list;
        persistList();
        saveJson(KEYS.sent, state.sent);
        const read = await remote.read(L.RESULTS_FILE);
        if (read.failed) {
          state.problem = L.problemWords(read.failed);
        } else {
          state.problem = null;
          state.checkedAt = Date.now();
          if (read.missing) {
            state.results = {};
          } else {
            try {
              state.results = L.decodeResults(read.text);
            } catch (error) {
              state.problem = L.problemWords('damaged');
            }
          }
          saveJson(KEYS.results, state.results);
        }
      }
    } finally {
      state.syncing = false;
      render();
    }
    if (state.again) {
      state.again = false;
      sync();
    }
  }

  async function connect() {
    const message = $('setup-message');
    const typed = $('setup-token').value.trim();
    const repo = $('setup-repo').value.trim() || L.DEFAULT_REPOSITORY;
    const token = typed || state.token;
    if (!token || !L.validToken(token)) {
      message.textContent = 'That does not look like an access key.';
      return;
    }
    if (!L.validRepository(repo)) {
      message.textContent = 'The list should look like owner/name.';
      return;
    }
    message.textContent = 'Checking…';
    const checked = await L.gitHub(fetch.bind(window), repo, token).check();
    if (checked.failed) {
      message.textContent = L.problemWords(checked.failed);
      return;
    }
    state.token = token;
    state.repo = repo;
    localStorage.setItem(KEYS.token, token);
    localStorage.setItem(KEYS.repo, repo);
    $('setup-token').value = '';
    message.textContent = '';
    showScreen();
    render();
    sync();
  }

  function openSettings() {
    $('setup').hidden = false;
    $('list-screen').hidden = true;
    $('setup-repo').value = state.repo;
    $('setup-token').value = '';
    $('setup-token').placeholder = 'Leave empty to keep the current key';
    $('setup-message').textContent = '';
    $('setup-cancel').hidden = false;
  }

  $('add').addEventListener('click', addName);
  $('name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addName();
  });
  $('setup-save').addEventListener('click', connect);
  $('setup-cancel').addEventListener('click', showScreen);
  $('settings').addEventListener('click', openSettings);
  window.addEventListener('online', sync);
  // Opening a setup address while the page is already open does not reload it.
  window.addEventListener('hashchange', () => {
    const setup = takeSetupAddress();
    if (!setup) return;
    useSetup(setup);
    showScreen();
    render();
    sync();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
  });
  setInterval(() => {
    if (!document.hidden) sync();
  }, REFRESH_MS);

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');

  showScreen();
  render();
  sync();
})();
